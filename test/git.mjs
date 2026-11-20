// git 输出解析测试（纯函数，不 spawn git）
import { parseStatusSb, readBranchFast, findGitDir } from '../src/git.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const ok = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

// parseStatusSb
let r = parseStatusSb('## main...origin/main [ahead 2, behind 1]\n M a.js\n?? b.txt\nM  c.js\n')
ok('branch', r.branch === 'main')
ok('upstream', r.upstream === 'origin/main')
ok('ahead/behind', r.ahead === 2 && r.behind === 1)
ok('dirty counts', r.modified === 1 && r.staged === 1 && r.untracked === 1 && r.dirty === 2)

r = parseStatusSb('## main\n')
ok('no upstream', r.branch === 'main' && r.upstream === null && r.ahead === 0 && r.behind === 0)

r = parseStatusSb('## dev...origin/dev [behind 3]\n')
ok('behind only', r.behind === 3 && r.ahead === 0)

r = parseStatusSb('## HEAD (no branch)\n')
ok('detached header', r.branch === null)

// 变更文件清单：状态分类 + 重命名 + 冲突 + 截断
r = parseStatusSb('## main\nA  new.js\nD  gone.js\n M mod.js\nR  old.js -> moved.js\n?? unt.txt\nUU both.js\nDD dup.js\nAU addu.js\n')
ok('files: added', r.files.find((f) => f.path === 'new.js')?.state === 'added')
ok('files: deleted', r.files.find((f) => f.path === 'gone.js')?.state === 'deleted')
ok('files: modified unstaged', r.files.find((f) => f.path === 'mod.js')?.state === 'modified')
ok('files: rename keeps orig', (() => { const f = r.files.find((x) => x.path === 'moved.js'); return f && f.orig === 'old.js' && f.state === 'renamed' })())
ok('files: untracked', r.files.find((f) => f.path === 'unt.txt')?.state === 'untracked')
ok('conflict codes UU/DD/AU', ['both.js', 'dup.js', 'addu.js'].every((p) => r.files.find((f) => f.path === p)?.state === 'conflict'))
ok('conflicts count', r.conflicts === 3 && r.fileCounts.conflict === 3)
ok('fileCounts sums', r.fileCounts.added === 1 && r.fileCounts.deleted === 1 && r.fileCounts.renamed === 1 && r.fileCounts.untracked === 1)
ok('clean repo no files', parseStatusSb('## main\n').files.length === 0)

// 暂存区双侧条目：MM 文件在 待提交/变更 两区各一条
r = parseStatusSb('## main\nMM both.js\nA  new.js\n M wk.js\n')
const mm = r.files.filter((f) => f.path === 'both.js')
ok('dual entry for MM', mm.length === 2 && mm.some((f) => f.staged && f.state === 'modified') && mm.some((f) => !f.staged && f.state === 'modified'))
ok('staged flag', r.files.find((f) => f.path === 'new.js')?.staged === true && r.files.find((f) => f.path === 'wk.js')?.staged === false)

// 截断：MAX_FILES 之上不再收集，但计数继续
{
  const many = ['## main'].concat(Array.from({ length: 400 }, (_, i) => `M  f${i}.js`)).join('\n')
  const rr = parseStatusSb(many)
  ok('files truncated', rr.files.length === 300 && rr.filesTruncated === true)
  ok('counts not truncated', rr.fileCounts.modified === 400)
}

// readBranchFast：临时目录构造 .git
const tmp = mkdtempSync(join(tmpdir(), 'devctl-git-'))
try {
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
  ok('readBranchFast branch', JSON.stringify(readBranchFast(repo)) === '{"branch":"feature/x","detached":false,"sha":null}')

  writeFileSync(join(repo, '.git', 'HEAD'), '0123456789abcdef\n')
  ok('readBranchFast detached', readBranchFast(repo).detached === true)

  // 子目录向上找 .git
  mkdirSync(join(repo, 'sub'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  ok('findGitDir walks up', readBranchFast(join(repo, 'sub')).branch === 'main')

  ok('non-git → null', readBranchFast(tmp) === null && findGitDir(tmp) === null)

  // worktree 形态：.git 是文件
  const wt = join(tmp, 'wt')
  const wtGit = join(tmp, 'wt-git')
  mkdirSync(wt, { recursive: true })
  mkdirSync(wtGit, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit.replace(/\\/g, '/')}\n`)
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/wt-branch\n')
  ok('worktree .git file', readBranchFast(wt).branch === 'wt-branch')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) {
  console.error(`${failed} 个断言失败`)
  process.exit(1)
}
console.log('git.mjs OK')
