// 配置加载与 workspace 根定位
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const CONFIG_FILENAME = 'devctl.config.json'
export const STATE_DIRNAME = '.devctl'

export const DEFAULT_CONFIG = {
  root: '.',
  exclude: [
    '**/node_modules',
    '**/target',
    '**/dist',
    '**/.git',
    '**/.deploy',
    '**/.vscode',
    '**/.devctl',
    'archives',
    'deprecated',
    'handoff',
    'sql',
  ],
  extraRoots: [],
  maxDepth: 2,
  toolchain: {
    javaHome: process.env.JAVA_HOME || '',
    mavenHome: '',
    nvmRoot: '',
    // 老 webpack4 / VuePress 前端绑定的 Node 版本；为空则不绑定
    defaultNode: '',
  },
  defaults: {
    // Node 项目：dev / build 的候选脚本名，按顺序取第一个存在的
    devScripts: ['dev', 'localdev', 'local'],
    buildScripts: ['build:prod', 'build:production', 'build'],
    // Maven 项目
    mavenBuild: ['clean', 'package', '-DskipTests'],
    mavenInstall: ['clean', 'install', '-DskipTests'],
  },
  overrides: {},
  // 显式声明的项目：由探测器 custom 读取，支持任何语言/工具链
  custom: [],
  // 后端调试（JDWP）默认端口
  debug: { port: 5005 },
  limits: {
    maxConcurrentBuilds: 2,
    logTailLines: 200,
  },
}

/** 从 start 向上找含 devctl.config.json 的目录 */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadConfig(root) {
  const file = join(root, CONFIG_FILENAME)
  let raw = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`配置文件解析失败 ${file}: ${e.message}`)
    }
  }
  // 空字符串等同于「没写」，表示走自动推断（例如 javaHome 留空则读环境变量）
  const nonEmpty = (obj) =>
    Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== '' && v != null))
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    toolchain: { ...DEFAULT_CONFIG.toolchain, ...nonEmpty(raw.toolchain) },
    defaults: { ...DEFAULT_CONFIG.defaults, ...nonEmpty(raw.defaults) },
    limits: { ...DEFAULT_CONFIG.limits, ...nonEmpty(raw.limits) },
    exclude: Array.isArray(raw.exclude) ? raw.exclude : DEFAULT_CONFIG.exclude,
    extraRoots: Array.isArray(raw.extraRoots) ? raw.extraRoots : [],
    overrides: raw.overrides || {},
    // 交互式剔除/选入状态（与手写配置分离，见 prefsPath）
    prefs: loadPrefs(root),
  }
}

/** 运行态目录 */
export function statePaths(root) {
  const base = join(root, STATE_DIRNAME)
  return {
    base,
    runs: join(base, 'runs'),
    logs: join(base, 'logs'),
    manifest: join(base, 'manifest.json'),
    prefs: join(base, 'prefs.json'),
  }
}

/* ---------------------- 剔除 / 选入 偏好 ---------------------- */

const EMPTY_PREFS = { excluded: [], included: [] }

/**
 * 交互式偏好：用户通过 CLI 或面板做的「剔除 / 选入」。
 * 与 devctl.config.json 的 exclude 分开存，避免改写用户手写的基线配置。
 */
export function loadPrefs(root) {
  const file = statePaths(root).prefs
  if (!existsSync(file)) return { excluded: [], included: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((x) => typeof x === 'string') : [],
      included: Array.isArray(raw.included) ? raw.included.filter((x) => typeof x === 'string') : [],
    }
  } catch {
    return { excluded: [], included: [] }
  }
}

export function savePrefs(root, prefs) {
  const paths = statePaths(root)
  if (!existsSync(paths.base)) mkdirSync(paths.base, { recursive: true })
  const next = {
    excluded: [...new Set((prefs && prefs.excluded) || [])].sort(),
    included: [...new Set((prefs && prefs.included) || [])].sort(),
  }
  writeFileSync(paths.prefs, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 纯函数：算出应用偏好后的最终状态，便于命令打印与测试 */
export function togglePrefs(prefs, id, mode) {
  const excluded = new Set((prefs && prefs.excluded) || [])
  const included = new Set((prefs && prefs.included) || [])
  if (mode === 'exclude') {
    excluded.add(id)
    included.delete(id)
  } else {
    included.add(id)
    excluded.delete(id)
  }
  return { excluded: [...excluded], included: [...included] }
}

export { EMPTY_PREFS }
