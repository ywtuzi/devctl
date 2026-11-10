// 单模块构建：-pl 的语义，以及为什么必须去掉 -am
//
// 背景：多模块仓里 `mvn deploy` 默认对整个 reactor 生效。
// 只想发一个模块时要用 -pl，但 -am 会把这个模块的上游一起拉进 reactor，
// 于是 deploy/install 会连带作用在它们身上——发得比预期更多。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { withModuleArgs } from '../src/runner.js'
import { buildPlan } from '../src/plan.js'

// 1) 纯函数：追加 -pl，并把已有的 -pl / -am 换掉
assert.deepEqual(
  withModuleArgs(['clean', 'deploy', '-DskipTests'], 'api'),
  ['clean', 'deploy', '-DskipTests', '-pl', 'api'],
  '没有 -pl 时应直接追加'
)
assert.deepEqual(
  withModuleArgs(['-pl', 'svc', '-am', 'spring-boot:run'], 'api'),
  ['spring-boot:run', '-pl', 'api'],
  '-am 必须去掉，否则上游模块会一起被 deploy'
)
assert.deepEqual(
  withModuleArgs(['-pl', 'a', '--also-make', 'deploy', '--projects', 'b'], 'c'),
  ['deploy', '-pl', 'c'],
  '长参数形式同样要被替换'
)

// 2) 计划层：只认 pom 里声明过的模块，命令里必须真的带 -pl
const root = mkdtempSync(join(tmpdir(), 'devctl-mod-'))
const write = (rel, content = '') => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

try {
  write(
    'svc/pom.xml',
    `<project>
  <artifactId>svc</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules><module>a</module><module>b</module></modules>
  <distributionManagement>
    <repository><id>rel</id><url>http://nexus.example.com:8182/repository/maven-releases/</url></repository>
  </distributionManagement>
</project>
`
  )

  const one = await buildPlan({ root, id: 'svc', taskName: 'deploy', module: 'a' })
  assert.deepEqual(one.modules, ['a', 'b'], '模块清单应来自 pom')
  assert.equal(one.module, 'a')
  assert.ok(one.display.endsWith('-pl a'), `命令应带 -pl a，实际: ${one.display}`)
  assert.deepEqual(one.args.slice(-2), ['-pl', 'a'], '真实执行参数也要带 -pl')
  assert.ok(one.note.startsWith('只发布 a'), `提示应说明范围，实际: ${one.note}`)

  const all = await buildPlan({ root, id: 'svc', taskName: 'deploy' })
  assert.equal(all.module, null)
  assert.ok(!all.display.includes('-pl'), '不指定模块时不应追加 -pl')
  assert.ok(!all.note.startsWith('只'), '整仓发布时不加范围前缀')

  await assert.rejects(
    () => buildPlan({ root, id: 'svc', taskName: 'deploy', module: 'zzz' }),
    /没有模块 "zzz"/,
    '不存在的模块应直接报错，而不是给一条会跑错的命令'
  )

  console.log('module.mjs OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}
