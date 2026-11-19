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

/**
 * 直读基准分支（零 spawn）：本地 main → master → develop，
 * 都没有再退 origin/main 等远端跟踪引用；都没有返回 null（不做相对对比）。
 */
export function readBaseBranch(absPath) {
  const dot = findGitDir(absPath)
  if (!dot) return null
  const gitDir = resolveGitDir(dot)
  const names = ['main', 'master', 'develop']
  for (const n of names) {
    if (existsSync(join(gitDir, 'refs', 'heads', n))) return n
  }
  for (const n of names) {
    if (existsSync(join(gitDir, 'refs', 'remotes', 'origin', n))) return `origin/${n}`
  }
  // 分支被打包进 packed-refs 后，refs/ 下就没有对应文件了（clone 出来的仓常见）
  try {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    const has = (ref) => packed.split('\n').some((l) => l.endsWith(` ${ref}`))
    for (const n of names) if (has(`refs/heads/${n}`)) return n
    for (const n of names) if (has(`refs/remotes/origin/${n}`)) return `origin/${n}`
  } catch {
    /* 没有 packed-refs */
  }
  return null
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
 * 一条 for-each-ref 拿全，两套差异互不叠加 spawn：
 *   - %(upstream:track)      与本地记录的 upstream 比，形如 "[ahead 2]"/"[behind 1]"/"[gone]"
 *   - %(ahead-behind:<base>) 与基准分支（main/master，readBaseBranch 探出）比，
 *                            GitLab 式「落后 a | 超前 b」（a = 落后数，b = 超前数）
 * 第二个原子要 git ≥ 2.41；老版本整条命令会直接失败，降级重跑一次不带它（base 置 null）。
 */
export async function gitBranches(absPath) {
  const base = readBaseBranch(absPath)
  const build = (withBase) => [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=%(refname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)${withBase ? `%09%(ahead-behind:${base})` : ''}`,
    'refs/heads', 'refs/remotes',
  ]
  let withBase = Boolean(base)
  let r = await git(absPath, build(withBase), 15000)
  if (!r.ok && withBase) {
    withBase = false
    r = await git(absPath, build(false), 15000)
  }
  if (!r.ok) return { ok: false, error: r.err, base: null, local: [], remote: [] }
  const local = []
  const remote = []
  for (const line of r.out.split('\n')) {
    if (!line) continue
    const [ref, headMark, upstream, track, vsBase] = line.split('\t')
    // "(ahead behind)" 空格分隔：第一个是超前基准的提交数，第二个是落后者
    let baseAhead = null
    let baseBehind = null
    if (withBase && vsBase) {
      const m = vsBase.trim().match(/^(\d+)\s+(\d+)$/)
      if (m) {
        baseAhead = Number(m[1])
        baseBehind = Number(m[2])
      }
    }
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
        baseAhead,
        baseBehind,
      })
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length)
      // 远端分支同样带上相对基准分支的进度（origin/xxx 与 main 比）
      if (!name.endsWith('/HEAD')) remote.push({ name, baseAhead, baseBehind })
    }
  }
  return { ok: true, base: withBase ? base : null, local, remote }
}

/* ------------------------------ Tier 2：显式操作 ------------------------------ */

export async function gitFetch(absPath, { all = false } = {}) {
  return git(absPath, ['fetch', '--prune', ...(all ? ['--all'] : [])], 120000)
}

/**
 * 从 `git fetch --prune` 的输出里抓出「本次被清理掉的远端分支」。
 * 这些行走的是 stderr，格式固定（缩进可能变，用 [deleted] 锚定）：
 *   " - [deleted]         (none)     -> origin/feat/local"
 * 面板用它告诉用户"远端已删"——本地分支没跟踪远端时（无 upstream 配置）
 * 分支行上的 gone 徽标是没有依据显示的，这条提示是唯一可见的反馈。
 */
export function parseFetchDeleted(text) {
  const names = []
  for (const m of String(text || '').matchAll(/\[deleted\]\s+\(none\)\s+->\s+(\S+)/g)) {
    names.push(m[1])
  }
  return names
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
