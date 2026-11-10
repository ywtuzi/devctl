// 工具链解析：Node（nvm）/ Java / Maven，全部走绝对路径，不依赖 PATH
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVersion } from './util.js'

/** 扫描 nvm 版本目录，校验 node.exe 是否存在（损坏目录要跳过） */
export function listNodeVersions(nvmRoot) {
  if (!nvmRoot || !existsSync(nvmRoot)) return []
  let names = []
  try {
    names = readdirSync(nvmRoot)
  } catch {
    return []
  }
  return names
    .filter((n) => /^v\d/.test(n))
    .map((n) => {
      const dir = join(nvmRoot, n)
      const nodeExe = join(dir, 'node.exe')
      const npmCli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      const valid = existsSync(nodeExe)
      return {
        version: n.replace(/^v/, ''),
        dir,
        nodeExe,
        npmCli,
        valid,
        hasNpm: existsSync(npmCli),
      }
    })
    .sort((a, b) => cmpVersion(b.version, a.version))
}

/** 解析目标 Node 版本；返回 null 表示用当前进程的 node */
export function resolveNode(nvmRoot, wanted) {
  if (!wanted) return null
  const versions = listNodeVersions(nvmRoot)
  const exact = versions.find((v) => v.valid && v.version === wanted)
  if (exact) return { ...exact, requested: wanted, fallback: false }

  // 同主版本兜底（16.13.0 请求不到时找任意 16.x）
  const major = String(wanted).split('.')[0]
  const sameMajor = versions.find((v) => v.valid && v.version.split('.')[0] === major)
  if (sameMajor) return { ...sameMajor, requested: wanted, fallback: true }

  return { valid: false, requested: wanted, fallback: true, missing: true }
}

export function resolveJava(javaHome) {
  if (!javaHome) return { ok: false, home: null, reason: 'JAVA_HOME 未配置' }
  const javaExe = join(javaHome, 'bin', 'java.exe')
  const javacExe = join(javaHome, 'bin', 'javac.exe')
  const ok = existsSync(javaExe)
  return {
    ok,
    home: javaHome,
    javaExe,
    javacExe,
    hasJavac: existsSync(javacExe),
    reason: ok ? null : 'bin/java.exe 不存在',
  }
}

export function resolveMaven(mavenHome) {
  if (!mavenHome) return { ok: false, cmd: 'mvn', home: null }
  const cmd = join(mavenHome, 'bin', 'mvn.cmd')
  return { ok: existsSync(cmd), cmd: existsSync(cmd) ? cmd : 'mvn', home: mavenHome }
}

/**
 * 组装子进程环境：
 * - Node 绑定版本时，把该版本目录前置到 PATH，保证 scripts 里嵌套调用的 node 也命中
 * - Maven 项目覆写 JAVA_HOME 并前置 bin
 */
export function buildEnv({ baseEnv = process.env, nodeInfo = null, javaInfo = null }) {
  const env = { ...baseEnv }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  const parts = []

  if (nodeInfo && nodeInfo.valid && nodeInfo.dir) parts.push(nodeInfo.dir)
  if (javaInfo && javaInfo.ok) {
    env.JAVA_HOME = javaInfo.home
    parts.push(join(javaInfo.home, 'bin'))
  }
  if (parts.length) {
    env[pathKey] = [...parts, env[pathKey] || ''].filter(Boolean).join(';')
  }
  return env
}
