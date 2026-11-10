// 工作区扫描：目录遍历 → 探测器注册表 → 项目列表
// 本文件不认识任何具体生态：认得什么项目由 src/detectors/ 决定。
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import { matchExcludedBy } from './util.js'
import { detectFacets, hasBuildFile, hasStrongBuildFile, collectExtraProjects } from './detectors/index.js'

/**
 * 扫描一个根目录。
 * 规则：目录内若已有探测器认领的构建文件，即视为项目，**不再向下递归**
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
  const dctx = { config, root }

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
      if (hasBuildFile(abs, dctx)) {
        const suggestible = byPrefs || Boolean(configMatch && configMatch.includes('/'))
        if (suggestible) {
          ctx.skipped.push({ id: posix, reason: byPrefs ? 'user' : 'config', pattern: configMatch || null })
        }
      }
      continue
    }

    const isProject = hasBuildFile(abs, dctx)
    if (isProject) ctx.out.push({ absPath: abs, relPath: posix })
    // 强探测器命中 → 目录独占，不再向下（避免把 Maven 子模块当独立项目）；
    // 弱探测器（仅标记文件）→ 继续向下找嵌套项目。
    const claimsDir = isProject && hasStrongBuildFile(abs, dctx)
    if (!claimsDir && depth < config.maxDepth) {
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

  // extraTasks：在自动识别的任务之上追加项目特有的任务（例如生产发布包）。
  // 命令走 shell，因此可以表达任何项目自有的发布流程，无需改探测器。
  if (override.extraTasks && typeof override.extraTasks === 'object') {
    for (const [key, def] of Object.entries(override.extraTasks)) {
      if (!def) continue
      const raw = typeof def === 'string' ? { command: def } : def
      const command = raw.command || raw.cmd
      if (!command) continue
      const kind =
        raw.kind ||
        (/build|package|dist|release|deploy|install/i.test(key)
          ? 'build'
          : /^(dev|run|start|serve)/i.test(key)
            ? 'run'
            : 'other')
      project.tasks[key] = {
        name: key,
        kind,
        type: 'shell',
        command,
        label: raw.label || null,
        // section 只影响面板里的分组：release 会单独列在「发布」里
        section: raw.section || null,
        note: raw.note || null,
        encoding: raw.encoding || 'utf8',
        cwd: raw.cwd || null,
      }
    }
    project.runnable = Object.values(project.tasks).some((t) => t.kind === 'run')
  }
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
    const facets = detectFacets(cand.absPath, { config, root })
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
    const markerFacet = facets.find((f) => f.kind === 'marker')

    const project = {
      id: cand.relPath,
      displayName: nodeFacet?.name && !hasMaven ? nodeFacet.name : cand.relPath,
      packageName: nodeFacet?.name || null,
      absPath: cand.absPath,
      kind: multi ? 'mixed' : hasMaven ? 'maven' : hasNode ? 'node' : 'other',
      type: nodeFacet?.type || (mavenFacet ? 'maven' : markerFacet?.type || 'unknown'),
      facets,
      tasks,
      runnable,
      node: nodeFacet?.node || null,
      legacy: Boolean(nodeFacet?.legacy),
      version: mavenFacet?.version || null,
      modules: mavenFacet?.modules || [],
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

  // 探测器贡献的额外项目（目前是 config.custom；未来可以是 compose 服务等）。
  // 同 ID 时以探测器的声明为准，覆盖目录扫描结果。
  const extras = collectExtraProjects({ config, root })
  if (extras.length) {
    const extraIds = new Set(extras.map((p) => p.id))
    for (let i = projects.length - 1; i >= 0; i--) {
      if (extraIds.has(projects[i].id)) projects.splice(i, 1)
    }
    projects.push(...extras)
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
