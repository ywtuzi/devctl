// 排除规则匹配与工具函数
import assert from 'node:assert/strict'
import { matchExcludedBy, isExcluded, displayWidth, padEnd, cmpVersion } from '../src/util.js'

// —— 段匹配（**/xxx 与裸名） ——
assert.equal(isExcluded('web-a/node_modules', ['**/node_modules']), true)
assert.equal(isExcluded('node_modules', ['node_modules']), true)
assert.equal(isExcluded('web-a/src', ['node_modules']), false)
assert.equal(isExcluded('a/b/archives/c', ['archives']), true)

// —— 显式路径：精确或前缀，且不能误伤同前缀的兄弟目录 ——
assert.equal(isExcluded('vendor/legacy', ['vendor/legacy']), true)
assert.equal(isExcluded('vendor/legacy/sub', ['vendor/legacy']), true)
assert.equal(isExcluded('vendor/legacyx', ['vendor/legacy']), false)

// —— 通配 ——
assert.equal(isExcluded('a/tmp-build', ['tmp-*']), true)
assert.equal(isExcluded('a/permanent', ['tmp-*']), false)

// —— 返回命中的具体规则（面板据此区分「基础设施排除」与「可选入」） ——
assert.equal(matchExcludedBy('vendor/legacy', ['x', 'vendor/legacy']), 'vendor/legacy')
assert.equal(matchExcludedBy('free-dir', ['vendor/legacy']), null)
assert.equal(matchExcludedBy('', ['x']), null)

// —— CJK 宽度对齐 ——
assert.equal(displayWidth('abc'), 3)
assert.equal(displayWidth('中文'), 4)
assert.equal(displayWidth('中'), 2)
assert.equal(displayWidth(padEnd('中', 4)), 4)
assert.equal(displayWidth(padEnd('abc', 2)), 3, '超长不应被截断')

// —— 版本比较（不能按字符串比，9 < 10） ——
assert.ok(cmpVersion('18.20.3', '18.18.2') > 0)
assert.ok(cmpVersion('9.0.0', '10.0.0') < 0)
assert.equal(cmpVersion('1.2.3', '1.2.3'), 0)

console.log('util.mjs OK')
