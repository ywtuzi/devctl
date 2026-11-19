// 端到端复现：git update（不切分支快进）在真实 git 仓库上的行为
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitUpdateBranch, gitBranches } from '../src/git.js'

const tmp = join(tmpdir(), `devctl-upd-${Date.now()}`)
mkdirSync(tmp, { recursive: true })
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' })

try {
  // remote 裸仓 + clone
  const remote = join(tmp, 'origin.git')
  mkdirSync(remote)
  sh('git', ['init', '--bare', '-b', 'main', '.'], remote)
  const repo = join(tmp, 'repo')
  sh('git', ['clone', remote, 'repo'], tmp)
  sh('git', ['config', 'user.email', 't@t'], repo)
  sh('git', ['config', 'user.name', 't'], repo)
  writeFileSync(join(repo, 'a.txt'), '1\n')
  sh('git', ['add', '.'], repo)
  sh('git', ['commit', '-m', 'c1'], repo)
  sh('git', ['push', '-u', 'origin', 'main'], repo)

  // 在远端加两个新提交（本地 main 落后 2）
  const other = join(tmp, 'other')
  sh('git', ['clone', remote, 'other'], tmp)
  sh('git', ['config', 'user.email', 't@t'], other)
  sh('git', ['config', 'user.name', 't'], other)
  for (const m of ['c2', 'c3']) {
    writeFileSync(join(other, 'a.txt'), `${m}\n`)
    sh('git', ['add', '.'], other)
    sh('git', ['commit', '-m', m], other)
  }
  sh('git', ['push'], other)

  // 本地建第二个分支并切过去（main 非当前）
  sh('git', ['switch', '-c', 'work'], repo)
  writeFileSync(join(repo, 'w.txt'), 'w\n')
  sh('git', ['add', '.'], repo)
  sh('git', ['commit', '-m', 'w1'], repo)

  let b = await gitBranches(repo)
  console.log('before: main behind =', b.local.find((x) => x.name === 'main').behind,
    '| current =', b.local.find((x) => x.current).name)

  const r = await gitUpdateBranch(repo, 'main')
  console.log('update ok =', r.ok, r.err || '')

  b = await gitBranches(repo)
  const main = b.local.find((x) => x.name === 'main')
  console.log('after: main behind =', main.behind, '| HEAD still on', b.local.find((x) => x.current).name)
  console.log('main tip =', sh('git', ['rev-parse', '--short', 'main'], repo).trim())
  console.log('origin/main tip =', sh('git', ['rev-parse', '--short', 'origin/main'], repo).trim())
  console.log(main.behind === 0 ? 'PASS' : 'FAIL')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
