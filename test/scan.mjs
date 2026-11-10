// 扫描与解析：在临时目录里构造假工作区，验证识别规则
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadConfig, savePrefs } from '../src/config.js'
import { scanDetailed } from '../src/scan.js'

const root = mkdtempSync(join(tmpdir(), 'devctl-scan-'))
const write = (rel, content) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

const SB_PLUGIN = `
  <plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
  </plugin>`

try {
  // 1) Vue CLI 4（webpack4）前端
  write(
    'frontend/package.json',
    JSON.stringify({
      name: 'same-name-template',
      devDependencies: { '@vue/cli-service': '4.4.6' },
      scripts: {
        dev: 'set NODE_OPTIONS=--openssl-legacy-provider & vue-cli-service serve',
        'build:prod': 'vue-cli-service build --mode production',
        'build': 'vue-cli-service build',
      },
    })
  )

  // 2) Maven 多模块：可运行模块在子模块里
  write('backend/pom.xml', `<project><packaging>pom</packaging><modules><module>svc</module></modules></project>`)
  write('backend/svc/pom.xml', `<project><build><plugins>${SB_PLUGIN}</plugins></build></project>`)

  // 3) 普通 jar，插件只在 pluginManagement 里 → 不可运行
  write(
    'libonly/pom.xml',
    `<project><packaging>jar</packaging><build><pluginManagement><plugins>${SB_PLUGIN}</plugins></pluginManagement></build></project>`
  )

  // 4) 聚合根写了插件但 packaging=pom → 自身不可运行
  write('agg/pom.xml', `<project><packaging>pom</packaging><build><plugins>${SB_PLUGIN}</plugins></build></project>`)

  // 5) 嵌套两层才出现的项目
  write('nested/deep/package.json', JSON.stringify({ name: 'deep', scripts: { dev: 'vite' } }))

  // 6) 同目录双构建
  write('mixed/pom.xml', `<project><packaging>jar</packaging><build><plugins>${SB_PLUGIN}</plugins></build></project>`)
  write('mixed/package.json', JSON.stringify({ name: 'mixed', scripts: { dev: 'vite' } }))

  const base = loadConfig(root)
  const config = {
    ...base,
    toolchain: { ...base.toolchain, defaultNode: '18.20.3' },
    prefs: { excluded: [], included: [] },
  }

  const { projects, excluded } = scanDetailed(root, config)
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]))

  // —— 识别清单 ——
  for (const id of ['frontend', 'backend', 'libonly', 'agg', 'nested/deep', 'mixed']) {
    assert.ok(byId[id], `缺少项目 ${id}`)
  }
  assert.equal(excluded.length, 0)

  // —— 前端：vue-cli + webpack4 → 绑 Node，默认 build 取 build:prod ——
  const fe = byId['frontend']
  assert.equal(fe.kind, 'node')
  assert.equal(fe.type, 'vue-cli')
  assert.equal(fe.legacy, true)
  assert.equal(fe.node, '18.20.3', 'webpack4 项目应绑定 defaultNode')
  assert.equal(fe.tasks.build.script, 'build:prod', '默认构建应优先 build:prod')

  // —— 后端：可运行模块来自子模块，且额外提供 debug ——
  const be = byId['backend']
  assert.equal(be.kind, 'maven')
  assert.equal(be.runnable, true)
  assert.ok(be.tasks.run, '可运行模块应有 run 任务')
  assert.ok(be.tasks.run.args.includes('svc'), 'run 应指向子模块 svc')
  assert.ok(be.tasks.debug, '可运行模块应有 debug 任务')
  assert.equal(be.tasks.debug.debug, true)
  assert.ok(be.tasks.build && be.tasks.install)

  // —— 库项目：pluginManagement 不算，且无 debug ——
  const lib = byId['libonly']
  assert.equal(lib.runnable, false, 'pluginManagement 里的声明不应判为可运行')
  assert.equal(lib.tasks.run, undefined)
  assert.equal(lib.tasks.debug, undefined)

  // —— 聚合根：packaging=pom 自身不可运行 ——
  assert.equal(byId['agg'].runnable, false)
  assert.equal(byId['agg'].tasks.debug, undefined)

  // —— 同目录双构建 ——
  const mx = byId['mixed']
  assert.equal(mx.kind, 'mixed')
  assert.ok(Object.keys(mx.tasks).some((k) => k.startsWith('maven:')))
  assert.ok(Object.keys(mx.tasks).some((k) => k.startsWith('node:')))

  // —— 剔除 / 选入 ——
  savePrefs(root, { excluded: ['frontend'], included: [] })
  const afterExclude = scanDetailed(root, { ...config, prefs: { excluded: ['frontend'], included: [] } })
  assert.ok(!afterExclude.projects.some((p) => p.id === 'frontend'), '剔除后不应出现在列表')
  assert.ok(
    afterExclude.excluded.some((e) => e.id === 'frontend' && e.reason === 'user'),
    '剔除后应出现在 excluded 且原因标为 user'
  )

  const afterInclude = scanDetailed(root, { ...config, prefs: { excluded: [], included: ['frontend'] } })
  assert.ok(afterInclude.projects.some((p) => p.id === 'frontend'), '选入后应回到列表')

  console.log('scan.mjs OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}
