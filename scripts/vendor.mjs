#!/usr/bin/env node
// 把 bin/ 与 src/ 复制进 dsh-plugin/vendor/，让插件可以脱离本仓独立分发。
//
// 为什么需要：插件市场安装的是「子目录」（owner/repo#subpath），
// 只会拿到 dsh-plugin/ 这一个目录，../bin 与 ../src 不存在。
// 把 CLI 复制进去之后，插件目录本身就是一个完整可分发的包。
//
// 用法：
//   node scripts/vendor.mjs           生成/刷新 vendor
//   node scripts/vendor.mjs --check   只校验 vendor 是否与源同步（CI/提交前用）
import { cpSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TARGET = join(ROOT, 'dsh-plugin', 'vendor')
const SOURCES = ['bin', 'src']
const CHECK = process.argv.includes('--check')

const listFiles = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(p, base, out)
    else out.push(relative(base, p).replace(/\\/g, '/'))
  }
  return out.sort()
}

if (!CHECK) {
  rmSync(TARGET, { recursive: true, force: true })
  mkdirSync(TARGET, { recursive: true })
  for (const s of SOURCES) {
    const from = join(ROOT, s)
    if (!existsSync(from)) continue
    cpSync(from, join(TARGET, s), { recursive: true })
  }
  const total = SOURCES.reduce((n, s) => {
    const p = join(TARGET, s)
    return n + (existsSync(p) ? listFiles(p).length : 0)
  }, 0)
  console.log(`✓ vendor 已更新 → ${TARGET}（${total} 个文件）`)
} else {
  if (!existsSync(TARGET)) {
    console.error('✗ vendor 不存在，先运行 node scripts/vendor.mjs')
    process.exit(1)
  }
  let drift = 0
  for (const s of SOURCES) {
    const srcDir = join(ROOT, s)
    const dstDir = join(TARGET, s)
    if (!existsSync(srcDir)) continue
    if (!existsSync(dstDir)) {
      console.error(`✗ vendor 缺少目录: ${s}`)
      drift++
      continue
    }
    const a = listFiles(srcDir)
    const b = listFiles(dstDir)
    for (const f of a) {
      if (!b.includes(f)) {
        console.error(`✗ vendor 缺少文件: ${s}/${f}`)
        drift++
        continue
      }
      if (readFileSync(join(srcDir, f), 'utf8') !== readFileSync(join(dstDir, f), 'utf8')) {
        console.error(`✗ vendor 内容过期: ${s}/${f}`)
        drift++
      }
    }
    for (const f of b) {
      if (!a.includes(f)) {
        console.error(`✗ vendor 多出文件: ${s}/${f}`)
        drift++
      }
    }
  }
  if (drift) {
    console.error(`\n共 ${drift} 处不一致，运行 node scripts/vendor.mjs 修复`)
    process.exit(1)
  }
  console.log('✓ vendor 与源同步')
}
