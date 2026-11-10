// 标记探测器（兜底）：认出其它生态的项目，但只列出来，不猜命令
//
// 为什么只认不猜：Go / Rust / Python 的「怎么跑」千差万别（go run ./cmd/x、cargo run、
// uvicorn app:main），猜错比不猜更糟。所以这里只负责让项目**出现在列表里**，
// 命令由 user 通过 config.custom 或后续新增的专用探测器补上。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const id = 'marker'
export const fallback = true
// 弱探测器：只说明「这目录像个项目」，不独占它。
// 扫描器仍会向下找嵌套项目（例如一个 Python 仓里带了 web/ 前端）。
export const weak = true

const MARKERS = [
  { file: 'go.mod', type: 'go' },
  { file: 'Cargo.toml', type: 'rust' },
  { file: 'pyproject.toml', type: 'python' },
  { file: 'setup.py', type: 'python' },
  { file: 'build.gradle', type: 'gradle' },
  { file: 'build.gradle.kts', type: 'gradle' },
  { file: 'docker-compose.yml', type: 'compose' },
  { file: 'docker-compose.yaml', type: 'compose' },
  { file: 'compose.yml', type: 'compose' },
  { file: 'compose.yaml', type: 'compose' },
]

export function detectMarkers(dir) {
  const out = []
  for (const m of MARKERS) {
    if (existsSync(join(dir, m.file))) out.push(m)
  }
  try {
    const entries = readdirSync(dir)
    if (entries.some((n) => n.endsWith('.sln') || n.endsWith('.csproj'))) {
      out.push({ file: '*.csproj', type: 'dotnet' })
    }
  } catch {
    /* 目录不可读时忽略 */
  }
  return out
}

export function probe(dir) {
  return detectMarkers(dir).length > 0
}

export function detect(dir) {
  const markers = detectMarkers(dir)
  if (!markers.length) return null
  const files = [...new Set(markers.map((m) => m.file))]
  return {
    kind: 'marker',
    type: markers[0].type,
    markers: files,
    tasks: {},
    runnable: false,
    warnings: [
      `识别到 ${files.join(' / ')}，但未内置该生态的任务；在 devctl.config.json 的 custom 里声明运行/打包命令即可纳入`,
    ],
  }
}
