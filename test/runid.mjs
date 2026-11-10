// runId 必须是合法的 Windows 文件名
// 背景：任务名可能含冒号（uni-app 的 dev:mp-weixin），直接拼进去会变成
// NTFS 备用数据流，目录里看到的文件名被截断，导致 status / stop 找不到记录。
import assert from 'node:assert/strict'
import { runIdFor } from '../src/runner.js'

const cases = [
  ['uni-app', 'dev:mp-weixin'],
  ['web-app', 'build:h5'],
  ['vendor/nested-repo', 'run'],
  ['a b c', 'x y'],
  ['中文项目', '启动'],
]

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/
for (const [projectId, task] of cases) {
  const id = runIdFor(projectId, task)
  assert.ok(id.length > 0, 'runId 不应为空')
  assert.ok(!ILLEGAL.test(id), `runId 含非法字符: ${id}`)
  assert.match(id, /^[A-Za-z0-9_.-]+$/, `runId 只应包含安全字符: ${id}`)
}

// 同一输入两次调用应可区分（带时间戳），且前缀稳定
const a = runIdFor('web-app', 'dev')
assert.ok(a.startsWith('web-app_dev_'), '前缀应保持可读: ' + a)

console.log('runid.mjs OK')
