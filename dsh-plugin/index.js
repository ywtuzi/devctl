/**
 * DevCTL 面板 —— Host 半。
 *
 * 性能设计：面板轮询的 /status 与 /preview、/projects 都在宿主进程内完成，
 * 不起子进程。实测每次 spawn node 要 ~300ms，而扫描本身只要 ~60ms。
 * 只有真正会改变状态的写操作（run / build / stop / exclude / include）才走 CLI，
 * 保证「面板执行」与「终端执行」是同一条路径。
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'

export const inject = ['webServer']

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_PREFIX = '/devctl-api'
const PROJECTS_TTL_MS = 2000
const GC_INTERVAL_MS = 10 * 60 * 1000

/* ---------------------------- 路径解析 ---------------------------- */

function findRootFrom(start, maxHops = 5) {
  let dir = start
  for (let i = 0; i < maxHops; i++) {
    if (existsSync(join(dir, 'devctl.config.json'))) return dir.replace(/\\/g, '/')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveRootBase(ctx, config) {
  if (config && config.root) return String(config.root).replace(/\\/g, '/')
  try {
    const wd = ctx.get('workingDirectory')
    if (wd && wd.defaultDirectory) return wd.defaultDirectory
  } catch {
    /* 服务不可用时回退 */
  }
  return process.cwd()
}

function resolveCli(root, config) {
  if (config && config.cliPath && existsSync(config.cliPath)) return config.cliPath
  const candidates = [
    // 1) 同仓签出（开发状态）：本文件在 <repo>/dsh-plugin/ 下。
    //    优先于 vendor 副本，避免仓库更新后面板还在跑旧逻辑。
    //    必须同时看到 ../src 与 ../package.json(name=devctl)，
    //    否则独立安装时 node_modules 里相邻包的 bin/devctl.js 会被误认。
    existsSync(join(__dirname, '..', 'src', 'config.js')) &&
      (() => {
        try {
          return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).name === 'devctl'
        } catch {
          return false
        }
      })()
      ? join(__dirname, '..', 'bin', 'devctl.js')
      : null,
    // 2) 工作区里已有 devctl
    join(root, 'devctl', 'bin', 'devctl.js'),
    join(root, 'bin', 'devctl.js'),
    // 3) 插件自带的 CLI 副本（scripts/vendor.mjs 生成）——独立安装时唯一可用的一条
    join(__dirname, 'vendor', 'bin', 'devctl.js'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/* ---------------------------- 子进程（写操作专用） ---------------------------- */

function runCli(cli, root, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, '--root', root, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim()
          return reject(new Error(detail.slice(0, 2000) || 'devctl 执行失败'))
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error(`devctl 输出不是 JSON: ${String(stdout).slice(0, 400)}`))
        }
      }
    )
  })
}

/* ---------------------------- 宿主内模块 ---------------------------- */

let modsCache = null

/**
 * 源码版本号：优先取 src 同级 package.json 的 version，
 * 再叠加所有文件的 mtime。只用 mtime 的问题是 npm install / robocopy
 * 之类会把 mtime 重置成同一个值，缓存失效机制随之失灵；
 * 内容变了 version 或 mtime 至少有一个会变，双保险。
 */
async function srcVersion(srcDir) {
  let ver = ''
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(srcDir), 'package.json'), 'utf8'))
    ver = String(pkg.version || '')
  } catch {
    /* 无 package.json 时只用 mtime */
  }
  let max = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          max = Math.max(max, statSync(p).mtimeMs)
        } catch {
          /* 忽略不可读文件 */
        }
      }
    }
  }
  walk(srcDir)
  return `${ver}@${Math.round(max)}`
}

async function loadMods(cli) {
  const srcDir = join(dirname(dirname(cli)), 'src')
  const ver = await srcVersion(srcDir)
  if (modsCache && modsCache.dir === srcDir && modsCache.ver === ver) return modsCache.value
  const url = (f) => `${pathToFileURL(join(srcDir, f)).href}?v=${ver}`
  const [configMod, scanMod, planMod, runnerMod, gitMod] = await Promise.all([
    import(url('config.js')),
    import(url('scan.js')),
    import(url('plan.js')),
    import(url('runner.js')),
    import(url('git.js')),
  ])
  modsCache = { dir: srcDir, ver, value: { configMod, scanMod, planMod, runnerMod, gitMod } }
  return modsCache.value
}

let projectsCache = null
let gitDetailCache = null

const toWire = (p) => ({
  id: p.id,
  displayName: p.displayName,
  packageName: p.packageName || null,
  kind: p.kind,
  type: p.type,
  runnable: p.runnable,
  node: p.node,
  version: p.version || null,
  modules: p.modules || [],
  profiles: p.profiles || [],
  basePort: p.basePort,
  tasks: Object.entries(p.tasks || {}).map(([k, t]) => ({
    name: k,
    kind: t.kind,
    section: t.section || null,
    label: t.label || null,
    platform: t.platform || null,
    action: t.action || null,
    detail: t.detail || null,
    note: t.note || null,
  })),
  warnings: p.warnings || [],
})

const summarize = (projects) => ({
  total: projects.length,
  runnable: projects.filter((p) => p.runnable).length,
  maven: projects.filter((p) => p.kind === 'maven' || p.kind === 'mixed').length,
  node: projects.filter((p) => p.kind === 'node' || p.kind === 'mixed').length,
  withWarnings: projects.filter((p) => (p.warnings || []).length).length,
})

/** 扫描（宿主内，带 2 秒缓存） */
async function getScan(root, cli, { force = false } = {}) {
  const now = Date.now()
  if (
    !force &&
    projectsCache &&
    projectsCache.root === root &&
    now - projectsCache.at < PROJECTS_TTL_MS
  ) {
    return projectsCache.value
  }
  const { configMod, scanMod } = await loadMods(cli)
  const config = configMod.loadConfig(root)
  const { projects, excluded } = scanMod.scanDetailed(root, config)
  const value = { config, projects, excluded }
  projectsCache = { at: now, root, value }
  return value
}

/** 运行态：直接读 .devctl/runs，不起子进程（实测 340ms → 1ms） */
function readStatus(root) {
  const dir = join(root, '.devctl', 'runs')
  const running = []
  const recent = []
  if (!existsSync(dir)) return { running, recent }

  const isAlive = (pid) => {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e.code === 'EPERM'
    }
  }

  const recs = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.spec.json')) continue
    try {
      recs.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      /* 跳过损坏记录 */
    }
  }
  for (const r of recs) {
    if (r.status !== 'running') continue
    if (isAlive(r.pid)) {
      running.push(r)
    } else {
      // daemon 被强杀 / 机器重启后记录会永远停在 running。
      // 回写为 lost，recent 列表里的状态才和事实一致。
      r.status = 'lost'
      r.endedAt = r.endedAt || new Date().toISOString()
      try {
        const tmp = join(dir, `${r.runId}.lost.tmp`)
        writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf8')
        renameSync(tmp, join(dir, f))
      } catch {
        /* 回写失败不影响本次返回 */
      }
    }
  }
  recent.push(
    ...recs
      .filter((r) => r.status !== 'starting')
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 20)
  )
  return { running, recent }
}

/**
 * 日志读取。两种模式：
 *  - 不传 offset：返回尾部 N 行 + 当前字节偏移（首屏）
 *  - 传 offset：只返回该偏移之后新增的完整行（增量 tail，避免每秒重传）
 * 增量模式只推进到最后一个换行符，避免把多字节字符切成两半。
 */
function readLog(root, runId, { lines = 200, offset = null } = {}) {
  const p = join(root, '.devctl', 'logs', `${runId}.log`)
  if (!existsSync(p)) return { runId, path: p, offset: 0, lines: [], data: '' }
  const size = statSync(p).size

  if (offset != null) {
    if (offset >= size) return { runId, path: p, offset: size, lines: [], data: '' }
    const len = Math.min(size - offset, 128 * 1024)
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, offset)
    closeSync(fd)
    const chunk = buf.toString('utf8')
    const nl = chunk.lastIndexOf('\n')
    if (nl < 0) return { runId, path: p, offset, lines: [], data: '' }
    const complete = chunk.slice(0, nl + 1)
    return {
      runId,
      path: p,
      offset: offset + Buffer.byteLength(complete, 'utf8'),
      lines: [],
      data: complete,
    }
  }

  const maxBytes = Math.min(size, 256 * 1024)
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(p, 'r')
  const buf = Buffer.alloc(maxBytes)
  readSync(fd, buf, 0, maxBytes, start)
  closeSync(fd)
  // 起点落在任意字节上可能切断多字节字符（CJK 乱码），回退到第一个换行再解码
  const body = start > 0 ? buf.slice(buf.indexOf(0x0a) + 1) : buf
  const all = body.toString('utf8').split(/\r?\n/).filter((l) => l.length)
  const lastNl = buf.lastIndexOf(0x0a)
  const nextOffset = lastNl >= 0 ? start + lastNl + 1 : size
  return { runId, path: p, offset: nextOffset, lines: all.slice(-lines), data: '' }
}

/* ---------------------------- HTTP ---------------------------- */

function send(res, status, data) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export function apply(ctx, config) {
  const cfg = config || {}

  // root 惰性解析：apply() 只执行一次，但 DSH 可能在会话中切换工作目录。
  // 每次请求重新解析（几次 existsSync，<1ms），解析结果与上次相同时复用缓存。
  let targetsCache = null
  const resolveTargets = () => {
    const base = resolveRootBase(ctx, cfg)
    const key = base
    if (targetsCache && targetsCache.key === key) return targetsCache.value
    let root = base
    const cli = resolveCli(root, cfg)
    // DSH 的默认工作目录可能不是用户的工作区（例如 tray 目录）。
    // 如果那里没有 devctl.config.json，就从 CLI 自身位置向上找真正的仓库根。
    if (cli && !existsSync(join(root, 'devctl.config.json'))) {
      const found = findRootFrom(dirname(cli))
      if (found) root = found
    }
    const value = { root, cli }
    targetsCache = { key, value }
    return value
  }
  resolveTargets()

  // 打包去重：进程内锁挡住「spawn 到记录写盘」那约 1 秒的空窗
  const buildLocks = new Map()
  const LOCK_TTL_MS = 60000
  const takeBuildLock = (id, task) => {
    const key = `${id}|${task || '*'}`
    const now = Date.now()
    for (const [k, at] of buildLocks) if (now - at > LOCK_TTL_MS) buildLocks.delete(k)
    if (buildLocks.has(key)) return { key, busy: true }
    buildLocks.set(key, now)
    return { key, busy: false }
  }

  const handler = async (req, res) => {
    let lastGcAt = 0
    const maybeGc = (root) => {
      if (Date.now() - lastGcAt < GC_INTERVAL_MS) return
      lastGcAt = Date.now()
      try {
        const gcState = modsCache ? modsCache.value.runnerMod.gcState : null
        if (gcState) gcState(root)
      } catch {
        /* 清理失败不影响业务 */
      }
    }

    let pathname = API_PREFIX
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      /* 解析失败按空动作处理 */
    }
    const action = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
    const method = String(req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', 'http://localhost')
    const { root, cli } = resolveTargets()

    if (!cli) {
      return send(res, 500, {
        error: `未找到 devctl CLI。请在插件配置里设置 cliPath，或确认 ${root}/devctl/bin/devctl.js 存在。`,
        root,
      })
    }

    try {
      if (action === 'config' && method === 'GET') {
        return send(res, 200, { root, cli })
      }

      // 用系统默认编辑器打开 devctl.config.json（面板 ⚙ 按钮）
      if (action === 'open-config' && method === 'POST') {
        const file = join(root, 'devctl.config.json')
        if (!existsSync(file)) {
          return send(res, 404, { error: `配置文件不存在: ${file}` })
        }
        if (process.platform === 'win32') {
          // start 是 cmd 内建命令，必须走 cmd /c；引号手工拼 + verbatim，
          // 避免 node 的参数转义规则和 cmd 自己的解析规则互相打架
          spawn(process.env.Comspec || 'cmd.exe', ['/c', `start "" "${file}"`], {
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
          }).unref()
        } else {
          const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
          spawn(opener, [file], { detached: true, stdio: 'ignore' }).unref()
        }
        return send(res, 200, { opened: true, file })
      }

      if (action === 'projects' && method === 'GET') {
        try {
          const { projects, excluded } = await getScan(root, cli)
          const { gitMod } = await loadMods(cli)
          // Tier 0 分支速览：直读 .git/HEAD，17 仓 ~4ms，可以随热路径走
          const branches = {}
          for (const p of projects) {
            const b = gitMod.readBranchFast(p.absPath)
            if (b) branches[p.id] = b
          }
          return send(res, 200, {
            root,
            summary: summarize(projects),
            projects: projects.map(toWire),
            excluded,
            gitBranches: branches,
          })
        } catch (e) {
          // 宿主内失败时退回子进程，保证仍能用；留一条日志便于排查版本不一致
          console.warn('[devctl-panel] 宿主内扫描失败，回退 CLI 子进程:', (e && e.message) || e)
          const data = await runCli(cli, root, ['list', '--json'])
          return send(res, 200, { root, ...data })
        }
      }

      if (action === 'status' && method === 'GET') {
        maybeGc(root)
        const status = readStatus(root)
        // 释放可以放手的构建锁：宿主 detached 构建结束后，锁由这里按记录状态回收
        try {
          const { runnerMod } = modsCache ? modsCache.value : {}
          if (runnerMod) {
            runnerMod.sweepBuildLocks(root, (id, task) =>
              status.running.some((r) => r.projectId === id && (!task || r.task === task || task === null))
            )
          }
        } catch {
          /* 锁回收失败不影响业务 */
        }
        return send(res, 200, { root, ...status })
      }

      if (action === 'logs' && method === 'GET') {
        const runId = url.searchParams.get('runId')
        // runId 会拼进文件路径，必须先校验，否则 ..%2F 可穿越读任意 .log 文件
        if (!runId || !/^[A-Za-z0-9_.-]+$/.test(runId)) {
          return send(res, 400, { error: '非法 runId' })
        }
        const lines = Number(url.searchParams.get('lines') || 200)
        const rawOffset = url.searchParams.get('offset')
        const offset = rawOffset === null ? null : Number(rawOffset)
        return send(
          res,
          200,
          readLog(root, runId, {
            lines: Math.min(Math.max(lines, 1), 2000),
            offset: Number.isFinite(offset) ? offset : null,
          })
        )
      }

      if (action === 'preview' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        try {
          const { config: loaded, projects } = await getScan(root, cli)
          const plan = await loadMods(cli).then((m) =>
            m.planMod.buildPlan({
              root,
              config: loaded,
              id: body.id,
              taskName: body.task,
              module: body.module || null,
              profile: body.profile || null,
              projects,
            })
          )
          return send(res, 200, plan)
        } catch (e) {
          // 退回子进程：直接跑 bin/plan.js；同样留日志
          console.warn('[devctl-panel] 宿主内预演失败，回退 plan.js 子进程:', (e && e.message) || e)
          const args = [body.id]
          if (body.task) args.push(body.task)
          if (body.module) args.push('--module', body.module)
          if (body.profile) args.push('--profile', body.profile)
          const data = await runCli(join(dirname(cli), 'plan.js'), root, args, 30000).catch(() => null)
          if (data) return send(res, 200, data)
          return send(res, 500, { error: String(e.message || e) })
        }
      }

      if (action === 'run' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const args = ['run', body.id]
        if (body.task) args.push(body.task)
        args.push('--json')
        const data = await runCli(cli, root, args, 120000)
        projectsCache = null
        return send(res, 200, data)
      }

      if (action === 'build' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })

        const lock = takeBuildLock(body.id, body.task)
        if (lock.busy) {
          return send(res, 200, { started: false, busy: true, id: body.id, reason: 'lock' })
        }

        // 跨进程文件锁：挡住「另一个 DSH 窗口 / 终端里已在构建」的情况
        let fileLock = null
        try {
          const { runnerMod } = await loadMods(cli)
          fileLock = runnerMod.acquireBuildLock(root, body.id, body.task, { pid: 0 })
          if (fileLock.busy) {
            buildLocks.delete(lock.key)
            return send(res, 200, {
              started: false, busy: true, id: body.id, reason: 'cross-process lock',
            })
          }
        } catch {
          /* 加锁失败不阻塞构建（老版本 CLI 无此能力时回退旧行为） */
        }

        try {
          const { running } = readStatus(root)
          const dup = running.find(
            (r) => r.projectId === body.id && (!body.task || r.task === body.task)
          )
          if (dup) {
            buildLocks.delete(lock.key)
            if (fileLock) {
              try {
                const { runnerMod } = await loadMods(cli)
                runnerMod.releaseBuildLock(root, body.id, body.task)
              } catch { /* ignore */ }
            }
            return send(res, 200, { started: false, busy: true, id: body.id, runId: dup.runId })
          }
        } catch {
          /* 状态读取失败不阻塞构建 */
        }

        const args = [cli, '--root', root, 'build', body.id]
        if (body.task) args.push(body.task)
        if (body.module) args.push('--module', body.module)
        if (body.profile) args.push('--profile', body.profile)
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          // CLI 看到这个标记会把宿主的 pid:0 锁接管成自己的 pid，
          // 避免 CLI 一启动就撞上宿主刚拿的锁
          env: { ...process.env, DEVCTL_ADOPT_LOCK: '1' },
        })
        child.unref()
        return send(res, 200, { started: true, id: body.id })
      }

      if (action === 'stop' && method === 'POST') {
        const body = await readBody(req)
        const target = body.runId || body.projectId
        if (!target) return send(res, 400, { error: '缺少 projectId 或 runId' })
        const data = await runCli(cli, root, ['stop', target, '--json'], 30000)
        projectsCache = null
        return send(res, 200, { results: data })
      }

      if ((action === 'exclude' || action === 'include') && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const data = await runCli(cli, root, [action, body.id, '--json'], 30000)
        projectsCache = null
        return send(res, 200, data)
      }

      if (action === 'git-detail' && method === 'GET') {
        // Tier 1：单仓详情（status + 分支列表），点击项目 git 面板时才调。
        // spawn 一个 git ~1s（慢机器），带 30s 缓存，git-action 后失效。
        const id = url.searchParams.get('id')
        if (!id || !/^[A-Za-z0-9_./-]+$/.test(id)) return send(res, 400, { error: '非法 id' })
        const { projects } = await getScan(root, cli)
        const project = projects.find((p) => p.id === id)
        if (!project) return send(res, 404, { error: `项目不存在: ${id}` })
        try {
          const { gitMod } = await loadMods(cli)
          if (!gitDetailCache || gitDetailCache.id !== id || Date.now() - gitDetailCache.at > 30000) {
            const [status, branches] = await Promise.all([
              gitMod.gitStatusDetail(project.absPath),
              gitMod.gitBranches(project.absPath),
            ])
            gitDetailCache = { id, at: Date.now(), value: { status, branches } }
          }
          return send(res, 200, { id, ...gitDetailCache.value })
        } catch (e) {
          return send(res, 500, { error: String((e && e.message) || e) })
        }
      }

      if (action === 'git-action' && method === 'POST') {
        // Tier 2：写操作全部走 CLI（与终端同路径）。支持 preview 只回显命令不执行。
        const body = await readBody(req)
        const { id, op } = body
        if (!id || !op) return send(res, 400, { error: '缺少 id 或 op' })
        if (!['fetch', 'pull', 'switch', 'update', 'delete', 'merge', 'merge-abort'].includes(op)) {
          return send(res, 400, { error: `不支持的操作: ${op}` })
        }
        if ((op === 'switch' || op === 'update' || op === 'delete' || op === 'merge') && !body.branch) {
          return send(res, 400, { error: `${op} 需要 branch` })
        }
        if (body.branch && !/^[A-Za-z0-9_./-]+$/.test(body.branch)) {
          return send(res, 400, { error: '非法 branch' })
        }
        // update 的远端名由客户端从分支 upstream 传入（面板里已有，
        // 预演不再为此 spawn git——慢机器上一次 git ~1s，预演必须毫秒级返回）
        if (body.remote && !/^[A-Za-z0-9_.\\-]+$/.test(body.remote)) {
          return send(res, 400, { error: '非法 remote' })
        }
        if (body.preview) {
          const { gitMod } = await loadMods(cli)
          const force = op === 'delete' && body.force === true
          const cmd =
            op === 'update'
              ? gitMod.gitCommandPreview.update(body.branch, body.remote || 'origin')
              : op === 'delete'
                ? gitMod.gitCommandPreview.delete(body.branch, force)
                : gitMod.gitCommandPreview[op](body.branch)
          const warn =
            op === 'delete'
              ? force
                ? '强制删除未合并分支：该分支独有的提交会被丢弃（确认已在别处保留再用）'
                : '只删除已合并分支；未合并分支会被拒绝（防止丢提交）'
              : op === 'merge'
                ? '把该分支合并进当前分支；如产生冲突，文件会标记为未合并状态（面板会出现「放弃合并」按钮）'
                : op === 'merge-abort'
                  ? '放弃进行中的合并，工作区与暂存区回到合并前状态'
                  : null
          return send(res, 200, {
            id, op, cmd, warn,
            cwd: (await getScan(root, cli)).projects.find((p) => p.id === id)?.absPath || null,
          })
        }
        const args = ['git', op, id]
        if (op === 'switch' || op === 'update' || op === 'delete' || op === 'merge') args.push(body.branch)
        // force 只对 delete 生效（-D），其余操作忽略，避免误传导致命令语义漂移
        if (op === 'delete' && body.force === true) args.push('--force')
        args.push('--json')
        const data = await runCli(cli, root, args, 300000)
        gitDetailCache = null
        projectsCache = null
        return send(res, 200, data)
      }

      return send(res, 404, { error: `未知操作: ${method} ${action}` })
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    })
  )
}
