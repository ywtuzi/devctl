// 探测器注册表
//
// 核心扫描器只认这份契约，不认识任何具体生态：
//
//   export const id = 'maven'                 // 唯一标识
//   export const fallback = true              // 可选：只在没有其它探测器命中时运行
//   export function probe(dir, ctx): boolean  // 便宜的「这目录像不像我的项目」
//   export function detect(dir, ctx): facet | null
//   export function extraProjects(ctx): project[]   // 可选：贡献目录扫描之外的项目
//
// 新增一种生态 = 新增一个文件 + 在底部注册，不改 scan / runner / CLI / 面板。
// 第三方探测器也可以在启动时调用 register() 注入。
import * as maven from './maven.js'
import * as node from './node.js'
import * as marker from './marker.js'
import * as custom from './custom.js'

const detectors = []

export function register(detector) {
  if (!detector || typeof detector.id !== 'string' || typeof detector.detect !== 'function') {
    throw new Error('探测器必须提供字符串 id 与 detect()')
  }
  if (detectors.some((d) => d.id === detector.id)) {
    throw new Error(`探测器 id 重复: ${detector.id}`)
  }
  detectors.push(detector)
  return () => {
    const i = detectors.indexOf(detector)
    if (i >= 0) detectors.splice(i, 1)
  }
}

export function list() {
  return [...detectors]
}

function runDetector(d, dir, ctx) {
  try {
    return d.detect(dir, ctx) || null
  } catch (e) {
    // 单个探测器炸掉不应该让整个扫描失败，而是把这个项目的错误暴露出来
    return {
      kind: d.id,
      type: d.id,
      tasks: {},
      runnable: false,
      warnings: [`探测器 ${d.id} 执行失败: ${e.message}`],
    }
  }
}

/** 目录 → facets。非兜底探测器都不命中时才跑兜底探测器。 */
export function detectFacets(dir, ctx) {
  const facets = []
  for (const d of detectors) {
    if (d.fallback) continue
    const f = runDetector(d, dir, ctx)
    if (f) facets.push(f)
  }
  if (!facets.length) {
    for (const d of detectors) {
      if (!d.fallback) continue
      const f = runDetector(d, dir, ctx)
      if (f) facets.push(f)
    }
  }
  return facets
}

/** 便宜的「这个目录是不是项目」，决定扫描时是否继续向下递归 */
export function hasBuildFile(dir, ctx) {
  return detectors.some((d) => {
    try {
      return typeof d.probe === 'function'
        ? Boolean(d.probe(dir, ctx))
        : Boolean(d.detect(dir, ctx))
    } catch {
      return false
    }
  })
}

/**
 * 是否被「强探测器」认领。
 * 强探测器命中 → 该目录独占，扫描不再向下（Maven 子模块不能被当成独立项目）。
 * 弱探测器（如只认标记文件的 marker）→ 仍继续向下，以免吞掉嵌套子项目。
 */
export function hasStrongBuildFile(dir, ctx) {
  return detectors.some((d) => {
    if (d.weak) return false
    try {
      return typeof d.probe === 'function'
        ? Boolean(d.probe(dir, ctx))
        : Boolean(d.detect(dir, ctx))
    } catch {
      return false
    }
  })
}

/** 收集探测器贡献的、不在目录扫描范围内的项目 */
export function collectExtraProjects(ctx) {
  const out = []
  for (const d of detectors) {
    if (typeof d.extraProjects !== 'function') continue
    try {
      const list = d.extraProjects(ctx)
      if (Array.isArray(list)) out.push(...list)
    } catch (e) {
      out.push({
        id: `detector:${d.id}`,
        displayName: `探测器 ${d.id}`,
        packageName: null,
        absPath: ctx.root,
        kind: 'custom',
        type: d.id,
        facets: [],
        tasks: {},
        runnable: false,
        warnings: [`探测器 ${d.id} 贡献项目失败: ${e.message}`],
      })
    }
  }
  return out
}

/* --------------------------- 内置探测器 --------------------------- */

register(maven)
register(node)
register(marker)
register(custom)
