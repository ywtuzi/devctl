#!/usr/bin/env node
// 前台运行入口：供 VS Code 扩展在集成终端里调用。
// 与 `devctl run` 的区别：不做 daemon 化，直接继承 stdio，保留彩色输出与 Ctrl+C。
import { spawn } from 'node:child_process'
import { findRoot, loadConfig } from '../src/config.js'
import { scan } from '../src/scan.js'
import { buildExecSpec } from '../src/runner.js'
import { findFreePort } from '../src/ports.js'

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
  console.error('✗ 未找到 devctl.config.json')
  process.exit(2)
}

const config = loadConfig(root)
const projects = scan(root, config)

const id = opts._[0]
if (!id) {
  console.error('用法: attach <项目ID> [任务名] [--root X] [--port N] [--node V]')
  process.exit(2)
}

const project = projects.find((p) => p.id === id)
if (!project) {
  console.error(`✗ 找不到项目 "${id}"`)
  process.exit(2)
}
if (opts.node) project.node = opts.node

const runTasks = Object.keys(project.tasks).filter((k) => project.tasks[k].kind !== 'build')
const taskName = opts._[1] || runTasks[0]
const task = project.tasks[taskName]
if (!task) {
  console.error(`✗ 项目 ${id} 没有任务 "${taskName}"；可用: ${Object.keys(project.tasks).join(', ')}`)
  process.exit(2)
}

let port = opts.port
if (!port && project.basePort && project.type === 'vue-cli') {
  port = await findFreePort(project.basePort)
}

const spec = buildExecSpec({ project, task, config, port })
const portNote = port ? ` · 端口 ${port}` : ''
process.stdout.write(`▶ ${project.id} ${taskName}  (node ${spec.nodeVersion}${portNote})\n\n`)

const child = spawn(spec.cmd, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  shell: spec.shell,
  stdio: 'inherit',
  windowsHide: false,
})

const forward = (sig) => {
  try {
    child.kill(sig)
  } catch {
    /* ignore */
  }
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

child.on('exit', (code) => {
  process.exit(code == null ? 1 : code)
})
