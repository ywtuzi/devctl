// 通用工具：路径、排除匹配、终端对齐
import { existsSync, readFileSync } from 'node:fs'

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 排除匹配。返回命中的规则（未命中返回 null），支持三种写法：
 *   "node_modules"           → 任一路径段等于它
 *   "CSEI/elevator-iot-server" → 精确路径或前缀
 *   "**\/target"             → 任一路径段等于 target
 */
export function matchExcludedBy(relPosix, patterns = []) {
  const posix = String(relPosix).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!posix) return null
  const segs = posix.split('/')

  for (const raw of patterns) {
    let p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '')
    if (!p) continue

    // **/xxx → 段匹配
    if (p.startsWith('**/')) {
      const needle = p.slice(3)
      if (!needle.includes('/') && segs.includes(needle)) return raw
      if (posix === needle || posix.endsWith('/' + needle)) return raw
      continue
    }
    // 含通配符（除 **/ 外的简单情形）
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
      if (segs.some((s) => re.test(s))) return raw
      continue
    }
    // 含 / → 前缀匹配
    if (p.includes('/')) {
      if (posix === p || posix.startsWith(p + '/')) return raw
      continue
    }
    // 裸名字 → 段匹配
    if (segs.includes(p)) return raw
  }
  return null
}

/** 是否被排除 */
export function isExcluded(relPosix, patterns = []) {
  return matchExcludedBy(relPosix, patterns) !== null
}

/** CJK 等宽字符算 2 列 */
export function displayWidth(str) {
  let w = 0
  for (const ch of String(str)) {
    const c = ch.codePointAt(0)
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
        ? 2
        : 1
  }
  return w
}

export function padEnd(str, width) {
  const s = String(str ?? '')
  const d = width - displayWidth(s)
  return d > 0 ? s + ' '.repeat(d) : s
}

export function padStart(str, width) {
  const s = String(str ?? '')
  const d = width - displayWidth(s)
  return d > 0 ? ' '.repeat(d) + s : s
}

/** 比较 semver，简单三段数字 */
export function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { existsSync }
