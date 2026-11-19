// git 性能实测：热缓存下各命令的开销
import { loadConfig } from '../src/config.js'
import { scan } from '../src/scan.js'
import * as scanMod from '../src/scan.js'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/gitClone'
const cfg = loadConfig(root)
const dirs = scanMod.scan(root, cfg).map((p) => p.absPath)

const run = (d, args, globalArgs = []) =>
  new Promise((r) => {
    const t = Date.now()
    execFile('git', [...globalArgs, '-C', d, ...args], { timeout: 8000 }, (e, out, err) =>
      r({ ms: Date.now() - t, ok: !e, out: out || '', err: err || '' })
    )
  })

const bench = async (label, args, globalArgs) => {
  const t = Date.now()
  const rs = await Promise.all(dirs.map((d) => run(d, args, globalArgs)))
  const avg = Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length)
  console.log(
    label.padEnd(30), '并发墙钟:', String(Date.now() - t).padStart(5) + 'ms',
    '单仓均值:', String(avg).padStart(4) + 'ms',
    '最大:', String(Math.max(...rs.map((r) => r.ms))).padStart(5) + 'ms',
    '失败:', rs.filter((r) => !r.ok).length
  )
  if (rs.some((r) => !r.ok)) console.log('  失败样例:', rs.find((r) => !r.ok).err.slice(0, 120).trim())
  return rs
}

console.log('项目数:', dirs.length, '\n')
const NOLOCK = ['--no-optional-locks']
await bench('status v2+b (热)', ['status', '--porcelain=v2', '--branch'], NOLOCK)
await bench('status v2+b (第二次)', ['status', '--porcelain=v2', '--branch'], NOLOCK)
await bench('status -sb -unormal', ['status', '-sb', '-unormal'], NOLOCK)
await bench('rev-parse 分支名', ['rev-parse', '--abbrev-ref', 'HEAD'])
await bench('rev-list ahead/behind', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
await bench('branch --list 本地分支', ['branch', '--list', '--format=%(refname:short)'])

// 零 spawn：直接读 .git/HEAD + packed-refs
const t = Date.now()
let okCount = 0
for (const d of dirs) {
  try {
    const head = readFileSync(join(d, '.git', 'HEAD'), 'utf8')
    if (head) okCount++
  } catch { /* 非 git 目录 */ }
}
console.log('node 直读 .git/HEAD'.padEnd(30), '串行总耗时:', Date.now() - t + 'ms', '命中:', okCount + '/' + dirs.length)
