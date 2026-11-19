// git 集成：分支直读（零 spawn）+ 按需 status/branches + 显式操作
//
// 性能前提（实测，Windows + Defender 场景）：
//   - spawn 一个 git 进程 ≈ 900ms，哪怕 rev-parse 这种瞬时命令
//   - node 直读 .git/HEAD：17 仓共 4ms
// 所以分三层：
//   Tier 0  readBranchFast   直读文件，随 /projects 热路径返回，只出分支名
//   Tier 1  gitStatusDetail  单仓一次 spawn（~1s），点击项目 git 面板时才调，带缓存
//   Tier 2  gitFetch/Pull/Switch 显式操作，面板走 CLI 执行（与终端同路径）
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 30000

/** 在 git 进程层面执行一条命令 */
function git(dir, args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', dir, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '').trim() })
    )
  })
}

/* ------------------------------ Tier 0：零 spawn 直读 ------------------------------ */

/**
 * 找到项目所属的 git 根（.git 目录或 worktree/submodule 的 .git 文件）。
 * 纯 fs 操作；找不到返回 null。最多向上 6 层（项目嵌在仓库子目录的情况）。
 */
export function findGitDir(absPath, maxHops = 6) {
  let dir = absPath
  for (let i = 0; i < maxHops; i++) {
    const dot = join(dir, '.git')
    if (existsSync(dot)) return dot
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** .git 可能是文件（worktree/submodule）：内容形如 "gitdir: <path>" */
function resolveGitDir(dotPath) {
  try {
    const st = readFileSync(dotPath, 'utf8').trim()
    if (st.startsWith('gitdir:')) {
      const p = st.slice(7).trim()
      return p ? (p.match(/^[A-Za-z]:[\\/]/) ? p : join(dirname(dotPath), p)) : null
    }
  } catch {
    /* 目录而非文件 */
  }
  return dotPath
}

/**
 * 直读当前分支（零 spawn，~0.2ms/仓）。
 * 返回 { branch, detached, sha } 或 null（非 git 目录）。
 */
export function readBranchFast(absPath) {
  const dot = findGitDir(absPath)
  if (!dot) return null
  const gitDir = resolveGitDir(dot)
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: refs/heads/')) {
      return { branch: head.slice('ref: refs/heads/'.length), detached: false, sha: null }
    }
    // detached：HEAD 直接是 commit sha
    return { branch: null, detached: true, sha: head.slice(0, 8) }
  } catch {
    return null
  }
}

/* ------------------------------ Tier 1：按需详情（单仓 spawn） ------------------------------ */

/**
 * 单仓 git 状态详情：当前分支、upstream、ahead/behind、脏文件数、未跟踪数。
 * 一次 `status -sb -unormal` 全部拿到。非 git 目录返回 { ok, error }。
 */
/** 解析 `git status -sb -unormal` 输出（导出供测试） */
export function parseStatusSb(out) {
  const lines = out.split('\n')
  const header = lines[0] || ''
  // 形如 "## main...origin/main [ahead 2, behind 1]" / "## main" / "## HEAD (no branch)"
  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  if (!header.includes('no branch')) {
    const hm = header.match(/^## (\S+?)(?:\.\.\.(\S+?))?(?:\s+\[([^\]]*)\])?$/)
    if (hm) {
      branch = hm[1]
      upstream = hm[2] || null
      const ab = hm[3] || ''
      ahead = Number((ab.match(/ahead (\d+)/) || [])[1] || 0)
      behind = Number((ab.match(/behind (\d+)/) || [])[1] || 0)
    }
  }
  let staged = 0
  let modified = 0
  let untracked = 0
  for (const l of lines.slice(1)) {
    if (!l) continue
    const x = l[0]
    const y = l[1]
    if (x === '?') untracked++
    else if (x !== ' ' && x !== '#') staged++
    else if (y !== ' ' && y !== '#') modified++
  }
  return {
    ok: true,
    branch,
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    dirty: staged + modified,
  }
}

export async function gitStatusDetail(absPath) {
  const r = await git(absPath, ['status', '-sb', '-unormal'])
  if (!r.ok) return { ok: false, error: r.err || 'git status 失败' }
  return parseStatusSb(r.out)
}

/**
 * 分支列表（本地含各自 upstream 差异 + 远端），供切换选择。
 * 用 for-each-ref 一条命令拿全：%(upstream:track) 从本地 ref 计算
 * ahead/behind（不发网络请求），形如 "[ahead 2]"/"[behind 1]"/"[ahead 1, behind 2]"/"[gone]"。
 */
export async function gitBranches(absPath) {
  const r = await git(absPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)',
    'refs/heads', 'refs/remotes',
  ], 15000)
  if (!r.ok) return { ok: false, error: r.err, local: [], remote: [] }
  const local = []
  const remote = []
  for (const line of r.out.split('\n')) {
    if (!line) continue
    const [ref, headMark, upstream, track] = line.split('\t')
    // "[ahead 2, behind 1]" → { ahead: 2, behind: 1 }；空串 = 同步；[gone] = 远端已删
    let ahead = 0
    let behind = 0
    let gone = false
    if (track) {
      ahead = Number((track.match(/ahead (\d+)/) || [])[1] || 0)
      behind = Number((track.match(/behind (\d+)/) || [])[1] || 0)
      gone = track.includes('gone')
    }
    if (ref.startsWith('refs/heads/')) {
      local.push({
        name: ref.slice('refs/heads/'.length),
        current: headMark === '*',
        upstream: upstream || null,
        ahead,
        behind,
        gone,
      })
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length)
      if (!name.endsWith('/HEAD')) remote.push({ name })
    }
  }
  return { ok: true, local, remote }
}

/* ------------------------------ Tier 2：显式操作 ------------------------------ */

export async function gitFetch(absPath, { all = false } = {}) {
  return git(absPath, ['fetch', '--prune', ...(all ? ['--all'] : [])], 120000)
}

/** 仅 fast-forward；脏工作区/需要合并时 git 自己会拒绝，错误原样带回给用户 */
export async function gitPull(absPath) {
  return git(absPath, ['pull', '--ff-only'], 300000)
}

export async function gitSwitch(absPath, branch) {
  return git(absPath, ['switch', branch], 60000)
}

/**
 * 删除本地分支。默认用 -d（而非 -D）：未合并的分支 git 会拒绝，防止误删丢提交。
 * 当前分支 git 也会拒绝（-d 与 -D 都不允许删 HEAD 所在分支）。
 * force=true 时改用 -D：用于「提交已在别处重新应用（cherry-pick）、原件确认放弃」的场景，
 * 由面板上的「强制删除」按钮显式触发，普通删除永远走 -d。
 */
export async function gitDeleteBranch(absPath, branch, force = false) {
  return git(absPath, ['branch', force ? '-D' : '-d', branch], 60000)
}

/**
 * 不切分支，把某个非当前分支的本地 ref 快进到远端：
 *   git fetch <remote> <branch>:<branch>
 * fetch 的 refspec 更新天然只做 fast-forward（非 ff 会拒绝，不会强推本地历史），
 * 且 git 自带保护：目标分支若已检出（checked out）会拒绝，防止改掉工作区。
 */
export async function gitUpdateBranch(absPath, branch) {
  const b = await gitBranches(absPath)
  const target = b.ok ? b.local.find((x) => x.name === branch) : null
  // 远端名取该分支 upstream 的前缀（origin/xxx → origin），取不到就退 origin
  const remote = target && target.upstream ? target.upstream.split('/')[0] : 'origin'
  return git(absPath, ['fetch', remote, `${branch}:${branch}`], 300000)
}

/** 预演用：各操作实际会执行的命令行（展示给用户确认的就是真正执行的） */
export const gitCommandPreview = {
  fetch: (remote) => `git fetch --prune${remote ? ` ${remote}` : ''}`,
  pull: () => 'git pull --ff-only',
  switch: (branch) => `git switch ${branch}`,
  update: (branch, remote = 'origin') => `git fetch ${remote} ${branch}:${branch}`,
  delete: (branch, force = false) => `git branch -${force ? 'D' : 'd'} ${branch}`,
}

/* ------------------------------ 并发限流 ------------------------------ */

/** 有上限的并发 map：批量 fetch 等操作用，避免一次拉起十几个 git 进程把机器拖住 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) break
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
