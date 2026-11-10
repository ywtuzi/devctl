#!/usr/bin/env node
// devctl —— 多仓工作区项目运行器
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findRoot, loadConfig, statePaths, loadPrefs, savePrefs, togglePrefs } from '../src/config.js'
import { scan, scanDetailed, summarize } from '../src/scan.js'
import { startRun, buildTask, stopRun, listRecords, readLogTail, isAlive, readRecord } from '../src/runner.js'
import { isPortFree } from '../src/ports.js'
import { findFreePort } from '../src/ports.js'
import { listNodeVersions, resolveJava, resolveMaven } from '../src/toolchain.js'
import { c, renderTable, statusIcon, fmtDuration, printWarnings } from '../src/ui.js'
import { sleep, padEnd } from '../src/util.js'

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--follow' || a === '-f') opts.follow = true
    else if (a === '--force') opts.force = true
    else if (a === '--quiet' || a === '-q') opts.quiet = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--root') opts.root = argv[++i]
    else if (a === '--node') opts.node = argv[++i]
    else if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--timeout') opts.timeout = Number(argv[++i])
    else if (a === '--lines') opts.lines = Number(argv[++i])
    else if (a === '--type') opts.type = argv[++i]
    else if (a.startsWith('--root=')) opts.root = a.slice(7)
    else if (a.startsWith('--node=')) opts.node = a.slice(7)
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7))
    else if (a.startsWith('--timeout=')) opts.timeout = Number(a.slice(10))
    else if (a.startsWith('--lines=')) opts.lines = Number(a.slice(8))
    else if (!a.startsWith('-')) opts._.push(a)
  }
  return opts
}

function resolveContext(opts) {
  const root = opts.root ? resolve(opts.root) : findRoot(process.cwd()) || process.cwd()
  const config = loadConfig(root)
  return { root, config }
}

function fail(msg, code = 1) {
  console.error(`${c.red('✗')} ${msg}`)
  process.exit(code)
}

function pickTask(project, kind) {
  const entries = Object.entries(project.tasks || {}).filter(([, t]) => t.kind === kind)
  if (!entries.length) return null
  const preferred = kind === 'run' ? ['dev', 'run'] : ['build']
  for (const name of preferred) {
    const hit = entries.find(([k, t]) => t.name === name || k === name || k.endsWith(`:${name}`))
    if (hit) return hit[0]
  }
  return entries[0][0]
}

function requireProject(projects, id) {
  const p = projects.find((x) => x.id === id)
  if (!p) {
    const similar = projects.filter((x) => x.id.includes(id) || x.id.toLowerCase().includes(id.toLowerCase()))
    const hint = similar.length ? `\n  你是不是要: ${similar.map((s) => s.id).join(', ')}` : ''
    fail(`找不到项目 "${id}"${hint}\n  用 ${c.bold('devctl list')} 查看全部项目`)
  }
  return p
}

/* ------------------------------ 命令实现 ------------------------------ */

async function cmdList(opts, ctx) {
  const { projects, excluded } = scanDetailed(ctx.root, ctx.config)
  const filtered = projects.filter((p) => {
    if (opts.type === 'maven') return p.kind === 'maven' || p.kind === 'mixed'
    if (opts.type === 'node') return p.kind === 'node' || p.kind === 'mixed'
    return true
  })

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          root: ctx.root,
          summary: summarize(projects),
          projects: filtered.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            packageName: p.packageName || null,
            kind: p.kind,
            type: p.type,
            runnable: p.runnable,
            node: p.node,
            basePort: p.basePort,
            tasks: Object.entries(p.tasks).map(([k, t]) => ({
              name: k,
              kind: t.kind,
              label: t.label || null,
              platform: t.platform || null,
              action: t.action || null,
              detail: t.detail || null,
            })),
            warnings: p.warnings,
          })),
          excluded,
        },
        null,
        2
      )
    )
    return
  }

  const rows = filtered.map((p) => {
    const runTask = pickTask(p, 'run')
    const buildTaskKey = pickTask(p, 'build')
    const runCol = runTask ? `${c.green('run')} ${runTask}` : c.dim('—')
    const buildCol = buildTaskKey ? `${c.blue('build')} ${buildTaskKey}` : c.dim('—')
    const warn = p.warnings.length ? c.yellow(`!${p.warnings.length}`) : ''
    return [
      p.id,
      p.kind === 'mixed' ? c.magenta('mixed') : p.type === 'vue-cli' ? 'vue-cli' : p.type,
      runCol,
      buildCol,
      p.basePort ? String(p.basePort) : '-',
      p.node ? `n${p.node}` : '-',
      warn,
    ]
  })

  const s = summarize(projects)
  console.log(
    `${c.bold('工作区')} ${ctx.root}  ${c.dim(
      `共 ${s.total} 个项目 · ${s.runnable} 可运行 · ${s.withWarnings} 有提示`
    )}\n`
  )
  console.log(renderTable(['项目', '类型', '运行任务', '构建任务', '端口', 'Node', '提示'], rows))

  if (excluded.length) {
    console.log(`\n${c.bold('已剔除')} ${c.dim(`(${excluded.length})`)}`)
    for (const e of excluded) {
      console.log(`  ${c.dim('×')} ${padEnd(e.id, 30)} ${c.dim(e.reason === 'user' ? '面板/命令剔除' : '配置文件排除')}`)
    }
    console.log(c.dim(`  ${'用 devctl include <项目> 选入'}`))
  }

  console.log(`\n${c.dim('devctl run <项目>   |   devctl build <项目>   |   devctl list --json')}`)
}

async function cmdScan(opts, ctx) {
  const { projects, excluded } = scanDetailed(ctx.root, ctx.config)
  const paths = statePaths(ctx.root)
  mkdirSync(paths.base, { recursive: true })
  writeFileSync(
    paths.manifest,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        scannedRoot: ctx.root,
        summary: summarize(projects),
        projects: projects.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          absPath: p.absPath,
          kind: p.kind,
          type: p.type,
          runnable: p.runnable,
          node: p.node,
          basePort: p.basePort,
          tasks: Object.keys(p.tasks),
          warnings: p.warnings,
        })),
        excluded,
      },
      null,
      2
    ),
    'utf8'
  )
  const s = summarize(projects)
  if (opts.json) {
    console.log(JSON.stringify({ manifest: paths.manifest, summary: s, total: projects.length }, null, 2))
    return
  }
  console.log(`${c.green('✓')} 扫描完成：${s.total} 个项目（${s.runnable} 可运行），${excluded.length} 个已剔除`)
  console.log(`  manifest → ${c.dim(paths.manifest)}`)
}

/** 剔除 / 选入：写入 .devctl/prefs.json，不改动 devctl.config.json */
async function cmdToggle(opts, ctx, mode) {
  const id = opts._[1]
  if (!id) {
    fail(`用法: devctl ${mode} <项目ID>${mode === 'include' ? '（也可以用完整相对路径）' : ''}`)
  }
  const before = loadPrefs(ctx.root)

  // 先看当前状态，避免写入冗余条目
  const nowDetailed = scanDetailed(ctx.root, ctx.config)
  const nowPresent = nowDetailed.projects.some((p) => p.id === id)
  const nowExcluded = nowDetailed.excluded.some((e) => e.id === id)

  if (mode === 'include' && nowPresent) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { id, action: mode, status: 'visible', changed: false, prefsPath: statePaths(ctx.root).prefs },
          null,
          2
        )
      )
    } else {
      console.log(`${c.dim('·')} ${id} 本来就在列表里，无需选入`)
    }
    return
  }
  if (mode === 'exclude' && !nowPresent && nowExcluded) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { id, action: mode, status: 'excluded', changed: false, prefsPath: statePaths(ctx.root).prefs },
          null,
          2
        )
      )
    } else {
      console.log(`${c.dim('·')} ${id} 已经被剔除`)
    }
    return
  }

  // 选入时：只有「被 config 排除」的才需要写 included 去覆盖；
  // 仅被面板剔除的，清掉 prefs.excluded 就够了，避免留下冗余条目。
  const entry = nowDetailed.excluded.find((e) => e.id === id)
  let next
  if (mode === 'include' && (!entry || entry.reason !== 'config')) {
    next = {
      excluded: before.excluded.filter((x) => x !== id),
      included: before.included.filter((x) => x !== id),
    }
  } else {
    next = togglePrefs(before, id, mode)
  }
  const saved = savePrefs(ctx.root, next)

  // 立刻用新偏好重扫，确认结果
  const after = loadConfig(ctx.root)
  const { projects, excluded } = scanDetailed(ctx.root, after)
  const present = projects.some((p) => p.id === id)
  const remains = excluded.some((e) => e.id === id)

  let status
  if (present) status = 'visible'
  else if (remains) status = 'excluded'
  else status = 'not-found'

  const payload = {
    id,
    action: mode,
    status,
    prefsPath: statePaths(ctx.root).prefs,
    excluded: saved.excluded,
    included: saved.included,
  }

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (status === 'visible') {
    console.log(`${c.green('✓')} 已选入 ${c.bold(id)}`)
  } else if (status === 'excluded') {
    console.log(`${c.yellow('×')} 已剔除 ${c.bold(id)}`)
  } else {
    console.log(`${c.yellow('!')} ${id} 已记录，但它当前不是项目（目录不存在或没有构建文件）`)
  }
  console.log(c.dim(`  偏好文件: ${payload.prefsPath}`))
}

async function cmdRun(opts, ctx) {
  const projects = scan(ctx.root, ctx.config)
  const id = opts._[1]
  if (!id) fail('用法: devctl run <项目ID> [任务名] [--port N] [--node X]')
  const project = requireProject(projects, id)
  if (opts.node) project.node = opts.node

  let taskName = opts._[2]
  if (!taskName) {
    taskName = pickTask(project, 'run')
    if (!taskName) fail(`项目 "${id}" 没有可运行任务（只能构建）`)
  }

  const result = await startRun({
    root: ctx.root,
    project,
    taskName,
    config: ctx.config,
    portOverride: opts.port,
  })

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const alive = result.status === 'running' || isAlive(result.pid)
  console.log(`${alive ? c.green('●') : c.red('✗')} ${c.bold(project.id)} ${c.dim(taskName)} 已启动`)
  if (result.url) console.log(`  URL   ${c.blue(result.url)}`)
  if (result.port) {
    const shifted = project.basePort && result.port !== project.basePort
    console.log(`  端口  ${result.port}${shifted ? c.dim(` (基准 ${project.basePort} 被占用，已偏移)`) : ''}`)
  }
  console.log(`  PID   ${result.pid}`)
  console.log(`  日志  ${c.dim(result.logPath)}`)
  printWarnings(result.warnings, '  ')
  console.log(`\n${c.dim(`devctl logs ${result.runId} -f    |    devctl stop ${result.runId}`)}`)
}

async function cmdBuild(opts, ctx) {
  const projects = scan(ctx.root, ctx.config)
  const id = opts._[1]
  if (!id) fail('用法: devctl build <项目ID> [任务名] [--timeout 毫秒]')
  const project = requireProject(projects, id)
  if (opts.node) project.node = opts.node

  let taskName = opts._[2]
  if (!taskName) {
    taskName = pickTask(project, 'build')
    if (!taskName) fail(`项目 "${id}" 没有可构建任务`)
  }

  if (!opts.json && !opts.quiet) {
    console.log(`${c.dim('▶')} ${c.bold(project.id)} ${taskName} ${c.dim(`(${project.absPath})`)}`)
  }

  const result = await buildTask({
    root: ctx.root,
    project,
    taskName,
    config: ctx.config,
    json: opts.json,
    timeoutMs: opts.timeout,
    onData:
      opts.json || opts.quiet
        ? null
        : (text) => {
            if (text) process.stdout.write(text)
          },
  })

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const ok = result.exitCode === 0
  console.log('')
  console.log(
    `${ok ? c.green('✓') : c.red('✗')} ${project.id} ${taskName} ${
      ok ? '构建成功' : `构建失败 (exit ${result.exitCode})`
    } ${c.dim(fmtDuration(result.durationMs))}`
  )
  if (!ok && result.errors?.length) {
    console.log(`\n${c.bold('错误摘要')}`)
    for (const e of result.errors.slice(0, 15)) {
      console.log(`  ${c.red('·')} ${e.file ? c.dim(`${e.file}:${e.line ?? '?'} `) : ''}${e.message}`)
    }
  }
  console.log(c.dim(`\n完整日志: ${result.logPath}`))
  if (!ok) process.exitCode = 1
}

async function cmdStatus(opts, ctx) {
  const records = listRecords(ctx.root)
  const live = records.filter((r) => r.status === 'running' && isAlive(r.pid))
  const recent = records
    .filter((r) => r.status !== 'starting')
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 15)

  if (opts.json) {
    console.log(JSON.stringify({ root: ctx.root, running: live, recent }, null, 2))
    return
  }

  console.log(`${c.bold('运行中')} ${c.dim(`(${live.length})`)}`)
  if (!live.length) console.log(c.dim('  无'))
  for (const r of live) {
    console.log(
      `  ${statusIcon(r.status)} ${padEnd(r.projectId, 26)} ${padEnd(r.task, 8)} pid=${r.pid} ${
        r.url ? c.blue(r.url) : ''
      }`
    )
  }

  console.log(`\n${c.bold('最近任务')}`)
  if (!recent.length) console.log(c.dim('  无'))
  for (const r of recent) {
    console.log(
      `  ${statusIcon(r.status)} ${padEnd(r.projectId, 26)} ${padEnd(r.task, 8)} ${padEnd(
        r.status,
        8
      )} ${r.durationMs ? c.dim(fmtDuration(r.durationMs)) : ''}`
    )
  }
}

async function cmdLogs(opts, ctx) {
  const runId = opts._[1]
  if (!runId) fail('用法: devctl logs <runId> [--lines 120] [-f]')
  const rec = readRecord(ctx.root, runId)
  if (!rec) fail(`找不到运行记录: ${runId}`)

  if (opts.follow) {
    let seen = 0
    for (;;) {
      const { lines } = readLogTail(ctx.root, runId, 5000)
      for (const l of lines.slice(seen)) console.log(l)
      seen = lines.length
      const r = readRecord(ctx.root, runId)
      if (r && ['exited', 'failed', 'stopped'].includes(r.status)) break
      await sleep(800)
    }
    return
  }

  const { lines } = readLogTail(ctx.root, runId, opts.lines || 120)
  if (opts.json) {
    console.log(JSON.stringify({ runId, logPath: rec.logPath, lines }, null, 2))
    return
  }
  for (const l of lines) console.log(l)
}

async function cmdStop(opts, ctx) {
  const target = opts._[1]
  if (!target) fail('用法: devctl stop <runId|项目ID>')
  const asRun = readRecord(ctx.root, target)
  const results = stopRun(ctx.root, asRun ? { runId: target } : { projectId: target })
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  if (!results.length) {
    console.log(c.dim(`没有在运行的实例: ${target}`))
    return
  }
  for (const r of results) {
    console.log(`${r.stopped ? c.green('■') : c.red('✗')} ${r.runId} pid=${r.pid}`)
  }
}

async function cmdPorts(opts, ctx) {
  let targets = opts._.slice(1).map(Number).filter((n) => !Number.isNaN(n))
  if (!targets.length) {
    const projects = scan(ctx.root, ctx.config)
    targets = [...new Set(projects.map((p) => p.basePort).filter(Boolean))].sort((a, b) => a - b)
  }
  const rows = []
  const json = []
  for (const p of targets) {
    const free = await isPortFree(p)
    rows.push([String(p), free ? c.green('空闲') : c.red('占用')])
    json.push({ port: p, free })
  }
  if (opts.json) {
    console.log(JSON.stringify(json, null, 2))
    return
  }
  console.log(renderTable(['端口', '状态'], rows))
}

function cmdDoctor(opts, ctx) {
  const cfg = ctx.config
  const versions = listNodeVersions(cfg.toolchain.nvmRoot)
  const java = resolveJava(cfg.toolchain.javaHome)
  const maven = resolveMaven(cfg.toolchain.mavenHome)
  const prefs = cfg.prefs || { excluded: [], included: [] }

  const lines = []
  lines.push(`${c.bold('工具链')}`)
  lines.push(`  nvmRoot   ${cfg.toolchain.nvmRoot || c.red('未配置')}`)
  for (const v of versions) {
    lines.push(
      `    ${v.valid ? c.green('✓') : c.red('✗')} v${padEnd(v.version, 12)} ${v.dir}${
        v.hasNpm ? '' : c.yellow('  (无 npm)')
      }`
    )
  }
  if (!versions.length) lines.push(c.dim('    (未发现任何版本)'))
  lines.push(
    `  JAVA_HOME ${cfg.toolchain.javaHome || c.red('未配置')} ${
      java.ok ? c.green('✓') : c.red('✗ ' + (java.reason || ''))
    }${java.ok ? (java.hasJavac ? '' : c.yellow('  (无 javac，是 JRE)')) : ''}`
  )
  lines.push(
    `  MAVEN     ${maven.home || c.dim('(用 PATH 上的 mvn)')} ${maven.ok || !maven.home ? c.green('✓') : c.red('✗')}`
  )
  lines.push(`  defaultNode ${cfg.toolchain.defaultNode || c.dim('(不绑定)')}`)

  lines.push(`\n${c.bold('配置')}`)
  lines.push(`  root      ${ctx.root}`)
  lines.push(`  配置根     ${findRoot(process.cwd()) || c.red('未找到 devctl.config.json')}`)
  lines.push(`  排除规则   ${cfg.exclude.length} 条`)
  lines.push(`  覆盖项目   ${Object.keys(cfg.overrides).length} 个`)
  lines.push(`  剔除/选入  剔除 ${prefs.excluded.length} · 选入 ${prefs.included.length}`)
  lines.push(`  偏好文件   ${statePaths(ctx.root).prefs}`)

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          nvmRoot: cfg.toolchain.nvmRoot,
          nodeVersions: versions,
          java,
          maven,
          defaultNode: cfg.toolchain.defaultNode,
          root: ctx.root,
          prefs,
        },
        null,
        2
      )
    )
    return
  }
  console.log(lines.join('\n'))
}

/* ------------------------------ 入口 ------------------------------ */

const HELP = `
${c.bold('devctl')} —— 多仓工作区项目运行器

用法：
  devctl ${c.blue('<命令>')} [参数] [--json]

命令：
  ${c.blue('list')}                     列出所有项目
  ${c.blue('scan')}                     重新扫描并写 .devctl/manifest.json
  ${c.blue('run')} <项目> [任务]        启动（长驻，立即返回）
  ${c.blue('build')} <项目> [任务]      构建（阻塞，结束返回退出码）
  ${c.blue('stop')} <runId|项目>        停止运行实例
  ${c.blue('status')}                   查看运行中实例与最近任务
  ${c.blue('logs')} <runId> [-f]        查看日志
  ${c.blue('ports')} [端口...]          端口占用检查
  ${c.blue('exclude')} <项目>           剔除项目（写 .devctl/prefs.json）
  ${c.blue('include')} <项目>           选入项目（覆盖 config 的 exclude）
  ${c.blue('doctor')}                   工具链自检

选项：
  --root <dir>      指定工作区根（默认向上查找 devctl.config.json）
  --json            机器可读输出（供 AI agent 与面板使用）
  --node <版本>     临时指定 Node 版本
  --port <端口>     指定端口
  --timeout <ms>    构建超时
  --lines <n>       日志行数

示例：
  devctl list
  devctl run web-app
  devctl run api-service debug
  devctl build api-service --timeout 600000
  devctl exclude legacy-app
  devctl include vendor/legacy-app
  devctl list --json
`

async function main() {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)
  const cmd = opts._[0]

  if (!cmd || opts.help) {
    console.log(HELP)
    return
  }

  const ctx = resolveContext(opts)

  switch (cmd) {
    case 'list':
      return cmdList(opts, ctx)
    case 'scan':
      return cmdScan(opts, ctx)
    case 'run':
      return cmdRun(opts, ctx)
    case 'build':
      return cmdBuild(opts, ctx)
    case 'status':
      return cmdStatus(opts, ctx)
    case 'logs':
      return cmdLogs(opts, ctx)
    case 'stop':
      return cmdStop(opts, ctx)
    case 'ports':
      return cmdPorts(opts, ctx)
    case 'exclude':
      return cmdToggle(opts, ctx, 'exclude')
    case 'include':
      return cmdToggle(opts, ctx, 'include')
    case 'doctor':
      return cmdDoctor(opts, ctx)
    default:
      fail(`未知命令: ${cmd}\n  运行 devctl --help 查看用法`, 2)
  }
}

main().catch((e) => {
  console.error(`${c.red('✗')} ${e.message}`)
  if (process.env.DEVCTL_DEBUG) console.error(e.stack)
  process.exit(1)
})
