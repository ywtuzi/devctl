#!/usr/bin/env node
// 预演入口：解析出「将要执行的命令」但不执行，供面板做二次确认展示。
// 用法: node plan.js <项目ID> [任务名] --root <工作区> [--port N] [--node V]
import { findRoot, loadConfig } from '../src/config.js'
import { scan } from '../src/scan.js'
import { buildExecSpec } from '../src/runner.js'
import { findFreePort, isPortFree } from '../src/ports.js'

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

function die(msg) {
  console.error(msg)
  process.exit(2)
}

const root = opts.root || findRoot(process.cwd())
if (!root) die('未找到 devctl.config.json')

const config = loadConfig(root)
const projects = scan(root, config)

const id = opts._[0]
if (!id) die('用法: plan.js <项目ID> [任务名]')
const project = projects.find((p) => p.id === id)
if (!project) die(`找不到项目 "${id}"`)
if (opts.node) project.node = opts.node

const taskEntries = Object.entries(project.tasks || {})
const firstOf = (kind) => taskEntries.find(([, t]) => t.kind === kind)
const taskName =
  opts._[1] || (firstOf('run') || firstOf('build') || taskEntries[0] || [])[0] || null
if (!taskName) die(`项目 "${id}" 没有可用任务`)

const task = project.tasks[taskName]
if (!task) {
  die(`项目 "${id}" 没有任务 "${taskName}"；可用: ${Object.keys(project.tasks).join(', ')}`)
}

// 与真实执行保持一致的端口选择逻辑
let port = opts.port
if (!port && task.kind !== 'build' && project.basePort && project.type === 'vue-cli') {
  port = await findFreePort(project.basePort)
}

const spec = buildExecSpec({ project, task, config, port })

const display =
  task.type === 'npm'
    ? `npm run ${task.script}${port && project.type !== 'vue-cli' ? ` -- --port ${port}` : ''}`
    : `mvn ${task.args.join(' ')}`

const warnings = [...(project.warnings || []), ...(spec.warnings || [])]

// 调试任务：把 JDWP 端口也报出来，并提示端口是否被占用
let debugPort = null
if (task.debug) {
  debugPort = project.debugPort || (config.debug && config.debug.port) || 5005
  if (!(await isPortFree(debugPort))) {
    warnings.push(`调试端口 ${debugPort} 已被占用，先释放它再启动`)
  }
}

console.log(
  JSON.stringify(
    {
      projectId: project.id,
      task: taskName,
      label: task.label || taskName,
      kind: task.kind,
      type: task.type,
      debug: Boolean(task.debug),
      debugPort,
      display,
      cmd: spec.cmd,
      args: spec.args,
      cwd: spec.cwd,
      nodeVersion: spec.nodeVersion,
      javaHome: task.type === 'mvn' ? config.toolchain.javaHome || null : null,
      port: port || null,
      url: port ? `http://localhost:${port}` : null,
      encoding: spec.encoding,
      warnings,
    },
    null,
    2
  )
)
