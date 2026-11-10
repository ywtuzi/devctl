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

export function detect(dir) {
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
      const mp = join(dir, m, 'pom.xml')
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
  tasks.build = {
    name: 'build',
    kind: 'build',
    type: 'mvn',
    args: ['clean', 'package', '-DskipTests'],
    encoding: 'gbk',
  }
  tasks.install = {
    name: 'install',
    kind: 'build',
    type: 'mvn',
    args: ['clean', 'install', '-DskipTests'],
    encoding: 'gbk',
  }

  return {
    kind: 'maven',
    type: 'maven',
    packaging,
    javaVersion,
    modules,
    runModule,
    runnable,
    tasks,
    warnings,
  }
}
