// Node / npm 探测器：从 package.json 的 scripts 推导任务
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from '../util.js'

export const id = 'node'

export function probe(dir) {
  return existsSync(join(dir, 'package.json'))
}

function detectPort(dir) {
  const candidates = [
    ['vue.config.js', /port\s*:\s*(\d+)/],
    ['vue.config.cjs', /port\s*:\s*(\d+)/],
    ['vite.config.js', /port\s*:\s*(\d+)/],
    ['vite.config.ts', /port\s*:\s*(\d+)/],
    ['vite.config.mjs', /port\s*:\s*(\d+)/],
  ]
  for (const [file, pattern] of candidates) {
    const p = join(dir, file)
    if (!existsSync(p)) continue
    try {
      const txt = readFileSync(p, 'utf8')
      const m = txt.match(pattern)
      if (m) return { port: Number(m[1]), source: file }
    } catch {
      /* ignore */
    }
  }
  return { port: null, source: null }
}

// 脚本名里带平台信息时（uni-app 的 dev:h5 / build:mp-weixin），
// 只解析成结构化字段，**不做翻译**——中文名由展示层（面板 locale）提供。
// 这样新增生态时不需要在探测器里维护一份文案表。
const parsePlatform = (name) => {
  const m = /^(dev|build):(.+)$/.exec(name)
  if (!m) return null
  return { action: m[1], platform: m[2] }
}

export function detect(dir, ctx) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  const config = (ctx && ctx.config) || {}

  let pkg
  try {
    pkg = readJson(pkgPath)
  } catch (e) {
    return {
      kind: 'node',
      type: 'node',
      name: null,
      scripts: [],
      tasks: {},
      runnable: false,
      warnings: [`package.json 解析失败: ${e.message}`],
    }
  }

  const scripts = pkg.scripts || {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const warnings = []
  const scriptNames = Object.keys(scripts)
  const scriptValues = Object.values(scripts).join('\n')

  // 类型判定
  const cliService = deps['@vue/cli-service'] || null
  const cliMajor = cliService
    ? parseInt(String(cliService).replace(/[^0-9.]/g, '').split('.')[0], 10)
    : null
  const isUni = Object.values(scripts).some((s) => /(^|&&|&|\s)uni(\s|$)/.test(String(s)))
  const isVuepress = /vuepress/.test(scriptValues) || Boolean(deps.vuepress)
  const isVite =
    Boolean(deps.vite) || scriptNames.some((n) => /vite/.test(n) && /build|dev|serve/.test(n))

  let type = 'node'
  if (isUni) type = 'uni-app'
  else if (isVuepress) type = 'vuepress'
  else if (cliMajor !== null) type = 'vue-cli'
  else if (isVite) type = 'vite'
  else if (pkg.type === 'module') type = 'node-esm'

  // Node 版本绑定：webpack4 系（cli-service<=4）、uni-app、vuepress 需要老版本
  const legacy = (cliMajor !== null && cliMajor <= 4) || isUni || isVuepress
  const defaultNode = config.toolchain && config.toolchain.defaultNode
  const node = legacy && defaultNode ? defaultNode : null

  const { port, source } = detectPort(dir)

  // 脚本分类：build 优先（docs:build 也算），其次 dev/serve/start/local
  const classify = (n) => {
    if (/build/i.test(n)) return 'build'
    if (/(^|:)(dev|serve|start|local)/i.test(n)) return 'run'
    return 'other'
  }
  const runs = scriptNames.filter((n) => classify(n) === 'run')
  const builds = scriptNames.filter((n) => classify(n) === 'build')

  const devScripts = (config.defaults && config.defaults.devScripts) || ['dev']
  const buildScripts = (config.defaults && config.defaults.buildScripts) || ['build']

  // `*-custom` 这类脚本需要额外的 -p 参数（如 `uni -p`），不能当默认，否则一点就失败
  const devScript =
    devScripts.find((n) => runs.includes(n)) ||
    runs.find((n) => !/[-:]custom$/i.test(n)) ||
    runs[0] ||
    null
  const buildScript =
    buildScripts.find((n) => builds.includes(n)) ||
    builds.find((n) => !/[-:]custom$/i.test(n)) ||
    builds[0] ||
    null

  // 任务键统一用「脚本名」，保证 `devctl run uni-app dev:mp-weixin` 这类调用自然可达。
  // 只有当默认脚本本身就在 defaults 名单里（dev / build:prod …）时才用 dev / build 短名。
  const devKey = devScript && devScripts.includes(devScript) ? 'dev' : devScript
  const buildKey = buildScript && buildScripts.includes(buildScript) ? 'build' : buildScript

  const tasks = {}
  if (devScript) {
    tasks[devKey] = {
      name: devKey,
      kind: 'run',
      type: 'npm',
      script: devScript,
      encoding: 'utf8',
      ...(parsePlatform(devScript) || {}),
    }
  }
  if (buildScript) {
    tasks[buildKey] = {
      name: buildKey,
      kind: 'build',
      type: 'npm',
      script: buildScript,
      encoding: 'utf8',
      ...(parsePlatform(buildScript) || {}),
    }
  }

  // 其余脚本作为可选任务（uni-app 的平台矩阵、文档站的 docs:*、工具仓的 test 等）
  const used = new Set([devScript, buildScript])
  for (const name of scriptNames) {
    if (used.has(name)) continue
    const k = classify(name)
    const key = tasks[name] ? `script:${name}` : name
    const base = {
      name,
      type: 'npm',
      script: name,
      encoding: 'utf8',
      ...(parsePlatform(name) || {}),
    }
    if (k === 'build') {
      tasks[key] = { ...base, kind: 'build', group: '构建' }
    } else if (k === 'run') {
      tasks[key] = { ...base, kind: 'run', group: '启动' }
    } else {
      tasks[key] = { ...base, kind: 'other', group: '其他' }
    }
  }

  // 风险提示
  const buildValues = scriptNames.filter((n) => /^build/.test(n)).map((n) => String(scripts[n]))
  if (
    buildValues.length &&
    !buildValues.some((v) => v.includes('openssl-legacy-provider')) &&
    legacy
  ) {
    warnings.push(
      '所有 build 脚本均未带 --openssl-legacy-provider；Node>=17 上可能 ERR_OSSL_EVP_UNSUPPORTED'
    )
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    warnings.push('node_modules 缺失，需先安装依赖')
  }

  const runnable = Object.values(tasks).some((t) => t.kind === 'run')

  return {
    kind: 'node',
    name: pkg.name || null,
    type,
    legacy,
    cliService,
    cliMajor,
    node,
    port,
    portSource: source,
    scripts: scriptNames,
    runnable,
    tasks,
    warnings,
  }
}
