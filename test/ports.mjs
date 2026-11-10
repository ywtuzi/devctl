// 端口探测
// 背景：Windows 的 SO_REUSEADDR 允许重复绑定，只用 listen 判断会把「已被监听」的
// 端口误判为空闲。这里把这个行为固化成回归测试。
import assert from 'node:assert/strict'
import net from 'node:net'
import { isPortFree, findFreePort } from '../src/ports.js'

const port = await findFreePort(39100, 200)
assert.equal(typeof port, 'number', '应能找到一个空闲端口')
assert.equal(await isPortFree(port), true, '新找到的端口应判为空闲')

// 自己占住它，模拟「dev server 已在跑」
const srv = net.createServer()
await new Promise((resolve, reject) => {
  srv.once('error', reject)
  srv.listen(port, '127.0.0.1', resolve)
})

assert.equal(
  await isPortFree(port),
  false,
  '已监听的端口必须判为占用（Windows SO_REUSEADDR 回归）'
)

const next = await findFreePort(port, 5)
assert.ok(next === null || next !== port, 'findFreePort 不应返回被占用的端口')

await new Promise((resolve) => srv.close(resolve))
assert.equal(await isPortFree(port), true, '释放端口后应重新判为空闲')

console.log('ports.mjs OK')
