// 端口探测
// 注意：不能只靠 listen 探测。Windows 的 SO_REUSEADDR 允许两个 socket 绑定同一端口，
//      listen 成功不代表端口空闲。所以先用 connect 判断是否有人在监听，再用 listen 兜底。
import net from 'node:net'

function canConnect(port, host, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done('open')) // 有人监听 → 已占用
    sock.once('timeout', () => done('unknown'))
    sock.once('error', (e) => {
      if (e.code === 'ECONNREFUSED') done('closed')
      else if (e.code === 'EADDRNOTAVAIL') done('closed')
      else done('unknown')
    })
  })
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try {
        srv.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    srv.once('error', () => done(false))
    srv.once('listening', () => done(true))
    try {
      srv.listen(port, host)
    } catch {
      done(false)
    }
  })
}

/**
 * 端口是否空闲。
 * 判定：能连上 → 占用；连不上但 listen 失败 → 占用；否则空闲。
 */
export async function isPortFree(port, host = '127.0.0.1') {
  const conn = await canConnect(port, host)
  if (conn === 'open') return false
  const listen = await canListen(port, host)
  return listen
}

/** 从 start 开始找第一个空闲端口 */
export async function findFreePort(start, max = 30) {
  for (let i = 0; i < max; i++) {
    const p = start + i
    if (await isPortFree(p)) return p
  }
  return null
}

/** 列出某范围内被占用的端口 */
export async function scanPorts(ports) {
  const out = []
  for (const p of ports) {
    out.push({ port: p, free: await isPortFree(p) })
  }
  return out
}
