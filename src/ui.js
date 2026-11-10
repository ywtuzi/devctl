// 终端输出：表格、颜色、状态图标
import { displayWidth, padEnd } from './util.js'

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('36'),
  magenta: wrap('35'),
}

export function renderTable(headers, rows, { align = [] } = {}) {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? '')))
  )
  const line = (cells) =>
    cells
      .map((cell, i) => {
        const s = String(cell ?? '')
        const w = widths[i]
        if (align[i] === 'right') return ' '.repeat(Math.max(0, w - displayWidth(s))) + s
        return padEnd(s, w)
      })
      .join('  ')

  const out = [c.bold(line(headers))]
  out.push(c.dim(widths.map((w) => '─'.repeat(w)).join('  ')))
  for (const r of rows) out.push(line(r))
  return out.join('\n')
}

export function statusIcon(status) {
  switch (status) {
    case 'running':
      return c.green('●')
    case 'starting':
      return c.yellow('◐')
    case 'success':
    case 'exited':
      return c.green('✓')
    case 'failed':
      return c.red('✗')
    case 'timeout':
      return c.yellow('⏱')
    case 'stopped':
      return c.dim('■')
    default:
      return c.dim('·')
  }
}

export function fmtDuration(ms) {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}

export function printWarnings(warnings, indent = '  ') {
  if (!warnings || !warnings.length) return
  for (const w of warnings) console.log(`${indent}${c.yellow('!')} ${c.dim(w)}`)
}
