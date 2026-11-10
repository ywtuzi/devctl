// 长驻任务守护进程：被 devctl run 以 detached 方式拉起，负责给子进程收尸和落日志
import { readFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { makeDecoder, recordPath, readRecord, writeRecord } from './runner.js'

const specPath = process.argv[2]
if (!specPath || !existsSync(specPath)) {
  console.error('daemon: 缺少 spec')
  process.exit(2)
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const decode = makeDecoder(spec.encoding)

let fd
try {
  fd = openSync(spec.logPath, 'w')
} catch (e) {
  writeRecord(spec.root, spec.runId, { status: 'failed', error: `无法写日志: ${e.message}` })
  process.exit(1)
}

const child = spawn(spec.cmd, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  shell: spec.shell,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

writeRecord(spec.root, spec.runId, { status: 'running', pid: child.pid })

/** 已被 devctl stop 标记为 stopped 的，不要再用退出码覆盖 */
const currentStatus = () => {
  const cur = readRecord(spec.root, spec.runId)
  return cur ? cur.status : null
}

const write = (text) => {
  if (!text) return
  try {
    writeSync(fd, text)
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(text)
  } catch {
    /* ignore */
  }
}

child.stdout?.on('data', (b) => write(decode(b)))
child.stderr?.on('data', (b) => write(decode(b)))

child.on('error', (err) => {
  const prev = currentStatus()
  writeRecord(spec.root, spec.runId, {
    status: prev === 'stopped' ? 'stopped' : 'failed',
    error: err.message,
    endedAt: new Date().toISOString(),
  })
  try {
    closeSync(fd)
  } catch {
    /* ignore */
  }
  process.exit(0)
})

child.on('close', (code) => {
  const prev = currentStatus()
  writeRecord(spec.root, spec.runId, {
    status: prev === 'stopped' ? 'stopped' : code === 0 ? 'exited' : 'failed',
    exitCode: code,
    endedAt: new Date().toISOString(),
  })
  try {
    closeSync(fd)
  } catch {
    /* ignore */
  }
  process.exit(0)
})

// 自身被 kill 时连带子进程
const shutdown = () => {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  try {
    closeSync(fd)
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
