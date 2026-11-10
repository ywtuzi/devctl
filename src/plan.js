// 预演：算出「将要执行的命令」但不执行。
// 独立成模块，供 CLI（bin/plan.js）与 DSH 宿主（面板二次确认）共用同一份逻辑。
import { loadConfig } from './config.js'
import { scanDetailed } from './scan.js'
import { buildExecSpec, withModuleArgs, withProfileArgs } from './runner.js'
import { findFreePort, isPortFree } from './ports.js'

// 「环境类」profile：release-product / release-dev / release-local …
// gen-mappers 这类代码生成 profile 也是合法 profile，但不是环境，
// 混进环境选择器只会被误点，所以只把环境类的交给 UI 展示。
const ENV_PROFILE_RE = /^(release|prod|product|dev|develop|test|local|stage|uat|sit|pre|online)/i

function displayOf(project, task, port, module, profile) {
  if (task.type === 'npm') {
    return `npm run ${task.script}${port && project.type !== 'vue-cli' ? ` -- --port ${port}` : ''}`
  }
  if (task.type === 'shell') return task.command
  let mvnArgs = [...task.args]
  if (task.kind !== 'run') {
    if (profile) mvnArgs = withProfileArgs(mvnArgs, profile)
    if (module) mvnArgs = withModuleArgs(mvnArgs, module)
  }
  return `mvn ${mvnArgs.join(' ')}`
}

/**
 * @param {object} opts
 * @param {string} opts.root          工作区根
 * @param {object} [opts.config]      已加载的配置（省略则内部加载）
 * @param {string} opts.id            项目 ID
 * @param {string} [opts.taskName]    任务名（省略取默认 run/build）
 * @param {number} [opts.port]        指定端口
 * @param {string} [opts.node]        临时指定 Node 版本
 * @param {string} [opts.module]      只构建/发布这个 Maven 模块（省略则整个 reactor）
 * @param {string} [opts.profile]     激活的 Maven profile（正式包/测试包等）
 * @param {Array}  [opts.projects]    复用已扫描好的项目列表（避免重复扫描）
 */
export async function buildPlan(opts) {
  const { root, id, taskName, port, node, projects, module, profile } = opts
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

  // 单模块模式：只有 pom 里真实声明过的模块才收，避免手滑写成不存在的目录
  const modules = project.modules || []
  let chosenModule = null
  if (module) {
    if (!modules.includes(module)) {
      throw new Error(`项目 "${id}" 没有模块 "${module}"；可用: ${modules.join(', ') || '(无)'}`)
    }
    chosenModule = module
  }

  // 环境：-P 只能选 pom 里声明过的 profile，拼错会让整条命令白跑
  const profiles = project.profiles || []
  let chosenProfile = null
  if (profile) {
    if (!profiles.includes(profile)) {
      throw new Error(`项目 "${id}" 没有 profile "${profile}"；可用: ${profiles.join(', ') || '(无)'}`)
    }
    chosenProfile = profile
  }

  const spec = buildExecSpec({
    project,
    task,
    config,
    port: chosenPort,
    module: chosenModule,
    profile: chosenProfile,
  })
  const warnings = [...(project.warnings || []), ...(spec.warnings || [])]

  // 范围与环境都写进提示：多模块仓最容易误解成「只发这一个」
  const parts = []
  if (chosenModule) {
    parts.push(`${task.section === 'release' ? '只发布' : '只构建'} ${chosenModule}（同仓其它模块不动）`)
  }
  if (chosenProfile) parts.push(`激活 profile ${chosenProfile}`)
  if (task.note) parts.push(task.note)
  const note = parts.length ? parts.join('；') : null

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
    // 展示分组：release = 对外发布（deploy），其余按执行语义归类
    section: task.section || (task.kind === 'build' ? 'build' : 'run'),
    note,
    version: project.version || null,
    // 多模块仓：让调用方能在「全部模块 / 单个模块」之间选
    modules,
    module: chosenModule,
    // 环境：pom 里声明的 profile 列表 + 当前选中的那个
    profiles,
    envProfiles: profiles.filter((p) => ENV_PROFILE_RE.test(p)),
    profile: chosenProfile,
    type: task.type,
    debug: Boolean(task.debug),
    debugPort,
    display: displayOf(project, task, chosenPort, chosenModule, chosenProfile),
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
