// Maven 探测器：spring-boot-maven-plugin 决定可运行模块
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const id = 'maven'

const re = (s, r) => {
  const m = String(s).match(r)
  return m ? m[1].trim() : null
}

export function probe(dir) {
  return existsSync(join(dir, 'pom.xml'))
}

/** <distributionManagement> 里的发布仓库；没配就是 null */
function readDeployRepos(xml) {
  const block = re(xml, /<distributionManagement>([\s\S]*?)<\/distributionManagement>/)
  if (!block) return null
  const urlOf = (tag) => {
    const m = block.match(new RegExp(`<${tag}>[\\s\\S]*?<url>\\s*([^<]+?)\\s*</url>`))
    return m ? m[1].trim() : null
  }
  // Maven 标准写法：<repository> 收 release，<snapshotRepository> 收 SNAPSHOT
  const releases = urlOf('repository')
  const snapshots = urlOf('snapshotRepository')
  return releases || snapshots ? { releases, snapshots } : null
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

/** pom 里声明的 profile id 列表（环境差异通常就藏在这里） */
const profileIds = (xml) =>
  [...String(xml).matchAll(/<profile>([\s\S]*?)<\/profile>/g)]
    .map((m) => re(m[1], /<id>\s*([^<]+?)\s*<\/id>/))
    .filter(Boolean)

export function detect(dir, ctx) {
  const pom = join(dir, 'pom.xml')
  if (!existsSync(pom)) return null
  const xml = readFileSync(pom, 'utf8')

  const packaging = re(xml, /<packaging>\s*([^<]+?)\s*<\/packaging>/) || 'jar'
  const javaVersion =
    re(xml, /<java\.version>\s*([^<]+?)\s*<\/java\.version>/) ||
    re(xml, /<maven\.compiler\.source>\s*([^<]+?)\s*<\/maven\.compiler\.source>/) ||
    re(xml, /<maven\.compiler\.release>\s*([^<]+?)\s*<\/maven\.compiler\.release>/) ||
    null

  const modules = [...xml.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1].trim())

  // 本工程版本：先摘掉 <parent>（它的 <version> 是父工程版本，不是本工程的）
  const noParent = xml.replace(/<parent>[\s\S]*?<\/parent>/g, '')
  const version = re(noParent, /<version>\s*([^<]+?)\s*<\/version>/)

  // 找带 spring-boot-maven-plugin 的模块 → 可运行模块
  // 规则：pluginManagement 里的声明不算；packaging=pom 的聚合根自身不可运行
  //      （聚合根上的 <build><plugins> 会被子模块继承，直接看字符串会误判）
  // 顺带把所有模块的 profile 收上来：正式包/测试包通常就是靠 -P 选的，
  // 只读根 pom 会漏掉只声明在子模块里的 release-dev / release-product。
  const stripPM = (s) => s.replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/g, '')
  const profiles = [...new Set(profileIds(xml))]
  let runModule = null
  if (packaging !== 'pom' && stripPM(xml).includes('spring-boot-maven-plugin')) {
    runModule = '.'
  }
  for (const m of modules) {
    const mp = join(dir, m, 'pom.xml')
    if (!existsSync(mp)) continue
    let moduleXml
    try {
      moduleXml = readFileSync(mp, 'utf8')
    } catch {
      continue // 忽略不可读模块
    }
    for (const id of profileIds(moduleXml)) {
      if (!profiles.includes(id)) profiles.push(id)
    }
    if (!runModule && stripPM(moduleXml).includes('spring-boot-maven-plugin')) {
      runModule = m
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
    // 不写死展示文案：只给机器可读事实（kind + detail），文案由展示层决定
    const detail = runModule === '.' ? null : runModule
    tasks.run = {
      name: 'run',
      kind: 'run',
      type: 'mvn',
      detail,
      args: [...runArgs],
      encoding: 'gbk',
    }
    // 调试：与 run 同一条启动命令，额外把 JDWP 参数交给 fork 出来的 JVM。
    // 具体端口在执行时才确定（见 runner.buildExecSpec），这里只打标记。
    tasks.debug = {
      name: 'debug',
      kind: 'run',
      type: 'mvn',
      debug: true,
      detail,
      args: [...runArgs],
      encoding: 'gbk',
    }
  }

  // 生命周期命令统一走 config.defaults，工程可以按自己的流水线改写
  const d = (ctx && ctx.config && ctx.config.defaults) || {}
  const goalArgs = (key, fallback) =>
    Array.isArray(d[key]) && d[key].length ? [...d[key]] : [...fallback]

  // section 只影响展示分组（build=构建维护 / release=对外发布），执行语义仍看 kind
  const lifecycle = (name, args, section) => {
    tasks[name] = {
      name,
      kind: 'build',
      type: 'mvn',
      section,
      args,
      encoding: 'gbk',
    }
  }

  lifecycle('build', goalArgs('mavenBuild', ['clean', 'package', '-DskipTests']), 'build')
  lifecycle('install', goalArgs('mavenInstall', ['clean', 'install', '-DskipTests']), 'build')
  lifecycle('test', goalArgs('mavenTest', ['test']), 'build')
  lifecycle('clean', goalArgs('mavenClean', ['clean']), 'build')
  lifecycle('deps', goalArgs('mavenDeps', ['dependency:tree']), 'build')

  // 发布：会写到 pom 里声明的私服，属于不可撤销操作，单独分组
  const repos = readDeployRepos(xml)
  const snapshot = Boolean(version && /-SNAPSHOT$/i.test(version))
  const deployUrl = repos ? (snapshot ? repos.snapshots : repos.releases) : null
  lifecycle('deploy', goalArgs('mavenDeploy', ['clean', 'deploy', '-DskipTests']), 'release')
  tasks.deploy.detail = deployUrl ? hostOf(deployUrl) : null
  tasks.deploy.note = repos
    ? deployUrl
      ? `发布到私服 ${deployUrl}`
      : `pom 只配了 ${snapshot ? 'releases' : 'snapshots'} 仓库，当前版本 ${version || '(未知)'} 没有匹配的发布地址`
    : 'pom 未配置 <distributionManagement>，deploy 会因找不到发布仓库而失败'

  return {
    kind: 'maven',
    type: 'maven',
    packaging,
    javaVersion,
    version,
    modules,
    profiles,
    runModule,
    runnable,
    deployRepos: repos,
    tasks,
    warnings,
  }
}
