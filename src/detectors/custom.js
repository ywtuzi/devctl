// 显式声明探测器：把 config.custom 里的条目变成项目
//
// 这是「探测器可以贡献目录扫描之外的项目」的示范——探测量不限于逐目录探测，
// 任何能产出项目列表的来源都可以用它接入（例如未来的 docker compose 服务发现）。
import { join, resolve as resolvePath } from 'node:path'

export const id = 'custom'

export function probe() {
  return false // 不参与目录探测，只贡献额外项目
}

export function detect() {
  return null
}

export function extraProjects(ctx) {
  const config = (ctx && ctx.config) || {}
  const root = (ctx && ctx.root) || process.cwd()
  const entries = Array.isArray(config.custom) ? config.custom : []
  const out = []

  for (const entry of entries) {
    if (!entry || !entry.id) continue
    const absPath = entry.dir ? resolvePath(root, entry.dir) : join(root, entry.id)
    const tasks = {}
    const warnings = []

    for (const [name, def] of Object.entries(entry.tasks || {})) {
      const raw = typeof def === 'string' ? { command: def } : def || {}
      const command = raw.command || raw.cmd
      if (!command) {
        warnings.push(`custom 任务 "${name}" 缺少 command`)
        continue
      }
      const kind =
        raw.kind ||
        (/build|package|dist/i.test(name)
          ? 'build'
          : /^(dev|run|start|serve)/i.test(name)
            ? 'run'
            : 'other')
      tasks[name] = {
        name,
        kind,
        type: 'shell',
        command,
        label: raw.label || name,
        encoding: raw.encoding || 'utf8',
        cwd: raw.cwd || null,
      }
    }
    if (!Object.keys(tasks).length) warnings.push('custom 条目没有任何有效任务')

    out.push({
      id: entry.id,
      displayName: entry.id,
      packageName: null,
      absPath,
      kind: 'custom',
      type: entry.type || 'custom',
      facets: [],
      tasks,
      runnable: Object.values(tasks).some((t) => t.kind === 'run'),
      node: entry.node || null,
      legacy: false,
      basePort: entry.basePort ?? null,
      debugPort: entry.debugPort ?? null,
      warnings,
    })
  }
  return out
}
