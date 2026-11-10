// 探测器契约：注册表可扩展、兜底语义、额外项目贡献
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { detectFacets, hasBuildFile, collectExtraProjects, register, list } from '../src/detectors/index.js'
import { loadConfig } from '../src/config.js'

const root = mkdtempSync(join(tmpdir(), 'devctl-det-'))
const write = (rel, content = '') => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

try {
  const config = loadConfig(root)
  const ctx = { config, root }

  // 1) 注册表可扩展：第三方探测器登记后立即生效，注销后立刻消失
  const before = list().length
  const dispose = register({
    id: 'fake',
    probe: () => true,
    detect: () => ({ kind: 'fake', type: 'fake', tasks: {}, runnable: false, warnings: [] }),
  })
  assert.equal(list().length, before + 1, '注册后探测器数量应 +1')
  write('fake-proj/readme.txt', 'x')
  const fakeFacets = detectFacets(join(root, 'fake-proj'), ctx)
  assert.equal(fakeFacets.length, 1)
  assert.equal(fakeFacets[0].kind, 'fake')
  dispose()
  assert.equal(list().length, before, '注销后应恢复原数量')

  // 重复 id 应被拒绝
  assert.throws(() => register({ id: 'maven', detect: () => null }), /id 重复/)

  // 2) 兜底探测器：只有 go.mod 的目录也能认出项目，但不猜命令
  write('go-svc/go.mod', 'module example.com/x\n')
  assert.equal(hasBuildFile(join(root, 'go-svc'), ctx), true, 'go.mod 应让目录被认作项目')
  const go = detectFacets(join(root, 'go-svc'), ctx)
  assert.equal(go.length, 1)
  assert.equal(go[0].kind, 'marker')
  assert.equal(go[0].type, 'go')
  assert.equal(Object.keys(go[0].tasks).length, 0, '不应猜任务')
  assert.ok(go[0].warnings.some((w) => w.includes('go.mod')), '应提示如何补充命令')

  // 3) 兜底只在没有其它探测器命中时才跑
  write('node-compose/package.json', JSON.stringify({ name: 'nc', scripts: { dev: 'vite' } }))
  write('node-compose/docker-compose.yml', 'services: {}\n')
  const nc = detectFacets(join(root, 'node-compose'), ctx)
  assert.equal(nc.length, 1, 'package.json 命中后不应再叠加 marker')
  assert.equal(nc[0].kind, 'node')

  // 4) 单个探测器抛错不应该让整个扫描失败
  const disposeBoom = register({
    id: 'boom',
    probe: () => false,
    detect() {
      throw new Error('坏了')
    },
  })
  write('boom-proj/x.txt', '')
  const boom = detectFacets(join(root, 'boom-proj'), ctx)
  assert.equal(boom.length, 1)
  assert.ok(boom[0].warnings.some((w) => w.includes('boom')), '错误应作为 warning 暴露')
  disposeBoom()

  // 5) extraProjects：config.custom 变成项目，任务走 shell
  const cfg2 = {
    ...config,
    custom: [
      {
        id: 'py-api',
        dir: 'svc/py',
        type: 'python',
        basePort: 8000,
        tasks: { dev: 'uvicorn app:main --port 8000', build: 'python -m build' },
      },
      { id: 'bad', tasks: {} },
    ],
  }
  const extras = collectExtraProjects({ config: cfg2, root })
  assert.equal(extras.length, 2)
  const py = extras.find((e) => e.id === 'py-api')
  assert.equal(py.tasks.dev.kind, 'run', 'dev 任务应归为 run')
  assert.equal(py.tasks.dev.type, 'shell')
  assert.equal(py.tasks.build.kind, 'build')
  assert.equal(py.runnable, true)
  assert.equal(py.basePort, 8000)
  assert.equal(py.absPath, join(root, 'svc/py'))
  const bad = extras.find((e) => e.id === 'bad')
  assert.ok(bad.warnings.length > 0, '没有任务的条目应给出警告')

  console.log('detectors.mjs OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}
