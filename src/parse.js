// 项目识别：Maven / Node 两类构建系统的解析
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './util.js'

const re = (s, r) => {
  const m = String(s).match(r)
  return m ? m[1].trim() : null
}

/* ------------------------------ Maven ------------------------------ */

export function parseMaven(absPath) {
  const pom = join(absPath, 'pom.xml')
  if (!existsSync(pom)) return null
  const xml = readFileSync(pom, 'utf8')

  const packaging = re(xml, /<packaging>\s*([^<]+?)\s*<\/packaging>/) || 'jar'
  const javaVersion =
    re(xml, /<java\.version>\s*([^<]+?)\s*<\/java\.version>/) ||
    re(xml, /<maven\.compiler\.source>\s*([^<]+?)\s*<\/maven\.compiler\.source>/) ||
    re(xml, /<maven\.compiler\.release>\s*([^<]+?)\s*<\/maven\.compiler\.release>/) ||
    null

  const modules = [...xml.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1].trim())

  // 找带 spring-boot-maven-plugin 的模块 → 可运行模块
  // 规则：pluginManagement 里的声明不算；packaging=pom 的聚合根自身不可运行
  //      （聚合根上的 <build><plugins> 会被子模块继承，直接看字符串会误判）
  const stripPM = (s) => s.replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/g, '')
  let runModule = null
  if (packaging !== 'pom' && stripPM(xml).includes('spring-boot-maven-plugin')) {
    runModule = '.'
  }
  if (!runModule) {
    for (const m of modules) {
      const mp = join(absPath, m, 'pom.xml')
      if (!existsSync(mp)) continue
      try {
        if (stripPM(readFileSync(mp, 'utf8')).includes('spring-boot-maven-plugin')) {
          runModule = m
          break
        }
      } catch {
        /* 忽略不可读模块 */
      }
    }
  }

  const warnings = []
  const runnable = Boolean(runModule)
  if (!runnable) {
    warnings.push(
      modules.length
        ? '未找到 spring-boot-maven-plugin 模块；只能 build/install'
        : '无 spring-boot-maven-plugin；只能 build/install'
    )
  }

  const tasks = {}
  if (runnable) {
    const runArgs =
      runModule === '.' ? ['spring-boot:run'] : ['-pl', runModule, '-am', 'spring-boot:run']
    tasks.run = {
      name: 'run',
      label: `启动${runModule === '.' ? '' : ` (${runModule})`}`,
      kind: 'run',
      type: 'mvn',
      args: [...runArgs],
      encoding: 'gbk',
    }
    // 调试：与 run 同一条启动命令，额外把 JDWP 参数交给 fork 出来的 JVM。
    // 具体端口在执行时才确定（见 runner.buildExecSpec），这里只打标记。
    tasks.debug = {
      name: 'debug',
      label: `调试${runModule === '.' ? '' : ` (${runModule})`}`,
      kind: 'run',
      type: 'mvn',
      debug: true,
      args: [...runArgs],
      encoding: 'gbk',
    }
  }
  tasks.build = {
    name: 'build',
    label: '打包 (package)',
    kind: 'build',
    type: 'mvn',
    args: ['clean', 'package', '-DskipTests'],
    encoding: 'gbk',
  }
  tasks.install = {
    name: 'install',
    label: '安装到本地仓 (install)',
    kind: 'build',
    type: 'mvn',
    args: ['clean', 'install', '-DskipTests'],
    encoding: 'gbk',
  }

  return {
    kind: 'maven',
    packaging,
    javaVersion,
    modules,
    runModule,
    runnable,
    tasks,
    warnings,
  }
}

/* ------------------------------- Node ------------------------------- */

function detectPort(absPath) {
  const candidates = [
    ['vue.config.js', /port\s*:\s*(\d+)/],
    ['vue.config.cjs', /port\s*:\s*(\d+)/],
    ['vite.config.js', /port\s*:\s*(\d+)/],
    ['vite.config.ts', /port\s*:\s*(\d+)/],
    ['vite.config.mjs', /port\s*:\s*(\d+)/],
  ]
  for (const [file, pattern] of candidates) {
    const p = join(absPath, file)
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

export function parseNode(absPath, config) {
  const pkgPath = join(absPath, 'package.json')
  if (!existsSync(pkgPath)) return null
  let pkg
  try {
    pkg = readJson(pkgPath)
  } catch (e) {
    return {
      kind: 'node',
      name: null,
      scripts: {},
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
  const cliMajor = cliService ? parseInt(String(cliService).replace(/[^0-9.]/g, '').split('.')[0], 10) : null
  const isUni = Object.values(scripts).some((s) => /(^|&&|&|\s)uni(\s|$)/.test(String(s)))
  const isVuepress = /vuepress/.test(scriptValues) || Boolean(deps.vuepress)
  const isVite = Boolean(deps.vite) || scriptNames.some((n) => /vite/.test(n) && /build|dev|serve/.test(n))

  let type = 'node'
  if (isUni) type = 'uni-app'
  else if (isVuepress) type = 'vuepress'
  else if (cliMajor !== null) type = 'vue-cli'
  else if (isVite) type = 'vite'
  else if (pkg.type === 'module') type = 'node-esm'

  // Node 版本绑定：webpack4 系（cli-service<=4）、uni-app、vuepress 需要老版本
  const legacy = (cliMajor !== null && cliMajor <= 4) || isUni || isVuepress
  const node = legacy && config.toolchain.defaultNode ? config.toolchain.defaultNode : null

  // 端口
  const { port, source } = detectPort(absPath)

  // 脚本分类：build 优先（docs:build 也算），其次 dev/serve/start/local
  const classify = (n) => {
    if (/build/i.test(n)) return 'build'
    if (/(^|:)(dev|serve|start|local)/i.test(n)) return 'run'
    return 'other'
  }
  const runs = scriptNames.filter((n) => classify(n) === 'run')
  const builds = scriptNames.filter((n) => classify(n) === 'build')

  // 选默认 dev / build 脚本。
  // `*-custom` 这类脚本需要额外的 -p 参数（如 `uni -p`），不能当默认，否则一点就失败。
  const devScript =
    config.defaults.devScripts.find((n) => runs.includes(n)) ||
    runs.find((n) => !/[-:]custom$/i.test(n)) ||
    runs[0] ||
    null
  const buildScript =
    config.defaults.buildScripts.find((n) => builds.includes(n)) ||
    builds.find((n) => !/[-:]custom$/i.test(n)) ||
    builds[0] ||
    null

  // uni-app 这类脚本矩阵：dev:h5 / build:mp-weixin → 人类可读标签
  const PLATFORM_LABELS = {
    custom: '自定义',
    h5: 'H5',
    'h5:ssr': 'H5 (SSR)',
    'mp-weixin': '微信小程序',
    'mp-alipay': '支付宝小程序',
    'mp-baidu': '百度小程序',
    'mp-qq': 'QQ 小程序',
    'mp-toutiao': '抖音小程序',
    'mp-lark': '飞书小程序',
    'mp-kuaishou': '快手小程序',
    'mp-jd': '京东小程序',
    'mp-xhs': '小红书小程序',
    'mp-harmony': '鸿蒙',
    'quickapp-webview': '快应用',
    'quickapp-webview-huawei': '快应用 (华为)',
    'quickapp-webview-union': '快应用 (联盟)',
  }
  const friendlyLabel = (name) => {
    const m = /^(dev|build):(.+)$/.exec(name)
    if (!m) return null
    const platform = PLATFORM_LABELS[m[2]] || m[2]
    return `${platform} · ${m[1] === 'build' ? '构建' : '开发'}`
  }

  // 任务键统一用「脚本名」，保证 `devctl run uni-app dev:mp-weixin` 这类调用自然可达。
  // 只有当默认脚本本身就在 defaults 名单里（dev / build:prod …）时才用 dev / build 短名，
  // 否则会出现「键叫 dev、真实脚本叫 dev:h5，用真名反而找不到」的情况。
  const devKey = devScript && config.defaults.devScripts.includes(devScript) ? 'dev' : devScript
  const buildKey =
    buildScript && config.defaults.buildScripts.includes(buildScript) ? 'build' : buildScript

  const tasks = {}
  if (devScript) {
    tasks[devKey] = {
      name: devKey,
      label: friendlyLabel(devScript) || `启动 (npm run ${devScript})`,
      kind: 'run',
      type: 'npm',
      script: devScript,
      encoding: 'utf8',
    }
  }
  if (buildScript) {
    tasks[buildKey] = {
      name: buildKey,
      label: friendlyLabel(buildScript) || `构建 (npm run ${buildScript})`,
      kind: 'build',
      type: 'npm',
      script: buildScript,
      encoding: 'utf8',
    }
  }

  // 其余脚本作为可选任务（uni-app 的平台矩阵、文档站的 docs:*、工具仓的 test 等）
  const used = new Set([devScript, buildScript])
  for (const name of scriptNames) {
    if (used.has(name)) continue
    const k = classify(name)
    const key = tasks[name] ? `script:${name}` : name
    const base = { name, type: 'npm', script: name, encoding: 'utf8' }
    const friendly = friendlyLabel(name)
    if (k === 'build') {
      tasks[key] = { ...base, label: friendly || `构建 (${name})`, kind: 'build', group: '构建' }
    } else if (k === 'run') {
      tasks[key] = { ...base, label: friendly || `启动 (${name})`, kind: 'run', group: '启动' }
    } else {
      tasks[key] = { ...base, label: name, kind: 'other', group: '其他' }
    }
  }

  // 风险提示
  const buildValues = scriptNames.filter((n) => /^build/.test(n)).map((n) => String(scripts[n]))
  if (buildValues.length && !buildValues.some((v) => v.includes('openssl-legacy-provider')) && legacy) {
    warnings.push('所有 build 脚本均未带 --openssl-legacy-provider；Node>=17 上可能 ERR_OSSL_EVP_UNSUPPORTED')
  }
  if (!existsSync(join(absPath, 'node_modules'))) {
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

/* --------------------------- 目录内构建文件 --------------------------- */

export function detectFacets(absPath, config) {
  const facets = []
  const maven = parseMaven(absPath)
  if (maven) facets.push(maven)
  const node = parseNode(absPath, config)
  if (node) facets.push(node)
  return facets
}

export function hasBuildFile(absPath) {
  return existsSync(join(absPath, 'pom.xml')) || existsSync(join(absPath, 'package.json'))
}
