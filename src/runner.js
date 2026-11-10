// 执行器：解析命令、spawn、GBK 解码、日志与运行态记录
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { sleep } from './util.js'
import { statePaths } from './config.js'
import { buildEnv, resolveJava, resolveMaven, resolveNode } from './toolchain.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DAEMON = join(__dirname, 'daemon.js')

/* ------------------------------ 运行态 ------------------------------ */

export function ensureState(root) {
  const paths = statePaths(root)
  for (const d of [paths.base, paths.runs, paths.logs]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return paths
}

export function runIdFor(projectId, task) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  // 注意：Windows 文件名不允许 : < > " / \ | ? * ，
  // 像 uni-app 的 `dev:mp-weixin` 直接拼进去会变成 NTFS 备用数据流，
  // 目录里看到的文件名会被截断，导致 status/stop 找不到记录。
  const safe = `${projectId}_${task}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  return `${safe}_${stamp}`
}

export function recordPath(root, runId) {
  return join(statePaths(root).runs, `${runId}.json`)
}

export function readRecord(root, runId) {
  const p = recordPath(root, runId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeRecord(root, runId, patch) {
  const p = recordPath(root, runId)
  let rec = {}
  if (existsSync(p)) {
    try {
      rec = JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      rec = {}
    }
  }
  const next = { ...rec, ...patch }
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function listRecords(root) {
  const dir = statePaths(root).runs
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.spec.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/* ------------------------------ 命令解析 ------------------------------ */

export function resolveNpmRuntime(nodeInfo) {
  if (nodeInfo && nodeInfo.valid) {
    return {
      cmd: nodeInfo.nodeExe,
      prefixArgs: [nodeInfo.npmCli],
      runtime: nodeInfo.version,
      shell: false,
      viaNodeCli: true,
    }
  }
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return {
      cmd: process.execPath,
      prefixArgs: [npmCli],
      runtime: process.version.replace(/^v/, ''),
      shell: false,
      viaNodeCli: true,
    }
  }
  return { cmd: 'npm', prefixArgs: [], runtime: 'current', shell: true, viaNodeCli: false }
}

/**
 * 指定激活的 Maven profile（正式包 / 测试包 / 本地包通常就是靠它选的）。
 * 参数里已有的 -P 会被替换掉，避免同时激活两个互相冲突的环境。
 */
export function withProfileArgs(args, profile) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-P' || a === '--activate-profiles') {
      i++
      continue
    }
    out.push(a)
  }
  out.push('-P', profile)
  return out
}

/**
 * 只构建指定模块：把参数里已有的 -pl / -am 换掉。
 *
 * -am 的取舍要看 goal：
 *   - deploy：必须去掉。它会把上游模块一起拉进 reactor，deploy 连带作用在它们
 *     身上——和「只发一个模块」正好相反，反而发得更多。
 *   - package / install / test：必须加上。distribution 这类模块要打包兄弟模块的
 *     jar，没有 -am 就只会在原地打一个缺料的包。
 */
export function withModuleArgs(args, module) {
  const publishing = args.includes('deploy')
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-pl' || a === '--projects') {
      i++
      continue
    }
    if (a === '-am' || a === '--also-make') continue
    out.push(a)
  }
  out.push('-pl', module)
  if (!publishing) out.push('-am')
  return out
}

/**
 * 把项目 task 解析成可直接 spawn 的规格
 * @returns {{cmd, args, shell, cwd, env, encoding, runtimeLabel}}
 */
export function buildExecSpec({ project, task, config, port, module, profile }) {
  const javaInfo = resolveJava(config.toolchain.javaHome)
  const maven = resolveMaven(config.toolchain.mavenHome)
  const nodeWanted = project.node || task.node || null
  const nodeInfo = resolveNode(config.toolchain.nvmRoot, nodeWanted)

  let cmd
  let args
  let shell = false
  let runtimeLabel = ''

  if (task.type === 'npm') {
    const rt = resolveNpmRuntime(nodeInfo && nodeInfo.valid ? nodeInfo : null)
    cmd = rt.cmd
    args = [...rt.prefixArgs, 'run', task.script]
    shell = rt.shell
    runtimeLabel = `node ${rt.runtime}`
    // vue-cli 走 PORT 环境变量（比 `-- --port N` 经过 npm 的引号处理更可靠）；
    // vite 走 CLI 参数
    if (port && project.type !== 'vue-cli') args.push('--', '--port', String(port))
  } else if (task.type === 'mvn') {
    cmd = maven.cmd
    // run/debug 已经用 -pl 指定了可运行模块，不能再追加一个；
    // -P 只用于构建类任务——启动时的环境由配置文件里的 spring.profiles.active 决定。
    let scoped = [...task.args]
    if (task.kind !== 'run') {
      if (profile) scoped = withProfileArgs(scoped, profile)
      if (module) scoped = withModuleArgs(scoped, module)
    }
    args = scoped
    shell = true // mvn.cmd 需要 shell
    runtimeLabel = `java ${javaInfo.ok ? javaInfo.home : 'PATH'}`
    if (task.debug) {
      const dp = project.debugPort || (config.debug && config.debug.port) || 5005
      // JDK 8 用 address=<port>；JDK 9+ 才需要 *:port 形式。
      // suspend=n：应用照常启动，IDE 随时 attach。
      args.push(
        `-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${dp}`
      )
    }
  } else if (task.type === 'shell') {
    // 自定义项目：整条命令交给 shell 解释
    cmd = task.command
    args = []
    shell = true
    runtimeLabel = 'shell'
  } else {
    throw new Error(`未知任务类型: ${task.type}`)
  }

  const env = buildEnv({
    nodeInfo: nodeInfo && nodeInfo.valid ? nodeInfo : null,
    javaInfo: task.type === 'mvn' ? javaInfo : null,
  })
  if (project.env) Object.assign(env, project.env)

  const nodeVersion = nodeInfo && nodeInfo.valid ? nodeInfo.version : process.version.replace(/^v/, '')

  // webpack4 项目在 Node 17+ 上必须带 --openssl-legacy-provider；
  // 有些仓的脚本自己不带（如工业前端的 dev），这里统一兜底注入。
  // 注意：Node 16 会拒绝在 NODE_OPTIONS 里出现该参数，所以只在 major >= 17 时注入。
  if (task.type === 'npm' && project.legacy) {
    const major = parseInt(String(nodeVersion).split('.')[0], 10)
    if (major >= 17) {
      const cur = env.NODE_OPTIONS || ''
      if (!cur.includes('openssl-legacy-provider')) {
        env.NODE_OPTIONS = `${cur} --openssl-legacy-provider`.trim()
      }
    }
  }

  if (port && project.type === 'vue-cli') env.PORT = String(port)

  // 自定义任务可以指定子目录（相对项目根）
  const workdir = task.cwd ? join(project.absPath, task.cwd) : project.absPath

  return {
    cmd,
    args,
    shell,
    cwd: workdir,
    env,
    encoding: task.encoding || 'utf8',
    runtimeLabel,
    nodeVersion,
    warnings: nodeInfo && nodeInfo.missing ? [`Node ${nodeWanted} 未安装，回退到当前运行时`] : [],
  }
}

/* ------------------------------ 输出解码 ------------------------------ */

export function makeDecoder(encoding) {
  if (encoding === 'gbk' || encoding === 'gb2312' || encoding === 'gb18030') {
    const dec = new TextDecoder('gbk')
    return (buf) => dec.decode(buf, { stream: true })
  }
  const dec = new TextDecoder('utf-8')
  return (buf) => dec.decode(buf, { stream: true })
}

/* ------------------------------ 启动（长驻） ------------------------------ */

export async function startRun({ root, project, taskName, config, portOverride, json }) {
  const task = project.tasks[taskName]
  if (!task) {
    throw new Error(`项目 ${project.id} 没有任务 "${taskName}"；可用: ${Object.keys(project.tasks).join(', ')}`)
  }
  if (task.kind === 'build') {
    throw new Error(`任务 "${taskName}" 是构建任务，请用 devctl build`)
  }

  const paths = ensureState(root)
  const runId = runIdFor(project.id, taskName)

  // 端口：仅 vue-cli / vite 这类支持 --port 的项目注入
  let port = portOverride
  if (!port && project.basePort && project.type === 'vue-cli') {
    const { findFreePort } = await import('./ports.js')
    port = await findFreePort(project.basePort)
    if (port !== project.basePort) {
      // 冲突后偏移，由调用方提示
    }
  }

  const spec = buildExecSpec({ project, task, config, port })
  const logPath = join(paths.logs, `${runId}.log`)
  const phase = {
    runId,
    projectId: project.id,
    task: taskName,
    cwd: project.absPath,
    port: port || null,
    url: port ? `http://localhost:${port}` : null,
    nodeVersion: spec.nodeVersion,
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    cmd: [spec.cmd, ...spec.args].join(' '),
    encoding: spec.encoding,
    logPath,
  }
  writeRecord(root, runId, phase)

  // 写 spec 并拉起 daemon
  const specPath = join(paths.runs, `${runId}.spec.json`)
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        runId,
        root,
        cmd: spec.cmd,
        args: spec.args,
        shell: spec.shell,
        cwd: spec.cwd,
        env: spec.env,
        encoding: spec.encoding,
        logPath,
      },
      null,
      2
    ),
    'utf8'
  )

  const child = spawn(process.execPath, [DAEMON, specPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  // 等 daemon 把 pid 写进来
  const deadline = Date.now() + 8000
  let rec = readRecord(root, runId)
  while (Date.now() < deadline) {
    await sleep(120)
    rec = readRecord(root, runId)
    if (rec && rec.status !== 'starting') break
  }

  return { ...rec, runId, warnings: spec.warnings }
}

/* ------------------------------ 构建（阻塞） ------------------------------ */

export function buildTask({ root, project, taskName, config, json, onData, timeoutMs, module, profile }) {
  const task = project.tasks[taskName]
  if (!task) {
    throw new Error(`项目 ${project.id} 没有任务 "${taskName}"；可用: ${Object.keys(project.tasks).join(', ')}`)
  }
  if (task.kind === 'run') {
    throw new Error(`任务 "${taskName}" 是长驻任务，请用 devctl run`)
  }

  const paths = ensureState(root)
  const runId = runIdFor(project.id, taskName)
  const logPath = join(paths.logs, `${runId}.log`)
  const spec = buildExecSpec({ project, task, config, module, profile })

  const startedAt = Date.now()
  writeRecord(root, runId, {
    runId,
    projectId: project.id,
    task: taskName,
    cwd: project.absPath,
    status: 'running',
    startedAt: new Date(startedAt).toISOString(),
    cmd: [spec.cmd, ...spec.args].join(' '),
    encoding: spec.encoding,
    logPath,
    nodeVersion: spec.nodeVersion,
  })

  const fd = openSync(logPath, 'w')
  const decode = makeDecoder(spec.encoding)
  const tail = []
  let stderrText = ''

  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    writeRecord(root, runId, { pid: child.pid })

    const handle = (chunk, isErr) => {
      const text = decode(chunk)
      if (!text) return
      try {
        writeFileSync(fd, text, 'utf8')
      } catch {
        /* ignore */
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) tail.push(line)
      }
      while (tail.length > 4000) tail.shift()
      if (isErr) stderrText += text
      if (onData) onData(text, isErr)
    }

    child.stdout?.on('data', (b) => handle(b, false))
    child.stderr?.on('data', (b) => handle(b, true))

    let timer = null
    let timedOut = false
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, timeoutMs)
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      try { closeSync(fd) } catch { /* ignore */ }
      writeRecord(root, runId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: err.message,
      })
      resolve({ runId, exitCode: -1, error: err.message, durationMs: Date.now() - startedAt, tail, logPath })
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      try { closeSync(fd) } catch { /* ignore */ }
      const durationMs = Date.now() - startedAt
      // 被 devctl stop 显式标记为 stopped 的，不要再用退出码覆盖
      const prev = readRecord(root, runId)
      const status =
        prev && prev.status === 'stopped'
          ? 'stopped'
          : timedOut
            ? 'timeout'
            : code === 0
              ? 'success'
              : 'failed'
      writeRecord(root, runId, {
        status,
        exitCode: code,
        endedAt: new Date().toISOString(),
        durationMs,
      })
      const errors = extractErrors(tail, spec.encoding)
      resolve({
        runId,
        exitCode: code,
        status,
        timedOut,
        durationMs,
        tail: tail.slice(-(config.limits?.logTailLines || 200)),
        errors,
        logPath,
      })
    })
  })
}

/** 从输出里提炼错误行，供 agent 使用 */
export function extractErrors(lines, encoding) {
  const out = []
  const patterns = [
    /\[ERROR\]\s+(.+)/,
    /^\s*ERROR\b\s*(.+)/,
    /error TS\d+:\s*(.+)/,
    /^\s*(?:ERROR|FAILED|fatal error)\b\s*(.+)/i,
    /npm ERR!\s*(.+)/,
  ]
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line) continue
    for (const p of patterns) {
      const m = line.match(p)
      if (m) {
        // 提取 文件:行 位置
        const pos = line.match(/([A-Za-z]:[\\/][^\s:]+\.[a-zA-Z0-9]+):(\d+)/)
        out.push({
          message: line.slice(0, 500),
          file: pos ? pos[1] : null,
          line: pos ? Number(pos[2]) : null,
        })
        break
      }
    }
    if (out.length >= 50) break
  }
  return out
}

/* ------------------------------ 停止 / 日志 ------------------------------ */

export function stopRun(root, { runId, projectId }) {
  let recs = listRecords(root)
  if (runId) recs = recs.filter((r) => r.runId === runId)
  else if (projectId) recs = recs.filter((r) => r.projectId === projectId)
  else throw new Error('需要 runId 或 projectId')

  const alive = recs.filter((r) => r.status === 'running' && isAlive(r.pid))
  const results = []
  for (const r of alive) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true }).unref()
      } else {
        process.kill(r.pid, 'SIGTERM')
      }
      writeRecord(root, r.runId, { status: 'stopped', endedAt: new Date().toISOString() })
      results.push({ runId: r.runId, pid: r.pid, stopped: true })
    } catch (e) {
      results.push({ runId: r.runId, pid: r.pid, stopped: false, error: e.message })
    }
  }
  return results
}

export function readLogTail(root, runId, lines = 120) {
  const rec = readRecord(root, runId)
  const path = rec?.logPath || join(statePaths(root).logs, `${runId}.log`)
  if (!existsSync(path)) return { path, lines: [] }
  const size = statSync(path).size
  const maxBytes = Math.min(size, 256 * 1024)
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(maxBytes)
  readSync(fd, buf, 0, maxBytes, Math.max(0, size - maxBytes))
  closeSync(fd)
  const text = buf.toString('utf8')
  const all = text.split(/\r?\n/).filter((l) => l.length)
  return { path, lines: all.slice(-lines) }
}
