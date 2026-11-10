#!/usr/bin/env node
// 预演入口（CLI）：解析出「将要执行的命令」但不执行。
// 用法: node plan.js <项目ID> [任务名] --root <工作区> [--port N] [--node V]
import { findRoot } from '../src/config.js'
import { buildPlan } from '../src/plan.js'

const argv = process.argv.slice(2)
const opts = { _: [] }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--root') opts.root = argv[++i]
  else if (a === '--port') opts.port = Number(argv[++i])
  else if (a === '--node') opts.node = argv[++i]
  else if (a.startsWith('--root=')) opts.root = a.slice(7)
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7))
  else if (a.startsWith('--node=')) opts.node = a.slice(7)
  else if (!a.startsWith('-')) opts._.push(a)
}

const root = opts.root || findRoot(process.cwd())
if (!root) {
  console.error('未找到 devctl.config.json')
  process.exit(2)
}

const id = opts._[0]
if (!id) {
  console.error('用法: plan.js <项目ID> [任务名]')
  process.exit(2)
}

try {
  const plan = await buildPlan({
    root,
    id,
    taskName: opts._[1],
    port: opts.port,
    node: opts.node,
  })
  console.log(JSON.stringify(plan, null, 2))
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
