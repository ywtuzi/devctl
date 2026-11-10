/**
 * DevCTL 面板 —— Host 半。
 * 职责：把 devctl CLI 包成 JSON API（/devctl-api/*），供 Web 页面的悬浮面板调用。
 * 不做任何项目识别逻辑，全部复用 CLI，保证与终端行为一致。
 *
 * 注意：使用 handler 路由而不是 resource 路由 —— resource 只放行 GET/HEAD，
 *       POST 会被判 405；handler 拿到原始 IncomingMessage/ServerResponse，可处理任意方法。
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'

export const inject = ['webServer']

const __dirname = dirname(fileURLToPath(import.meta.url))

const API_PREFIX = '/devctl-api'

/** 从某个目录向上找含 devctl.config.json 的目录 */
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
    join(root, 'devctl', 'bin', 'devctl.js'),
    join(root, 'bin', 'devctl.js'),
    // 插件与 CLI 同仓分发时，本文件在 <repo>/dsh-plugin/ 下
    join(__dirname, '..', 'bin', 'devctl.js'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

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

function send(res, status, data) {
  const payload = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
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

  // 打包去重：status 检查有约 1 秒空窗（构建进程 detach 后才写记录），
  // 所以再用一个进程内锁兜住「连续两次点击」这种竞态。
  const buildLocks = new Map()
  const LOCK_TTL_MS = 60000

  const takeBuildLock = (id, task) => {
    const key = `${id}|${task || '*'}`
    const now = Date.now()
    for (const [k, at] of buildLocks) {
      if (now - at > LOCK_TTL_MS) buildLocks.delete(k)
    }
    if (buildLocks.has(key)) return { key, busy: true }
    buildLocks.set(key, now)
    return { key, busy: false }
  }

  const handler = async (req, res) => {
    let pathname = API_PREFIX
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      /* 无法解析时按空动作处理 */
    }
    const action = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
    const method = String(req.method || 'GET').toUpperCase()

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
        const data = await runCli(cli, root, ['list', '--json'])
        return send(res, 200, { root, ...data })
      }

      if (action === 'status' && method === 'GET') {
        const data = await runCli(cli, root, ['status', '--json'])
        return send(res, 200, { root, ...data })
      }

      if (action === 'preview' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const planJs = join(dirname(cli), 'plan.js')
        const args = [body.id]
        if (body.task) args.push(body.task)
        const data = await runCli(planJs, root, args, 30000)
        return send(res, 200, data)
      }

      if (action === 'run' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const args = ['run', body.id]
        if (body.task) args.push(body.task)
        args.push('--json')
        const data = await runCli(cli, root, args, 120000)
        return send(res, 200, data)
      }

      if (action === 'build' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })

        // 1) 进程内锁：挡住「连续两次点击」的竞态
        const lock = takeBuildLock(body.id, body.task)
        if (lock.busy) {
          return send(res, 200, { started: false, busy: true, id: body.id, reason: 'lock' })
        }

        // 2) 真实状态：挡住已存在实例的重复启动
        try {
          const st = await runCli(cli, root, ['status', '--json'], 20000)
          const dup = (st.running || []).find(
            (r) => r.projectId === body.id && (!body.task || r.task === body.task)
          )
          if (dup) {
            buildLocks.delete(lock.key)
            return send(res, 200, { started: false, busy: true, id: body.id, runId: dup.runId })
          }
        } catch {
          /* 状态查询失败不应阻塞构建 */
        }

        const args = [cli, '--root', root, 'build', body.id]
        if (body.task) args.push(body.task)
        // 构建可能几分钟：脱离请求生命周期，结果通过 status 轮询
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
        return send(res, 200, { results: data })
      }

      if (action === 'exclude' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const data = await runCli(cli, root, ['exclude', body.id, '--json'], 30000)
        return send(res, 200, data)
      }

      if (action === 'include' && method === 'POST') {
        const body = await readBody(req)
        if (!body.id) return send(res, 400, { error: '缺少 id' })
        const data = await runCli(cli, root, ['include', body.id, '--json'], 30000)
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
