// 工作区扫描：识别项目、合并 overrides、应用剔除/选入偏好、端口冲突检查
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import { matchExcludedBy } from './util.js'
import { detectFacets, hasBuildFile } from './parse.js'

/**
 * 扫描一个根目录。
 * 规则：目录内若已有 pom.xml / package.json，即视为项目，**不再向下递归**
 *      （避免把 Maven 子模块识别成独立项目）。
 * 剔除来源有两层：config.exclude（手写基线）与 prefs（交互式），
 * prefs.included 可以覆盖两者。
 */
function walk(root, relDir, depth, config, ctx) {
  if (depth > config.maxDepth) return
  const absDir = relDir ? join(root, relDir) : root
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    const posix = rel.replace(/\\/g, '/')
    const abs = join(root, posix)

    const explicitlyIncluded = ctx.included.has(posix)
    const byPrefs = ctx.excluded.has(posix)
    const configMatch = explicitlyIncluded ? null : matchExcludedBy(posix, config.exclude)
    const skipped = !explicitlyIncluded && (byPrefs || configMatch)

    if (skipped) {
      // 被剔除的目录如果本身就是个项目，记录到「已剔除」里供 UI 选回。
      // 但基础设施类排除（裸名 / 通配，如 node_modules、devctl）不提示选入。
      if (hasBuildFile(abs)) {
        const suggestible = byPrefs || Boolean(configMatch && configMatch.includes('/'))
        if (suggestible) {
          ctx.skipped.push({ id: posix, reason: byPrefs ? 'user' : 'config', pattern: configMatch || null })
        }
      }
      continue
    }

    if (hasBuildFile(abs)) {
      // 视为项目，不递归
      ctx.out.push({ absPath: abs, relPath: posix })
    } else if (depth < config.maxDepth) {
      walk(root, posix, depth + 1, config, ctx)
    }
  }
}

function applyOverrides(project, override) {
  if (!override) return project
  if (override.displayName) project.displayName = override.displayName
  if (override.runnable !== undefined) {
    project.runnable = Boolean(override.runnable)
    // 显式声明不可运行 → 摘掉 run 任务，避免 UI 上多出点了就报错的按钮
    if (!project.runnable) {
      for (const [k, t] of Object.entries(project.tasks)) {
        if (t.kind === 'run') delete project.tasks[k]
      }
    }
  }
  if (override.node !== undefined) project.node = override.node || null
  if (override.basePort !== undefined) project.basePort = override.basePort
  if (override.debugPort !== undefined) project.debugPort = override.debugPort || null
  if (override.env) project.env = { ...(project.env || {}), ...override.env }
  if (override.installOnly) project.installOnly = true
  if (override.tasks) project.taskLabels = override.tasks
  return project
}

/**
 * 扫描并返回 { projects, excluded }。
 * excluded 是被剔除但确实像个项目的目录，供 UI 提供「选入」。
 */
export function scanDetailed(root, config) {
  const prefs = config.prefs || { excluded: [], included: [] }
  const ctx = {
    out: [],
    skipped: [],
    excluded: new Set(prefs.excluded || []),
    included: new Set(prefs.included || []),
  }

  walk(root, '', 0, config, ctx)

  // extraRoots：workspace 根之外的额外扫描根
  for (const extra of config.extraRoots || []) {
    const absExtra = resolvePath(extra)
    if (!existsSync(absExtra)) continue
    const sub = []
    walk(absExtra, '', 0, config, { ...ctx, out: sub, skipped: [] })
    for (const item of sub) {
      ctx.out.push({
        absPath: item.absPath,
        relPath: relative(root, item.absPath).replace(/\\/g, '/'),
      })
    }
  }

  const projects = []
  for (const cand of ctx.out) {
    const facets = detectFacets(cand.absPath, config)
    if (!facets.length) continue

    const hasMaven = facets.some((f) => f.kind === 'maven')
    const hasNode = facets.some((f) => f.kind === 'node')
    const multi = facets.length > 1

    // 汇总任务；多 facet 时加前缀避免同名覆盖
    const tasks = {}
    for (const f of facets) {
      for (const [name, task] of Object.entries(f.tasks || {})) {
        const key = multi ? `${f.kind}:${name}` : name
        tasks[key] = { ...task, facet: f.kind, name: key }
      }
    }

    const warnings = []
    for (const f of facets) {
      for (const w of f.warnings || []) warnings.push(multi ? `[${f.kind}] ${w}` : w)
    }

    const runnable = facets.some((f) => f.runnable)
    const nodeFacet = facets.find((f) => f.kind === 'node')
    const mavenFacet = facets.find((f) => f.kind === 'maven')

    const project = {
      id: cand.relPath,
      displayName: nodeFacet?.name && !hasMaven ? nodeFacet.name : cand.relPath,
      packageName: nodeFacet?.name || null,
      absPath: cand.absPath,
      kind: multi ? 'mixed' : hasMaven ? 'maven' : 'node',
      type: nodeFacet?.type || (mavenFacet ? 'maven' : 'unknown'),
      facets,
      tasks,
      runnable,
      node: nodeFacet?.node || null,
      legacy: Boolean(nodeFacet?.legacy),
      basePort: nodeFacet?.port ?? null,
      warnings,
    }

    applyOverrides(project, config.overrides[project.id])
    if (project.taskLabels) {
      for (const [name, meta] of Object.entries(project.taskLabels)) {
        if (project.tasks[name]) {
          if (meta.label) project.tasks[name].label = meta.label
          if (meta.group) project.tasks[name].group = meta.group
        }
      }
    }
    projects.push(project)
  }

  // 端口冲突检查
  const byPort = new Map()
  for (const p of projects) {
    if (!p.basePort) continue
    if (!byPort.has(p.basePort)) byPort.set(p.basePort, [])
    byPort.get(p.basePort).push(p)
  }
  for (const [port, list] of byPort) {
    if (list.length > 1) {
      const others = list.map((p) => p.id).join(', ')
      for (const p of list) {
        p.warnings.push(`端口 ${port} 与 [${others}] 冲突，建议在 overrides 里配置 basePort`)
      }
    }
  }

  projects.sort((a, b) => a.id.localeCompare(b.id))

  // 已剔除列表：去重 + 去掉本来就不存在的
  const seen = new Set()
  const excluded = []
  for (const s of ctx.skipped) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    excluded.push(s)
  }
  excluded.sort((a, b) => a.id.localeCompare(b.id))

  return { projects, excluded }
}

/** 兼容旧调用：只要项目数组 */
export function scan(root, config) {
  return scanDetailed(root, config).projects
}

export function summarize(projects) {
  return {
    total: projects.length,
    runnable: projects.filter((p) => p.runnable).length,
    maven: projects.filter((p) => p.kind === 'maven' || p.kind === 'mixed').length,
    node: projects.filter((p) => p.kind === 'node' || p.kind === 'mixed').length,
    withWarnings: projects.filter((p) => p.warnings.length).length,
  }
}
