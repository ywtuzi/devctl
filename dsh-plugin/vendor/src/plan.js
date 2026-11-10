// 预演：算出「将要执行的命令」但不执行。
// 独立成模块，供 CLI（bin/plan.js）与 DSH 宿主（面板二次确认）共用同一份逻辑。
import { loadConfig } from './config.js'
import { scanDetailed } from './scan.js'
import { buildExecSpec } from './runner.js'
import { findFreePort, isPortFree } from './ports.js'

function displayOf(project, task, port) {
  if (task.type === 'npm') {
    return `npm run ${task.script}${port && project.type !== 'vue-cli' ? ` -- --port ${port}` : ''}`
  }
  if (task.type === 'shell') return task.command
  return `mvn ${task.args.join(' ')}`
}

/**
 * @param {object} opts
 * @param {string} opts.root          工作区根
 * @param {object} [opts.config]      已加载的配置（省略则内部加载）
 * @param {string} opts.id            项目 ID
 * @param {string} [opts.taskName]    任务名（省略取默认 run/build）
 * @param {number} [opts.port]        指定端口
 * @param {string} [opts.node]        临时指定 Node 版本
 * @param {Array}  [opts.projects]    复用已扫描好的项目列表（避免重复扫描）
 */
export async function buildPlan(opts) {
  const { root, id, taskName, port, node, projects } = opts
  const config = opts.config || loadConfig(root)

  const list = projects || scanDetailed(root, config).projects
  const project = list.find((p) => p.id === id)
  if (!project) throw new Error(`找不到项目 "${id}"`)
  if (node) project.node = node

  const entries = Object.entries(project.tasks || {})
  const firstOf = (kind) => entries.find(([, t]) => t.kind === kind)
  const name = taskName || (firstOf('run') || firstOf('build') || entries[0] || [])[0]
  if (!name) throw new Error(`项目 "${id}" 没有可用任务`)

  const task = project.tasks[name]
  if (!task) {
    throw new Error(`项目 "${id}" 没有任务 "${name}"；可用: ${Object.keys(project.tasks).join(', ')}`)
  }

  // 端口选择与真实执行保持一致
  let chosenPort = port
  if (!chosenPort && task.kind !== 'build' && project.basePort && project.type === 'vue-cli') {
    chosenPort = await findFreePort(project.basePort)
  }

  const spec = buildExecSpec({ project, task, config, port: chosenPort })
  const warnings = [...(project.warnings || []), ...(spec.warnings || [])]

  let debugPort = null
  if (task.debug) {
    debugPort = project.debugPort || (config.debug && config.debug.port) || 5005
    if (!(await isPortFree(debugPort))) {
      warnings.push(`调试端口 ${debugPort} 已被占用，先释放它再启动`)
    }
  }

  return {
    projectId: project.id,
    task: name,
    label: task.label || name,
    kind: task.kind,
    type: task.type,
    debug: Boolean(task.debug),
    debugPort,
    display: displayOf(project, task, chosenPort),
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
    nodeVersion: spec.nodeVersion,
    javaHome: task.type === 'mvn' ? config.toolchain.javaHome || null : null,
    port: chosenPort || null,
    url: chosenPort ? `http://localhost:${chosenPort}` : null,
    encoding: spec.encoding,
    warnings,
  }
}
