/**
 * DevCTL 面板 —— Client 半。
 *
 * 定位：状态面板为主，执行前二次确认。
 *  - 运行中 / 打包中 常驻置顶，时长每秒刷新
 *  - 点「控制台」进入单个实例：实时日志 tail + 进程状态（pid / 端口 / 运行时 / 已运行）
 *  - 运行 / 打包 一律先预演，把完整命令摊开给用户确认
 */
window.__ModuleLoader__.load({
  id: 'dsh-devctl-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/devctl-api'
    const LS_OPEN = 'devctl.panel.open'
    const LS_WIDTH = 'devctl.panel.width'
    // ANSI 转义序列（颜色/光标移动）：日志入口处 strip，渲染期零处理
    const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
    const stripAnsi = (s) => (s ? s.replace(ANSI_RE, '') : s)

    async function call(path, init) {
      const res = await fetch(API + path, init)
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { error: text }
      }
      if (!res.ok) throw new Error((data && data.error) || res.statusText)
      return data
    }
    const post = (path, body) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const groupOf = (p) => {
      if (p.kind === 'mixed') return 'fullstack'
      if (p.kind === 'maven') return 'backend'
      const t = p.type
      if (t === 'vue-cli' || t === 'vite' || t === 'uni-app' || t === 'vuepress') return 'frontend'
      return 'tool'
    }
    const GROUPS = ['frontend', 'backend', 'fullstack', 'tool']

    const PLATFORM_ORDER = ['h5', 'mp-weixin', 'mp-alipay', 'mp-baidu', 'mp-qq', 'mp-toutiao', 'mp-lark', 'mp-kuaishou', 'mp-jd', 'mp-xhs', 'mp-harmony', 'quickapp-webview', 'custom']
    const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`)

    // chip 的外观直接复用行内按钮的 styles.btn（细边框 + 6px 圆角），
    // 这里只补 :hover / :disabled / 选中态——伪类没法写进内联样式。
    // 用 !important 是因为底子来自内联 style，优先级比类选择器高；
    // 好处是万一 <style> 被 CSP 拦掉，细边框仍然在，只是没有悬停效果。
    const CHIP_CSS = `
.devctl-chip { outline: none; }
.devctl-chip:hover { border-color: var(--dsw-alias-brand-primary) !important; }
.devctl-chip:disabled { opacity: .5; cursor: default; }
.devctl-chip:disabled:hover { border-color: var(--dsw-alias-border-l2) !important; }
.devctl-chip.is-release {
  border-color: var(--dsw-alias-state-warn-primary) !important;
  color: var(--dsw-alias-state-warn-primary) !important;
}
.devctl-chip.is-selected { border-color: var(--dsw-alias-brand-primary) !important; }
/* git 分支行（GitLens 式列表）：hover 才出现操作提示 */
.devctl-git-item { outline: none; text-align: left; width: 100%; background: transparent; }
.devctl-git-item:hover { background: var(--dsw-alias-bg-layer-2) !important; }
.devctl-git-item.is-current { color: var(--dsw-alias-brand-primary); font-weight: 600; }
`
    function ensureChipCss() {
      if (typeof document === 'undefined' || document.getElementById('devctl-chip-css')) return
      const el = document.createElement('style')
      el.id = 'devctl-chip-css'
      el.textContent = CHIP_CSS
      document.head.appendChild(el)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureChipCss()
        ctx.locale.register('devctl', 'zh', {
          title: '项目运行器', subtitle: '状态面板 · 执行前确认',
          run: '运行', build: '打包', stop: '停止', refresh: '刷新',
          empty: '没有扫描到项目', noMatch: '没有匹配的项目', loading: '加载中…',
          frontend: '前端', backend: '后端', fullstack: '全栈', tool: '工具',
          running: '运行中', building: '打包中', failed: '失败',
          pick: '选入', drop: '剔除', dropped: '已剔除', byUser: '面板剔除', byConfig: '配置排除',
          more: '更多任务', fewer: '收起任务', search: '搜索项目…',
          project: '项目', task: '任务', cwd: '执行目录', runtime: '运行时', port: '端口',
          command: '命令', process: '实际进程', cancel: '取消', execute: '确认执行',
          confirmRun: '确认运行？', confirmBuild: '确认打包？',
          confirmHint: '执行前请确认以下指令', viewCommand: '查看命令',
          console: '控制台', back: '返回', undo: '撤销', copy: '复制', copied: '已复制',
          openUrl: '打开链接', clear: '清屏', autoScroll: '自动滚动', pauseScroll: '已暂停跟随',
          exited: '已退出', uptime: '已运行', pid: 'PID', encoding: '编码',
          buildOk: '上次打包成功', buildFail: '上次打包失败', never: '从未运行',
          done: '成功',
          emptyLog: '(还没有输出)',
          'platform.h5': 'H5',
          'platform.h5:ssr': 'H5 (SSR)',
          'platform.mp-weixin': '微信小程序',
          'platform.mp-alipay': '支付宝小程序',
          'platform.mp-baidu': '百度小程序',
          'platform.mp-qq': 'QQ 小程序',
          'platform.mp-toutiao': '抖音小程序',
          'platform.mp-lark': '飞书小程序',
          'platform.mp-kuaishou': '快手小程序',
          'platform.mp-jd': '京东小程序',
          'platform.mp-xhs': '小红书小程序',
          'platform.mp-harmony': '鸿蒙',
          'platform.quickapp-webview': '快应用',
          'platform.quickapp-webview-huawei': '快应用 (华为)',
          'platform.quickapp-webview-union': '快应用 (联盟)',
          'platform.custom': '自定义',
          'task.run': '运行',
          'task.debug': '调试',
          'task.build': '打包',
          'task.install': '安装',
          'task.dev': '启动',
          'task.test': '测试',
          'task.clean': '清理',
          'task.deps': '依赖树',
          'task.deploy': '发布',
          'section.build': '构建与维护',
          'section.release': '发布（写入私服）',
          confirmRelease: '确认发布到私服？',
          confirmReleaseHint: '这条命令会把产物上传到 Maven 私服，无法撤销',
          version: '版本',
          module: '模块',
          allModules: '全部模块',
          profile: '环境',
          noProfile: '不指定',
          moduleHint: '多模块仓可只处理其中一个',
          idle: '未运行',
          git: 'Git',
          'git.branch': '分支',
          'git.local': '本地分支',
          'git.remote': '远端分支',
          'git.remoteHint': '先 fetch 后在本地创建',
          'git.dirty': '有改动',
          'git.clean': '工作区干净',
          'git.noUpstream': '未跟踪远端',
          'git.detached': 'detached HEAD',
          'git.nonGit': '该目录不是 git 仓库',
          'git.fetch': '拉取远端信息 (fetch)',
          'git.pull': '更新 (pull)',
          'git.refresh': '刷新',
          'git.confirm.fetch': '确认 fetch？',
          'git.confirm.pull': '确认 pull？',
          'git.confirm.switch': '确认切换分支？',
          'git.confirm.update': '确认快进该分支？',
          'git.confirm.delete': '确认删除本地分支？',
          'git.deleteTip': '删除本地分支（仅已合并）',
          'git.deleteHint': '未合并的分支会被 git 拒绝；删除后可从远端重新拉取',
          'git.current': '当前',
          'git.diverged': '本地与远端已分叉（各有新提交），需合并处理',
          'git.gone': '远端已删',
          'git.goneTip': '远端分支已删除',
          'git.update': '更新',
          'git.updateTip': '不切分支，把该分支快进到远端（git fetch，仅 fast-forward）',
          'git.searchBranch': '搜索分支…',
          'git.untracked': '未跟踪',
          'git.aheadTip': '本地领先远端',
          'git.behindTip': '本地落后远端，可 pull',
          'git.switchTo': '切换到 ',
          'git.trackCreate': '创建本地跟踪分支 ',
        })
        ctx.locale.register('devctl', 'en', {
          title: 'Project runner', subtitle: 'Status panel · confirm before run',
          run: 'Run', build: 'Build', stop: 'Stop', refresh: 'Refresh',
          empty: 'No projects found', noMatch: 'No matching projects', loading: 'Loading…',
          frontend: 'Frontend', backend: 'Backend', fullstack: 'Full stack', tool: 'Tools',
          running: 'Running', building: 'Building', failed: 'Failed',
          pick: 'Include', drop: 'Exclude', dropped: 'Excluded', byUser: 'Excluded here', byConfig: 'Config exclude',
          more: 'More tasks', fewer: 'Hide tasks', search: 'Search projects…',
          project: 'Project', task: 'Task', cwd: 'Working dir', runtime: 'Runtime', port: 'Port',
          command: 'Command', process: 'Process', cancel: 'Cancel', execute: 'Run it',
          confirmRun: 'Run this?', confirmBuild: 'Build this?',
          confirmHint: 'Review the exact command before running', viewCommand: 'Show command',
          console: 'Console', back: 'Back', undo: 'Undo', copy: 'Copy', copied: 'Copied',
          openUrl: 'Open URL', clear: 'Clear', autoScroll: 'Follow', pauseScroll: 'Paused',
          exited: 'Exited', uptime: 'Uptime', pid: 'PID', encoding: 'Encoding',
          buildOk: 'Last build succeeded', buildFail: 'Last build failed', never: 'Never run',
          done: 'Done',
          emptyLog: '(no output yet)',
          'platform.h5': 'H5',
          'platform.h5:ssr': 'H5 (SSR)',
          'platform.mp-weixin': 'WeChat mini program',
          'platform.mp-alipay': 'Alipay mini program',
          'platform.mp-baidu': 'Baidu mini program',
          'platform.mp-qq': 'QQ mini program',
          'platform.mp-toutiao': 'Douyin mini program',
          'platform.mp-lark': 'Feishu mini program',
          'platform.mp-kuaishou': 'Kuaishou mini program',
          'platform.mp-jd': 'JD mini program',
          'platform.mp-xhs': 'Xiaohongshu mini program',
          'platform.mp-harmony': 'HarmonyOS',
          'platform.quickapp-webview': 'Quick app',
          'platform.quickapp-webview-huawei': 'Quick app (Huawei)',
          'platform.quickapp-webview-union': 'Quick app (Union)',
          'platform.custom': 'Custom',
          'task.run': 'Run',
          'task.debug': 'Debug',
          'task.build': 'Build',
          'task.install': 'Install',
          'task.dev': 'Dev',
          'task.test': 'Test',
          'task.clean': 'Clean',
          'task.deps': 'Dependencies',
          'task.deploy': 'Deploy',
          'section.build': 'Build & maintain',
          'section.release': 'Deploy (publishes)',
          confirmRelease: 'Publish to the repository?',
          confirmReleaseHint: 'This uploads artifacts to the Maven repository and cannot be undone',
          version: 'Version',
          module: 'Module',
          allModules: 'All modules',
          profile: 'Profile',
          noProfile: 'None',
          moduleHint: 'Limit to a single module of a multi-module repo',
          idle: 'Not running',
          git: 'Git',
          'git.branch': 'Branch',
          'git.local': 'Local branches',
          'git.remote': 'Remote branches',
          'git.remoteHint': 'fetch first, then create locally',
          'git.dirty': 'dirty',
          'git.clean': 'clean',
          'git.noUpstream': 'no upstream',
          'git.detached': 'detached HEAD',
          'git.nonGit': 'not a git repository',
          'git.fetch': 'Fetch',
          'git.pull': 'Pull',
          'git.refresh': 'Refresh',
          'git.confirm.fetch': 'Fetch this repo?',
          'git.confirm.pull': 'Pull this repo?',
          'git.confirm.switch': 'Switch branch?',
          'git.confirm.update': 'Fast-forward this branch?',
          'git.confirm.delete': 'Delete this local branch?',
          'git.deleteTip': 'Delete local branch (merged only)',
          'git.deleteHint': 'unmerged branches are rejected by git; you can re-fetch from remote',
          'git.current': 'current',
          'git.diverged': 'diverged from upstream (both have new commits); merge needed',
          'git.gone': 'gone',
          'git.goneTip': 'upstream branch was deleted',
          'git.update': 'update',
          'git.updateTip': 'fast-forward this branch to its remote without switching (git fetch, ff only)',
          'git.searchBranch': 'Search branches…',
          'git.untracked': 'untracked',
          'git.aheadTip': 'ahead of upstream',
          'git.behindTip': 'behind upstream, pull to update',
          'git.switchTo': 'Switch to ',
          'git.trackCreate': 'Create tracking branch ',
        })
        const t = ctx.locale.bind('devctl')

        function Panel() {
          const [open, setOpen] = useState(() => {
            try { return localStorage.getItem(LS_OPEN) === '1' } catch { return false }
          })
          const [width, setWidth] = useState(() => {
            try {
              const n = Number(localStorage.getItem(LS_WIDTH))
              return n >= 360 && n <= 960 ? n : 480
            } catch { return 480 }
          })
          const dragRef = useRef(null)
          const [projects, setProjects] = useState([])
          const [gitBranches, setGitBranches] = useState({})
          const [gitPanel, setGitPanel] = useState(null)
          const [gitConfirm, setGitConfirm] = useState(null)
          // 各项目最近一次 git-detail 的已知状态（脏/领先落后），行内 chip 展示用
          const [gitKnown, setGitKnown] = useState({})
          const [gitQuery, setGitQuery] = useState('')
          const [excluded, setExcluded] = useState([])
          const [running, setRunning] = useState([])
          const [recent, setRecent] = useState([])
          const [query, setQuery] = useState('')
          const [expanded, setExpanded] = useState(null)
          const [busy, setBusy] = useState('')
          const [notice, setNotice] = useState(null)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(true)
          const [confirm, setConfirm] = useState(null)
          // 控制台：{ runId, text, offset, ready, autoScroll }
          const [con, setCon] = useState(null)
          const conBodyRef = useRef(null)
          const conStateRef = useRef(null)

          useEffect(() => { conStateRef.current = con }, [con])

          useEffect(() => {
            try { localStorage.setItem(LS_OPEN, open ? '1' : '0') } catch { /* 忽略 */ }
          }, [open])

          // 左缘拖拽调宽：面板 fixed right:20，宽度 = 视口宽 - 20 - 鼠标 x
          const startDrag = (e) => {
            e.preventDefault()
            dragRef.current = { onMove: null }
            const onMove = (ev) => {
              const w = Math.min(960, Math.max(360, window.innerWidth - 20 - ev.clientX))
              setWidth(w)
            }
            const onUp = () => {
              dragRef.current = null
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
              document.body.style.userSelect = ''
              setWidth((w) => {
                try { localStorage.setItem(LS_WIDTH, String(Math.round(w))) } catch { /* 忽略 */ }
                return w
              })
            }
            document.body.style.userSelect = 'none'
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }

          const loadProjects = useCallback(async () => {
            try {
              const d = await call('/projects')
              setProjects(d.projects || [])
              setExcluded(d.excluded || [])
              setGitBranches(d.gitBranches || {})
              setError(null)
            } catch (e) {
              setError(e.message)
            } finally {
              setLoading(false)
            }
          }, [])

          const loadStatus = useCallback(async () => {
            try {
              const d = await call('/status')
              setRunning(d.running || [])
              setRecent(d.recent || [])
            } catch {
              /* 轮询失败不打断界面 */
            }
          }, [])

          useEffect(() => { loadProjects() }, [loadProjects])

          useEffect(() => {
            if (!open) return undefined
            loadStatus()
            const poll = setInterval(loadStatus, 3000)
            const tick = setInterval(() => setCon((c) => (c ? { ...c } : c)), 1000)
            return () => { clearInterval(poll); clearInterval(tick) }
          }, [open, loadStatus])

          // 控制台增量 tail：只拉新增字节，1.2s 一次
          useEffect(() => {
            if (!open || !con || !con.runId) return undefined
            const runId = con.runId
            let stopped = false
            const timer = setInterval(async () => {
              const cur = conStateRef.current
              if (stopped || !cur || cur.runId !== runId) return
              try {
                const d = await call(
                  `/logs?runId=${encodeURIComponent(runId)}&offset=${cur.offset ?? 0}`
                )
                if (stopped) return
                setCon((c) => {
                  if (!c || c.runId !== runId) return c
                  // webpack.Progress 这类心跳行在入口处就丢弃，只累计条数：
                  // 滞留在 text 里会让渲染期每次都要对几百 KB 做正则+split+join
                  let add = d.data || ''
                  let progCount = c.progCount || 0
                  if (add) {
                    add = stripAnsi(add)
                    if (c.hideProgress !== false) {
                      const lines = add.split('\n')
                      const kept = lines.filter((l) => !/webpack\.Progress/.test(l))
                      progCount += lines.length - kept.length
                      add = kept.join('\n')
                    }
                  }
                  const text = add ? c.text + add : c.text
                  return {
                    ...c,
                    text: text.length > 300000 ? text.slice(-300000) : text,
                    offset: d.offset,
                    progCount,
                  }
                })
              } catch {
                /* 单次失败继续下一次 */
              }
            }, 1200)
            return () => { stopped = true; clearInterval(timer) }
          }, [open, con && con.runId])

          // 跟随底部
          useEffect(() => {
            const el = conBodyRef.current
            if (el && con && con.autoScroll) el.scrollTop = el.scrollHeight
          }, [con && con.text, con && con.autoScroll])

          const act = async (label, fn) => {
            setBusy(label)
            setNotice(null)
            try {
              const msg = await fn()
              setNotice(msg)
              await loadStatus()
              if (msg && msg.reloadProjects) await loadProjects()
            } catch (e) {
              setNotice({ error: `${t('failed')}: ${e.message}` })
            } finally {
              setBusy('')
            }
          }

          const toggleMember = (id, mode) =>
            act(id, async () => {
              const r = await post(mode === 'exclude' ? '/exclude' : '/include', { id })
              return {
                text: r.status === 'visible' ? `${id} · ${t('pick')}` : `${id} · ${t('drop')}`,
                reloadProjects: true,
                undo: r.status === 'excluded' ? () => toggleMember(id, 'include') : null,
              }
            })

          const requestAction = async (project, task, mode) => {
            setNotice(null)
            setConfirm({
              mode, project, task, plan: null, loading: true, error: null,
              module: null, profile: null, pendingScope: null,
            })
            try {
              const plan = await post('/preview', { id: project.id, task: task.name })
              setConfirm((c) => (c ? { ...c, plan, loading: false } : c))
            } catch (e) {
              setConfirm((c) => (c ? { ...c, loading: false, error: e.message } : c))
            }
          }

          // 多模块仓 / 多环境仓：在弹层里切作用域（模块、profile），重算命令但不关弹层。
          // pendingScope 用来丢弃迟到的旧响应，避免连点时命令和选中项对不上。
          const pickScope = async (key, value) => {
            const cur = confirm
            if (!cur) return
            const next = {
              ...cur,
              [key]: value,
              pendingScope: `${key}:${value || ''}`,
              loading: true,
              error: null,
            }
            setConfirm(next)
            try {
              const plan = await post('/preview', {
                id: cur.project.id,
                task: cur.task.name,
                module: next.module || undefined,
                profile: next.profile || undefined,
              })
              setConfirm((c) =>
                c && c.pendingScope === next.pendingScope ? { ...c, plan, loading: false } : c
              )
            } catch (e) {
              setConfirm((c) =>
                c && c.pendingScope === next.pendingScope ? { ...c, loading: false, error: e.message } : c
              )
            }
          }

          // 任务名 → 展示用动词（发布 / 清理 / 测试 …），不依赖后文定义的 taskText
          const verbOf = (tk) => {
            const key = `task.${bareName(tk.name)}`
            const v = t(key)
            return v === key ? tk.label || tk.name : v
          }

          const executeConfirmed = async () => {
            const cur = confirm
            if (!cur || !cur.plan) return
            const { mode, project, task } = cur
            setConfirm(null)
            await act(project.id, async () => {
              if (mode === 'run') {
                const r = await post('/run', { id: project.id, task: task.name })
                return `${project.id} · ${task.name} → ${r.url || 'started'}`
              }
              const body = { id: project.id, task: task.name }
              if (cur.module) body.module = cur.module
              if (cur.profile) body.profile = cur.profile
              const r = await post('/build', body)
              if (r && r.busy) return `${project.id} 已在执行中（${r.runId}）`
              const scope = [cur.profile ? `-P ${cur.profile}` : null, cur.module ? `-pl ${cur.module}` : null]
                .filter(Boolean)
                .join(' ')
              return `${project.id} · ${verbOf(task)}${scope ? ` (${scope})` : ''} 已开始`
            })
          }

          const openConsole = async (runId) => {
            setConfirm(null)
            setCon({ runId, text: '', offset: null, ready: false, autoScroll: true })
            try {
              const d = await call(`/logs?runId=${encodeURIComponent(runId)}&lines=300`)
              const all = (d.lines || []).map(stripAnsi)
              const kept = all.filter((l) => !/webpack\.Progress/.test(l))
              setCon((c) =>
                c && c.runId === runId
                  ? {
                      ...c,
                      text: kept.join('\n'),
                      offset: d.offset,
                      ready: true,
                      path: d.path,
                      progCount: all.length - kept.length,
                    }
                  : c
              )
            } catch (e) {
              setCon((c) => (c && c.runId === runId ? { ...c, ready: true, error: e.message } : c))
            }
          }

          // 任务分类。先建一次索引，避免在循环里反复 projects.find（O(n·m)）
          const projectById = new Map(projects.map((p) => [p.id, p]))
          const taskDefOf = (projectId, taskName) => {
            const p = projectById.get(projectId)
            return p ? (p.tasks || []).find((x) => x.name === taskName) : undefined
          }
          const runInstances = []
          const buildInstances = []
          const runningByProject = {}
          for (const r of running) {
            const def = taskDefOf(r.projectId, r.task)
            const kind = def ? def.kind : 'run'
            if (kind === 'build') buildInstances.push({ ...r, label: def?.label })
            else { runInstances.push({ ...r, label: def?.label }); runningByProject[r.projectId] = r }
          }
          const buildingByProject = {}
          for (const b of buildInstances) {
            if (!buildingByProject[b.projectId]) buildingByProject[b.projectId] = []
            buildingByProject[b.projectId].push(b)
          }

          // 「上次打包」徽标只认产出产物的任务：清理/测试/依赖树/发布/安装都不算打包
          const NOT_A_PACKAGE = new Set(['install', 'test', 'clean', 'deps', 'deploy'])
          const bareName = (name) => String(name).split(':').pop()
          const lastBuild = {}
          for (const r of recent) {
            if (lastBuild[r.projectId]) continue
            if (NOT_A_PACKAGE.has(bareName(r.task))) continue
            const def = taskDefOf(r.projectId, r.task)
            if (def && def.kind === 'build') lastBuild[r.projectId] = r
          }

          const elapsedOf = (startedAt) =>
            fmt(Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)))

          const q = query.trim().toLowerCase()
          const visible = q
            ? projects.filter((p) => `${p.id} ${p.type} ${(p.tasks || []).map((x) => `${x.name} ${x.platform || ''}`).join(' ')}`.toLowerCase().includes(q))
            : projects
          const grouped = {}
          for (const p of visible) {
            const g = groupOf(p)
            if (!grouped[g]) grouped[g] = []
            grouped[g].push(p)
          }

          // 控制台对应的最新记录（从 status 里取，避免用过期的快照）
          const conRec = con
            ? running.find((r) => r.runId === con.runId) || recent.find((r) => r.runId === con.runId)
            : null

          const styles = {
            layer: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9000, fontFamily: 'inherit' },
            fab: {
              position: 'fixed', right: 20, bottom: 20, pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-overlay)',
              color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            },
            panel: {
              position: 'fixed', right: 20, bottom: 64, width: 480, maxHeight: '74vh',
              display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
              borderRadius: 12, border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 10px 32px rgba(0,0,0,0.24)',
              overflow: 'hidden', fontSize: 12, color: 'var(--dsw-alias-label-primary)',
            },
            resize: {
              position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize',
              zIndex: 10,
            },
            header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', gap: 8 },
            searchWrap: { padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
            search: {
              width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6, fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none',
            },
            body: { overflowY: 'auto', padding: '4px 0', flex: 1, minHeight: 120 },
            groupTitle: { padding: '8px 12px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            liveTitle: { padding: '8px 12px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: 2 },
            row: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' },
            name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
            btn: {
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '2px 7px',
              fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
            },
            btnRun: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
            btnStop: { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
            btnGhost: { borderColor: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
            notice: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
              borderTop: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
              maxHeight: 72, overflowY: 'auto', wordBreak: 'break-all',
            },
            noticeText: { flex: 1 },
            dot: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-state-success-primary)', display: 'inline-block', marginRight: 6 },
            dotBuild: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-state-warn-primary)', display: 'inline-block', marginRight: 6 },
            dotIdle: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-state-idle-primary)', display: 'inline-block', marginRight: 6 },
            badgeOk: { marginLeft: 6, fontSize: 10, color: 'var(--dsw-alias-state-success-primary)' },
            badgeFail: { marginLeft: 6, fontSize: 10, color: 'var(--dsw-alias-state-error-primary)' },
            taskBox: {
              padding: '6px 12px 10px 20px', display: 'flex', flexDirection: 'column', gap: 6,
              background: 'var(--dsw-alias-bg-layer-1)', borderTop: '1px solid var(--dsw-alias-border-l1)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
            chips: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
            taskGroupLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 },
            overlay: {
              position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-overlay)',
              display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '12px 14px',
            },
            confirmTitle: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
            kvRow: { display: 'flex', gap: 8, padding: '2px 0' },
            kvKey: { width: 62, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' },
            kvVal: { flex: 1, minWidth: 0, wordBreak: 'break-all' },
            cmdLabel: { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' },
            pre: {
              margin: '3px 0 0', padding: '7px 9px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              maxHeight: 150, overflowY: 'auto', userSelect: 'text',
            },
            actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
            skeletonRow: { display: 'flex', gap: 8, padding: '7px 12px', alignItems: 'center' },
            skelBar: { height: 9, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)' },
            conStatus: {
              display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
              marginBottom: 8,
            },
            conToolbar: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
            conBody: {
              flex: 1, minHeight: 160, margin: 0, padding: '8px 10px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              overflowY: 'auto', userSelect: 'text',
            },
          }

          // 选项 chip：单选，只有当前选中项描边
          const selChip = (on) => (on ? 'devctl-chip is-selected' : 'devctl-chip')

          // 一行单选作用域（模块 / 环境）：点一下重算命令，选中项描边
          const scopeRow = (label, current, noneLabel, items, key) =>
            h('div', { style: { marginTop: 8 } },
              h('div', { style: styles.cmdLabel }, `${label} · ${current || noneLabel} (${items.length})`),
              h('div', { style: styles.chips },
                h('button', {
                  key: '__none',
                  className: selChip(!current),
                  style: styles.btn,
                  onClick: () => pickScope(key, null),
                }, noneLabel),
                items.map((x) =>
                  h('button', {
                    key: x,
                    className: selChip(current === x),
                    style: styles.btn,
                    onClick: () => pickScope(key, x),
                  }, x))))

          const kv = (k, v) =>
            v == null || v === ''
              ? null
              : h('div', { key: k, style: styles.kvRow },
                  h('span', { style: styles.kvKey }, k),
                  h('span', { style: styles.kvVal }, String(v)))

          const noticeBar = () => {
            if (!notice) return null
            const isErr = Boolean(notice.error)
            return h('div', {
              style: { ...styles.notice, color: isErr ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' },
            },
              h('span', { style: styles.noticeText }, isErr ? notice.error : notice.text),
              isErr ? h('button', { style: styles.btn, onClick: () => navigator.clipboard?.writeText(notice.error) }, t('copy')) : null,
              notice && notice.undo ? h('button', {
                style: styles.btn,
                onClick: () => { const u = notice.undo; setNotice(null); u() },
              }, t('undo')) : null
            )
          }

          /* ---------------- git：Tier1 按需详情 + Tier2 显式操作 ---------------- */

          // 点开某个项目的 git 面板才拉详情（spawn git ~1s，不进热路径）
          const openGitPanel = useCallback(async (id) => {
            setConfirm(null)
            setCon(null)
            setGitQuery('')
            setGitPanel({ id, loading: true, data: null, error: null })
            try {
              const d = await call(`/git-detail?id=${encodeURIComponent(id)}`)
              setGitPanel((g) => (g && g.id === id ? { ...g, loading: false, data: d } : g))
              if (d && d.status && d.status.ok) {
                setGitKnown((k) => ({ ...k, [id]: d.status }))
              }
            } catch (e) {
              setGitPanel((g) => (g && g.id === id ? { ...g, loading: false, error: e.message } : g))
            }
          }, [])

          // git 写操作：先预演拿命令，弹确认卡（与 run/build 同款交互）。
          // op 'update' 时 remote 由分支 upstream 推出（面板已有数据，服务端预演零 spawn）
          const remoteOf = (b) => (b && b.upstream ? b.upstream.split('/')[0] : 'origin')

          const requestGitAction = async (op, id, branch, remote) => {
            // 立即给出点击反馈：git 面板进入 busy，避免"没有反应"的观感
            setGitPanel((g) => (g && g.id === id ? { ...g, cmdBusy: op } : g))
            try {
              const pv = await post('/git-action', { id, op, branch, remote, preview: true })
              setGitConfirm({ op, id, branch: branch || null, cmd: pv.cmd, cwd: pv.cwd, error: null })
            } catch (e) {
              console.error('[devctl] git preview failed:', e)
              const msg = `git ${op}: ${e.message}`
              setNotice({ error: msg })
              // 错误同时显示在 git 面板里（底部 notice 一行小字容易被忽略）
              setGitPanel((g) => (g && g.id === id ? { ...g, error: msg } : g))
            } finally {
              setGitPanel((g) => (g && g.id === id ? { ...g, cmdBusy: null } : g))
            }
          }

          const executeGitAction = async () => {
            const cur = gitConfirm
            if (!cur) return
            setGitConfirm(null)
            setBusy(`git:${cur.id}`)
            try {
              const r = await post('/git-action', {
                id: cur.id, op: cur.op, branch: cur.branch || undefined,
              })
              setNotice({ text: `${cur.id} · git ${cur.op} ${r.ok === false ? '失败' : '完成'}${r.out ? `：${String(r.out).split('\n')[0].slice(0, 120)}` : ''}` })
              await openGitPanel(cur.id) // 刷新详情（分支可能变了）
              await loadProjects()       // Tier0 分支名也可能变了
            } catch (e) {
              setNotice({ error: `git ${cur.op} 失败: ${e.message}` })
            } finally {
              setBusy('')
            }
          }

          const renderGitPanel = () => {
            const d = gitPanel.data
            const st = d && d.status
            const br = d && d.branches
            const tier0 = gitBranches[gitPanel.id]
            const known = gitKnown[gitPanel.id]
            const dirty = st && st.ok ? st.dirty : known ? known.dirty : null
            const ahead = st && st.ok ? st.ahead : known ? known.ahead : null
            const behind = st && st.ok ? st.behind : known ? known.behind : null
            const curBranch = (st && st.ok && st.branch) || tier0?.branch || t('git.detached')
            const isBusy = busy === `git:${gitPanel.id}`

            // 分支列表：搜索过滤，当前分支永远置顶；不含"最近分支"区（保持简洁）
            const qBranch = gitQuery.trim().toLowerCase()
            const localAll = (br && br.local) || []
            const match = (n) => !qBranch || n.toLowerCase().includes(qBranch)
            const curDef = localAll.find((b) => b.current)
            const others = localAll
              .filter((b) => !b.current && match(b.name))
              .sort((a, b) => a.name.localeCompare(b.name))
            const remotes = ((br && br.remote) || []).filter((r) => match(r.name))

            // GitLens 风格徽标
            const badge = (text, color, title) =>
              h('span', {
                title,
                style: {
                  display: 'inline-flex', alignItems: 'center', padding: '1px 6px', marginLeft: 4,
                  borderRadius: 999, fontSize: 10, fontWeight: 600,
                  background: 'var(--dsw-alias-bg-layer-2)', color,
                },
              }, text)

            // 分支行：整行可点（GitLens 式），右侧 hover 提示
            // 分支行：整行可点；右侧差异徽标——
            //   单向差异（只 ahead 或只 behind）绿色：可推送/可拉取
            //   双向分叉或远端已删（gone）红色：需要人工合并处理
            const trackBadge = (b) => {
              if (!b.upstream) return null
              if (b.gone) return badge('! ' + t('git.gone'), 'var(--dsw-alias-state-error-primary)', t('git.goneTip'))
              if (b.ahead && b.behind) {
                return badge(`↑${b.ahead} ↓${b.behind}`, 'var(--dsw-alias-state-error-primary)', t('git.diverged'))
              }
              if (b.ahead) return badge(`↑${b.ahead}`, 'var(--dsw-alias-state-success-primary)', t('git.aheadTip'))
              if (b.behind) return badge(`↓${b.behind}`, 'var(--dsw-alias-state-success-primary)', t('git.behindTip'))
              return null
            }

            const branchRow = (b, section) =>
              h('div', {
                key: `${section}-${b.name}`,
                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 6 },
              },
                h('button', {
                  className: b.current ? 'devctl-git-item is-current' : 'devctl-git-item',
                  style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', borderRadius: 6, border: 'none', cursor: b.current ? 'default' : 'pointer', color: 'inherit', fontSize: 12, flex: 1, minWidth: 0 },
                  disabled: b.current || isBusy,
                  onClick: () => requestGitAction('switch', gitPanel.id, b.name),
                },
                  h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    b.current ? `● ${b.name}` : `  ${b.name}`),
                  b.current ? h('span', { style: { ...styles.meta, fontSize: 10 } }, t('git.current')) : null),
                trackBadge(b),
                // 非当前分支落后远端 → 不切分支原地快进（fetch refspec，只 ff）
                !b.current && b.behind && !b.ahead
                  ? h('button', {
                      style: { ...styles.btn, fontSize: 10, padding: '1px 6px' },
                      disabled: isBusy || Boolean(gitPanel.cmdBusy),
                      title: t('git.updateTip'),
                      onClick: () => requestGitAction('update', gitPanel.id, b.name, remoteOf(b)),
                    }, gitPanel.cmdBusy === 'update' ? '…' : `⟳ ${t('git.update')}`)
                  : null,
                // 删除本地分支（仅已合并；当前分支不给删）
                !b.current
                  ? h('button', {
                      style: { ...styles.btn, ...styles.btnGhost, color: 'var(--dsw-alias-state-error-primary)', fontSize: 10, padding: '1px 5px' },
                      disabled: isBusy || Boolean(gitPanel.cmdBusy),
                      title: t('git.deleteTip'),
                      onClick: () => requestGitAction('delete', gitPanel.id, b.name),
                    }, '×')
                  : null)

            return h('div', { style: { ...styles.overlay, padding: '10px 12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                h('div', null,
                  h('div', { style: styles.confirmTitle }, `${t('git')} · ${gitPanel.id}`)),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h('button', { style: styles.btn, disabled: isBusy, onClick: () => openGitPanel(gitPanel.id), title: t('git.refresh') }, '⟳'),
                  h('button', { style: styles.btn, onClick: () => setGitPanel(null) }, t('back')))),

              // 状态卡：当前分支 + 徽标
              h('div', { style: styles.conStatus },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                  h('span', { style: { ...styles.dot, ...(dirty ? { background: 'var(--dsw-alias-state-warn-primary)' } : {}) } }),
                  h('b', { style: { fontSize: 13 } }, `⎇ ${curBranch}`),
                  ahead != null && ahead > 0 ? badge(`↑${ahead}`, 'var(--dsw-alias-state-success-primary)', t('git.aheadTip')) : null,
                  behind != null && behind > 0 ? badge(`↓${behind}`, 'var(--dsw-alias-state-warn-primary)', t('git.behindTip')) : null,
                  dirty != null && dirty > 0
                    ? badge(`±${dirty}`, 'var(--dsw-alias-state-warn-primary)', t('git.dirty'))
                    : dirty === 0 ? badge('✓', 'var(--dsw-alias-state-success-primary)', t('git.clean')) : null),
                h('div', { style: styles.meta },
                  [st && st.ok ? st.upstream || t('git.noUpstream') : null,
                   st && st.ok && st.untracked ? `${st.untracked} ${t('git.untracked')}` : null].filter(Boolean).join(' · '))),

              // 操作栏：behind>0 时 pull 高亮
              h('div', { style: styles.conToolbar },
                h('button', { style: styles.btn, disabled: isBusy, title: t('git.confirm.fetch'), onClick: () => requestGitAction('fetch', gitPanel.id) }, `⟳ ${t('git.fetch')}`),
                h('button', {
                  style: behind > 0 ? { ...styles.btn, ...styles.btnRun } : styles.btn,
                  disabled: isBusy, title: t('git.confirm.pull'),
                  onClick: () => requestGitAction('pull', gitPanel.id),
                }, `⇣ ${t('git.pull')}${behind > 0 ? ` (${behind})` : ''}`)),

              gitPanel.loading ? h('div', { style: { ...styles.meta, padding: '12px 0' } }, t('loading')) : null,
              gitPanel.error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: '8px 0' } }, gitPanel.error) : null,
              st && !st.ok ? h('div', { style: { ...styles.meta, padding: '8px 0' } }, t('git.nonGit')) : null,

              // 分支列表（有数据才渲染）
              br && br.ok
                ? h('div', null,
                    // 搜索框（分支多时才有意义，>8 个显示）
                    localAll.length + ((br.remote && br.remote.length) || 0) > 8
                      ? h('div', { style: { marginTop: 6 } },
                          h('input', {
                            style: styles.search, value: gitQuery, placeholder: t('git.searchBranch'),
                            onChange: (e) => setGitQuery(e.target.value),
                          }))
                      : null,
                    curDef && match(curDef.name)
                      ? h('div', { style: { marginTop: 8 } },
                          branchRow(curDef, 'cur'))
                      : null,
                    others.length
                      ? h('div', null,
                          h('div', { style: styles.taskGroupLabel }, `${t('git.local')} (${others.length})`),
                          others.map((b) => branchRow(b, 'local')))
                      : null,
                    remotes.length
                      ? h('div', { style: { marginTop: 10 } },
                          h('div', { style: styles.taskGroupLabel }, `${t('git.remote')} (${remotes.length}) · ${t('git.remoteHint')}`),
                          remotes.slice(0, 50).map((r) => {
                            // 去掉 origin/ 前缀：git switch <name> 会 DWIM 自动建本地跟踪分支
                            const short = r.name.replace(/^[^/]+\//, '')
                            const exists = localAll.some((b) => b.name === short)
                            return h('button', {
                              key: `remote-${r.name}`,
                              className: 'devctl-git-item',
                              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12 },
                              disabled: isBusy,
                              onClick: () => requestGitAction('switch', gitPanel.id, short),
                              title: exists ? t('git.switchTo') + short : `${t('git.trackCreate')} ${short}`,
                            },
                              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `  ${short}`),
                              h('span', { style: { ...styles.meta, fontSize: 10 } }, exists ? '' : '+track'))
                          }))
                      : null)
                : null)
          }

          const renderGitConfirm = () => {
            const isDelete = gitConfirm.op === 'delete'
            return h('div', { style: styles.overlay },
              h('div', { style: { ...styles.confirmTitle, ...(isDelete ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) } },
                t(`git.confirm.${gitConfirm.op}`)),
              h('div', { ...styles.meta, marginBottom: 8 }, t('confirmHint')),
              isDelete
                ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } }, `! ${t('git.deleteHint')}`)
                : null,
              kv(t('project'), gitConfirm.id),
              gitConfirm.branch ? kv(t('git.branch'), gitConfirm.branch) : null,
              kv(t('cwd'), gitConfirm.cwd),
              h('div', { style: styles.cmdLabel }, t('command')),
              h('pre', { style: styles.pre }, gitConfirm.cmd),
              h('div', { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setGitConfirm(null) }, t('cancel')),
                h('button', {
                  style: isDelete
                    ? { ...styles.btn, ...styles.btnStop }
                    : { ...styles.btn, ...styles.btnRun },
                  onClick: executeGitAction,
                }, t('execute'))))
          }

          const renderConfirm = () => {
            const { mode, project, task, plan, loading: planLoading, error: planError } = confirm
            const isRelease = task.section === 'release'
            return h('div', { style: styles.overlay },
              h('div', { style: styles.confirmTitle },
                isRelease ? t('confirmRelease') : mode === 'run' ? t('confirmRun') : t('confirmBuild')),
              h('div', {
                style: { ...styles.meta, marginBottom: 8, ...(isRelease ? { color: 'var(--dsw-alias-state-warn-primary)' } : {}) },
              }, isRelease ? t('confirmReleaseHint') : t('confirmHint')),
              kv(t('project'), project.id),
              kv(t('version'), plan ? plan.version : null),
              kv(t('task'), `${taskText(task)}  (${task.name})`),
              planLoading && !plan
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
                    h('div', { style: { ...styles.skelBar, width: '70%' } }),
                    h('div', { style: { ...styles.skelBar, width: '90%' } }),
                    h('div', { style: { ...styles.skelBar, width: '45%' } }))
                : null,
              planError ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 } }, planError) : null,
              plan && plan.note
                ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } }, `! ${plan.note}`)
                : null,
              plan
                ? h('div', null,
                    plan.modules && plan.modules.length && task.kind !== 'run'
                      ? scopeRow(t('module'), plan.module, t('allModules'), plan.modules, 'module')
                      : null,
                    plan.envProfiles && plan.envProfiles.length && task.kind !== 'run'
                      ? scopeRow(t('profile'), plan.profile, t('noProfile'), plan.envProfiles, 'profile')
                      : null,
                    kv(t('cwd'), plan.cwd),
                    kv(t('runtime'), plan.type === 'mvn' ? `java ${plan.javaHome || ''}` : plan.type === 'shell' ? 'shell' : `node ${plan.nodeVersion}`),
                    kv(t('port'), plan.port ? `${plan.port}  ${plan.url || ''}` : null),
                    plan.debugPort ? kv('调试端口', `${plan.debugPort}（IDE attach 到 localhost:${plan.debugPort}）`) : null,
                    plan.debug ? kv('启动方式', 'suspend=n —— 应用照常启动，随时可以 attach') : null,
                    h('div', { style: styles.cmdLabel }, t('command')),
                    h('pre', { style: styles.pre }, plan.display),
                    h('div', { style: styles.cmdLabel }, t('process')),
                    h('pre', { style: styles.pre }, [plan.cmd, ...(plan.args || [])].join(' ')),
                    (plan.warnings || []).length
                      ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 8 } },
                          plan.warnings.map((w, i) => h('div', { key: i }, `! ${w}`)))
                      : null)
                : null,
              h('div', { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setConfirm(null) }, t('cancel')),
                h('button', { style: { ...styles.btn, ...styles.btnRun }, disabled: planLoading || !plan, onClick: executeConfirmed }, t('execute')))
            )
          }

          const renderConsole = () => {
            const rec = conRec
            const isRun = rec && rec.status === 'running'
            // webpack.Progress 已在拉取时按行丢弃（见日志增量 effect），这里只读计数
            const rawText = (con && con.text) || ''
            const hideProg = !con || con.hideProgress !== false
            const progressCount = (con && con.progCount) || 0
            // <pre> 里塞几十万字符会拖垮 re-render，只渲染尾部 1500 行
            const MAX_RENDER_LINES = 1500
            const shownLines = rawText.split('\n')
            const shownText =
              shownLines.length > MAX_RENDER_LINES
                ? `…（已省略 ${shownLines.length - MAX_RENDER_LINES} 行）\n${shownLines.slice(-MAX_RENDER_LINES).join('\n')}`
                : rawText
            const kindLabel = rec && (runningByProject[rec.projectId] || buildingByProject[rec.projectId])
              ? (runningByProject[rec.projectId] ? t('running') : t('building'))
              : rec ? (rec.status === 'success' ? t('done') : rec.status) : ''
            return h('div', { style: { ...styles.overlay, padding: '10px 12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                h('div', null,
                  h('div', { style: styles.confirmTitle }, `${t('console')} · ${rec ? rec.projectId : con.runId}`),
                  h('div', { style: styles.meta }, rec ? rec.task : '')),
                h('button', { style: styles.btn, onClick: () => setCon(null) }, t('back'))),

              h('div', { style: styles.conStatus },
                h('div', null,
                  h('span', { style: isRun ? styles.dot : styles.dotIdle }),
                  kindLabel,
                  rec ? h('span', { style: { marginLeft: 8 } }, `${t('pid')} ${rec.pid ?? '-'}`) : null,
                  rec && isRun ? h('span', { style: { marginLeft: 8 } }, `${t('uptime')} ${elapsedOf(rec.startedAt)}`) : null,
                  rec && !isRun && rec.exitCode != null ? h('span', { style: { marginLeft: 8 } }, `${t('exited')} · exit ${rec.exitCode}`) : null),
                h('div', { style: styles.meta },
                  [rec && rec.url ? rec.url : null, rec && rec.nodeVersion ? `node ${rec.nodeVersion}` : null,
                   rec && rec.encoding ? `${t('encoding')} ${rec.encoding}` : null].filter(Boolean).join(' · ')),
                h('div', { style: styles.meta }, rec ? rec.cwd : '')),

              h('div', { style: styles.conToolbar },
                isRun
                  ? h('button', {
                      style: { ...styles.btn, ...styles.btnStop },
                      disabled: busy === rec.runId,
                      onClick: () => act(rec.runId, async () => {
                        await post('/stop', { runId: rec.runId })
                        return `${rec.projectId} 已停止`
                      }),
                    }, t('stop'))
                  : null,
                rec && rec.url ? h('button', { style: styles.btn, onClick: () => window.open(rec.url, '_blank') }, t('openUrl')) : null,
                h('button', { style: styles.btn, onClick: () => setCon((c) => (c ? { ...c, text: '' } : c)) }, t('clear')),
                h('button', {
                  style: con && con.autoScroll ? { ...styles.btn, ...styles.btnRun } : styles.btn,
                  onClick: () => setCon((c) => (c ? { ...c, autoScroll: !c.autoScroll } : c)),
                }, con && con.autoScroll ? `✓ ${t('autoScroll')}` : t('autoScroll')),
                progressCount
                  ? h('button', {
                      style: hideProg ? { ...styles.btn, ...styles.btnRun } : styles.btn,
                      onClick: () => setCon((c) => (c ? { ...c, hideProgress: !hideProg } : c)),
                    }, hideProg ? `✓ 隐藏进度 (${progressCount})` : `隐藏进度 (${progressCount})`)
                  : null),

              con && con.error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 6 } }, con.error) : null,
              h('pre', {
                ref: conBodyRef,
                style: styles.conBody,
                onScroll: (e) => {
                  const el = e.target
                  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                  if (!atBottom && con && con.autoScroll) setCon((c) => (c ? { ...c, autoScroll: false } : c))
                },
              }, shownText || (con && con.ready ? t('emptyLog') : t('loading')))
            )
          }

          const taskGroups = (tasks) => {
            // 平台分组只看探测器给的 platform 字段。不要从任务名里的冒号去猜——
            // 否则 package:dev 这类自定义任务名会被当成一个叫 dev 的平台。
            if (!tasks.some((x) => x.platform)) {
              return { plain: true, run: tasks.filter((x) => x.kind === 'run'), build: tasks.filter((x) => x.kind === 'build') }
            }
            const byPlat = new Map()
            for (const tk of tasks) {
              const plat = tk.platform || 'other'
              if (!byPlat.has(plat)) byPlat.set(plat, [])
              byPlat.get(plat).push(tk)
            }
            const order = [...PLATFORM_ORDER.filter((p) => byPlat.has(p)), ...[...byPlat.keys()].filter((p) => !PLATFORM_ORDER.includes(p))]
            return { plain: false, platforms: order.map((p) => ({ plat: p, tasks: byPlat.get(p) })) }
          }

          // 任务展示文案：探测器只给结构化事实（name/kind/platform/detail），翻译在这里做
          const taskText = (tk) => {
            if (tk.platform) {
              const key = `platform.${tk.platform}`
              const translated = t(key)
              const plat = translated === key ? tk.platform : translated
              const isBuild = (tk.action || (tk.kind === 'build' ? 'build' : 'dev')) === 'build'
              return `${plat} · ${isBuild ? t('build') : t('run')}`
            }
            // 按任务名查文案：run / debug / build / install / test / deploy …
            // （debug 的 kind 也是 run，只看 kind 会和 run 撞成同一个名字）
            const nameKey = `task.${String(tk.name).split(':').pop()}`
            const byName = t(nameKey)
            const base = byName === nameKey ? null : byName
            if (base) return tk.detail ? `${base} (${tk.detail})` : base
            if (tk.detail) return `${t(tk.kind === 'build' ? 'build' : 'run')} (${tk.detail})`
            if (tk.label && tk.label !== tk.name) return tk.label
            return tk.name
          }

          const chip = (p, tk, kind) =>
            h('button', {
              key: `${kind}-${tk.name}`,
              className: tk.section === 'release' ? 'devctl-chip is-release' : 'devctl-chip',
              style: styles.btn,
              disabled: busy === p.id,
              title: [tk.name, tk.note].filter(Boolean).join('\n'),
              onClick: () => requestAction(p, tk, kind),
            }, taskText(tk))

          const rows = []

          if (runInstances.length) {
            rows.push(h('div', { key: 'h-run', style: styles.liveTitle }, `${t('running')} ${runInstances.length}`))
            for (const r of runInstances) {
              rows.push(
                h('div', { key: `run-${r.runId}`, style: styles.row },
                  h('div', { style: styles.name },
                    h('span', { style: styles.dot }), r.projectId,
                    h('div', { style: styles.meta }, `${r.task}${r.url ? ` · ${r.url}` : ''} · ${elapsedOf(r.startedAt)}`)),
                  h('button', { style: styles.btn, onClick: () => openConsole(r.runId) }, t('console')),
                  h('button', {
                    style: { ...styles.btn, ...styles.btnStop }, disabled: busy === r.runId,
                    onClick: () => act(r.runId, async () => {
                      await post('/stop', { runId: r.runId })
                      return `${r.projectId} 已停止`
                    }),
                  }, t('stop')))
              )
            }
          }

          if (buildInstances.length) {
            rows.push(h('div', { key: 'h-build', style: styles.liveTitle }, `${t('building')} ${buildInstances.length}`))
            for (const r of buildInstances) {
              rows.push(
                h('div', { key: `build-${r.runId}`, style: styles.row },
                  h('div', { style: styles.name },
                    h('span', { style: styles.dotBuild }), r.projectId,
                    h('div', { style: styles.meta }, `${r.task} · ${elapsedOf(r.startedAt)}`)),
                  h('button', { style: styles.btn, onClick: () => openConsole(r.runId) }, t('console')),
                  h('button', {
                    style: { ...styles.btn, ...styles.btnStop }, disabled: busy === r.runId,
                    onClick: () => act(r.runId, async () => {
                      await post('/stop', { runId: r.runId })
                      return `${r.projectId} 打包已中止`
                    }),
                  }, t('stop')))
              )
            }
          }

          if (loading && !projects.length) {
            for (let i = 0; i < 6; i++) {
              rows.push(h('div', { key: `sk-${i}`, style: styles.skeletonRow },
                h('div', { style: { ...styles.skelBar, width: `${40 + ((i * 13) % 30)}%` } }),
                h('div', { style: { ...styles.skelBar, width: 34, marginLeft: 'auto' } }),
                h('div', { style: { ...styles.skelBar, width: 34 } })))
            }
          }

          for (const g of GROUPS) {
            const list = grouped[g]
            if (!list || !list.length) continue
            rows.push(h('div', { key: `g-${g}`, style: styles.groupTitle }, t(g)))
            for (const p of list) {
              const runTasks = (p.tasks || []).filter((x) => x.kind === 'run')
              const buildTasks = (p.tasks || []).filter((x) => x.kind === 'build')
              const taskCount = runTasks.length + buildTasks.length
              const isOpen = expanded === p.id
              const live = runningByProject[p.id]
              const building = buildingByProject[p.id]
              const last = lastBuild[p.id]
              const isBusy = busy === p.id

              let meta
              if (live) meta = `${t('running')} ${live.url || ''} · ${elapsedOf(live.startedAt)}`
              else if (building) meta = `${t('building')}… · ${building.map((b) => b.task).join(', ')}`
              else meta = `${t('idle')} · ${p.type}${p.node ? ` · n${p.node}` : ''}${taskCount ? ` · ${taskCount} 个任务` : ''}`

              rows.push(
                h('div', { key: p.id, style: styles.row },
                  h('div', {
                    style: styles.name,
                    title: [p.id, p.packageName && p.packageName !== p.id ? `package: ${p.packageName}` : null, p.basePort ? `端口 ${p.basePort}` : null].filter(Boolean).join('\n'),
                  },
                    h('span', { style: live ? styles.dot : building ? styles.dotBuild : styles.dotIdle }),
                    p.id,
                    last && !live && !building
                      ? h('span', {
                          style: last.status === 'success' ? styles.badgeOk : styles.badgeFail,
                          title: `${last.status === 'success' ? t('buildOk') : t('buildFail')} · ${last.task}`,
                        }, `${last.status === 'success' ? '✓' : '✗'} ${last.durationMs ? fmt(Math.round(last.durationMs / 1000)) : ''}`)
                      : null,
                    h('div', { style: styles.meta }, meta)),
                  gitBranches[p.id]
                    ? h('button', {
                        style: styles.btn,
                        title: t('git'),
                        onClick: () => openGitPanel(p.id),
                      }, (() => {
                        const g = gitBranches[p.id]
                        const kn = gitKnown[p.id]
                        const label = g.detached ? (g.sha || 'detached') : g.branch
                        const mark =
                          kn && kn.dirty ? '±' : kn && kn.ahead > 0 ? '↑' : kn && kn.behind > 0 ? '↓' : ''
                        return `⎇ ${label}${mark}`
                      })())
                    : null,
                  // 运行中实例的 停止/控制台 按钮只在顶部「运行中/打包中」区展示，
                  // 普通列表行不再重复（meta 文案已标明运行状态）
                  taskCount
                    ? h('button', {
                        style: styles.btn, disabled: isBusy,
                        title: isOpen ? t('fewer') : t('more'),
                        onClick: () => setExpanded(isOpen ? null : p.id),
                      }, isOpen ? '▴' : '▾')
                    : null,
                  h('button', { style: { ...styles.btn, ...styles.btnGhost }, disabled: isBusy, title: t('drop'), onClick: () => toggleMember(p.id, 'exclude') }, '×'))
              )

              if (isOpen) {
                const grp = taskGroups([...runTasks, ...buildTasks])
                const kindOf = (tk) => (tk.kind === 'run' ? 'run' : 'build')
                // 发布类任务单独一组：它会把产物写到私服，和普通打包风险级别不同
                const relTasks = buildTasks.filter((x) => x.section === 'release')
                const mntTasks = buildTasks.filter((x) => x.section !== 'release')
                const buildLabel = relTasks.length ? t('section.build') : t('build')
                rows.push(
                  h('div', { key: `${p.id}-tasks`, style: styles.taskBox },
                    grp.plain
                      ? [
                          runTasks.length ? h('div', { key: 'r', style: styles.taskGroupLabel }, `${t('run')} (${runTasks.length})`) : null,
                          runTasks.length ? h('div', { key: 'rc', style: styles.chips }, runTasks.map((tk) => chip(p, tk, 'run'))) : null,
                          mntTasks.length ? h('div', { key: 'b', style: styles.taskGroupLabel }, `${buildLabel} (${mntTasks.length})`) : null,
                          mntTasks.length ? h('div', { key: 'bc', style: styles.chips }, mntTasks.map((tk) => chip(p, tk, 'build'))) : null,
                          relTasks.length ? h('div', { key: 'd', style: styles.taskGroupLabel }, `${t('section.release')} (${relTasks.length})`) : null,
                          relTasks.length ? h('div', { key: 'dc', style: styles.chips }, relTasks.map((tk) => chip(p, tk, 'build'))) : null,
                        ]
                      : grp.platforms.map(({ plat, tasks }) =>
                          h('div', { key: plat },
                            h('div', { style: styles.taskGroupLabel },
                              t(`platform.${plat}`) === `platform.${plat}` ? plat : t(`platform.${plat}`)),
                            h('div', { style: styles.chips }, tasks.map((tk) => chip(p, tk, kindOf(tk)))))))
                )
              }
            }
          }

          if (!loading && !visible.length) {
            rows.push(h('div', { key: 'no-match', style: styles.groupTitle }, q ? t('noMatch') : t('empty')))
          }

          if (excluded.length) {
            rows.push(h('div', {
              key: 'g-excluded',
              style: { ...styles.groupTitle, borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 4, paddingTop: 10 },
            }, `${t('dropped')} ${excluded.length}`))
            for (const e of excluded) {
              rows.push(
                h('div', { key: `x-${e.id}`, style: styles.row },
                  h('div', { style: styles.name, title: e.pattern ? `排除规则: ${e.pattern}` : '' },
                    h('span', { style: { ...styles.meta, marginRight: 0 } }, e.id),
                    h('div', { style: styles.meta }, e.reason === 'user' ? t('byUser') : t('byConfig'))),
                  h('button', { style: styles.btn, disabled: busy === e.id, onClick: () => toggleMember(e.id, 'include') }, t('pick')))
              )
            }
          }

          const counts = [
            `${projects.length} 个项目`,
            `${runInstances.length} ${t('running')}`,
            buildInstances.length ? `${buildInstances.length} ${t('building')}` : null,
            excluded.length ? `${excluded.length} ${t('dropped')}` : null,
          ].filter(Boolean).join(' · ')

          return h('div', { style: styles.layer },
            open
              ? h('div', { style: { ...styles.panel, width } },
                  h('div', { style: styles.resize, onMouseDown: startDrag, title: '拖拽调宽' }),
                  h('div', { style: styles.header },
                    h('div', null,
                      h('div', { style: { fontWeight: 600 } }, t('title')),
                      h('div', { style: styles.meta }, confirm ? t('confirmHint') : con ? t('console') : counts)),
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('button', {
                        style: styles.btn,
                        onClick: () => { setConfirm(null); setCon(null); setGitPanel(null); setGitConfirm(null); loadProjects(); loadStatus() },
                      }, t('refresh')),
                      h('button', { style: styles.btn, onClick: () => { setConfirm(null); setCon(null); setGitPanel(null); setGitConfirm(null); setOpen(false) } }, '×'))),
                  h('div', { style: styles.searchWrap },
                    h('input', {
                      style: styles.search, value: query, placeholder: t('search'),
                      onChange: (e) => setQuery(e.target.value),
                    })),
                  h('div', { style: styles.body }, rows),
                  noticeBar(),
                  gitPanel ? renderGitPanel() : null,
                  confirm ? renderConfirm() : null,
                  con ? renderConsole() : null,
                  gitConfirm ? renderGitConfirm() : null)
              : null,
            h('button', {
              style: styles.fab,
              onClick: () => {
                const next = !open
                setOpen(next)
                if (next) { loadProjects(); loadStatus() }
              },
              title: t('subtitle'),
            }, '▦ ', t('title'), runInstances.length || buildInstances.length ? ` · ${runInstances.length + buildInstances.length}` : '')
          )
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'devctl.panel', order: 60 }, Panel)
        )
      },
    }
  },
})
