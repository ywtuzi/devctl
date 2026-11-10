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
    // 1) 插件自带的 CLI 副本（scripts/vendor.mjs 生成）——独立安装时唯一可用的一条
    join(__dirname, 'vendor', 'bin', 'devctl.js'),
    // 2) 工作区里已有 devctl
    join(root, 'devctl', 'bin', 'devctl.js'),
    join(root, 'bin', 'devctl.js'),
    // 3) 同仓签出（开发状态）：本文件在 <repo>/dsh-plugin/ 下
    join(__dirname, '..', 'bin', 'devctl.js'),
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
 * 源码版本号：取 src/ 下所有文件的最大 mtime。
 * Node 的 ESM 缓存按 URL 命中，插件重载不会清掉它——加了版本号查询串后，
 * vendor 一更新 URL 就变，宿主才会真正用上新代码。
 */
function srcVersion(srcDir) {
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
  return Math.round(max)
}

async function loadMods(cli) {
  const srcDir = join(dirname(dirname(cli)), 'src')
  const ver = srcVersion(srcDir)
  if (modsCache && modsCache.dir === srcDir && modsCache.ver === ver) return modsCache.value
  const url = (f) => `${pathToFileURL(join(srcDir, f)).href}?v=${ver}`
  const [configMod, scanMod, planMod] = await Promise.all([
    import(url('config.js')),
    import(url('scan.js')),
    import(url('plan.js')),
  ])
  modsCache = { dir: srcDir, ver, value: { configMod, scanMod, planMod } }
  return modsCache.value
}

let projectsCache = null

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
    if (r.status === 'running' && isAlive(r.pid)) running.push(r)
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
  const all = buf.toString('utf8').split(/\r?\n/).filter((l) => l.length)
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
  let root = resolveRootBase(ctx, cfg)
  const cli = resolveCli(root, cfg)

  // DSH 的默认工作目录可能不是用户的工作区（例如 tray 目录）。
  // 如果那里没有 devctl.config.json，就从 CLI 自身位置向上找真正的仓库根。
  if (cli && !existsSync(join(root, 'devctl.config.json'))) {
    const found = findRootFrom(dirname(cli))
    if (found) root = found
  }

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
    let pathname = API_PREFIX
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      /* 解析失败按空动作处理 */
    }
    const action = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
    const method = String(req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', 'http://localhost')

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

      if (action === 'projects' && method === 'GET') {
        try {
          const { projects, excluded } = await getScan(root, cli)
          return send(res, 200, {
            root,
            summary: summarize(projects),
            projects: projects.map(toWire),
            excluded,
          })
        } catch {
          // 宿主内失败时退回子进程，保证仍能用
          const data = await runCli(cli, root, ['list', '--json'])
          return send(res, 200, { root, ...data })
        }
      }

      if (action === 'status' && method === 'GET') {
        return send(res, 200, { root, ...readStatus(root) })
      }

      if (action === 'logs' && method === 'GET') {
        const runId = url.searchParams.get('runId')
        if (!runId) return send(res, 400, { error: '缺少 runId' })
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
          // 退回子进程：直接跑 bin/plan.js
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
        try {
          const { running } = readStatus(root)
          const dup = running.find(
            (r) => r.projectId === body.id && (!body.task || r.task === body.task)
          )
          if (dup) {
            buildLocks.delete(lock.key)
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
