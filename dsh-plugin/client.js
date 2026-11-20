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
/* 项目行 hover 反馈（内联样式写不了 :hover） */
.devctl-row { outline: none; }
.devctl-row:hover { background: var(--dsw-alias-bg-layer-1); }
/* 关闭按钮：无边框 ×，hover 加底变亮（常见模态关闭样式） */
.devctl-close-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
/* ---- 布局规范化（容器查询：窄态收次要徽标，宽态限行长）---- */
.devctl-panel-root { container-type: inline-size; }
.devctl-panel-root :is(button, input, [tabindex]):focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
@container (max-width: 379px) {
  .devctl-badge-optional { display: none; }
}
@container (min-width: 700px) {
  .devctl-readable { max-width: 680px; }
}
/* 变更文件行：整行可点（切换暂存），hover 反馈；冲突行浅红底 */
.devctl-file-row { outline: none; border-radius: 4px; cursor: pointer; }
.devctl-file-row:hover { background: var(--dsw-alias-bg-layer-2); }
.devctl-file-row.is-conflict { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.devctl-file-row.is-conflict:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.devctl-git-item.is-current { color: var(--dsw-alias-brand-primary); font-weight: 600; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); border-radius: 6px; }
`
    function ensureChipCss() {
      if (typeof document === 'undefined' || document.getElementById('devctl-chip-css')) return
      const el = document.createElement('style')
      el.id = 'devctl-chip-css'
      el.textContent = CHIP_CSS
      document.head.appendChild(el)
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ensureChipCss()
        ctx.locale.register('devctl', 'zh', {
          title: '项目运行器', subtitle: '状态面板 · 执行前确认',
          run: '运行', build: '打包', stop: '停止', refresh: '刷新',
          empty: '没有扫描到项目', noMatch: '没有匹配的项目', loading: '加载中…',
          'emptyHint': '工作区根目录下需要有 package.json / pom.xml 的项目才会被识别',
          'noMatchHint': '换个关键词，或清空搜索框看全部项目',
          'expandGroup': '展开该分组',
          'collapseGroup': '收起该分组',
          'quickRunHint': '本次会话内直接运行该任务（不再弹确认，刷新后恢复）',
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
          'nav.projects': '项目列表',
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
          'git.vsBase': '相对',
          'git.baseBehind': '落后',
          'git.baseAhead': '超前',
          'git.notTracking': '未跟踪',
          'git.notTrackingTip': '远端已有同名分支，但本地没设置 upstream；可执行 git branch --set-upstream-to 关联',
          'git.noRemote': '无远端',
          'git.noRemoteTip': '远端当前没有同名分支：可能从未推送，也可能已在远端删除',
          'git.merge': '合并',
          'git.mergeTip': '把该分支合并进当前分支（git merge --no-edit）',
          'git.confirm.merge': '确认合并该分支？',
          'git.confirm.merge-abort': '确认放弃合并？',
          'git.mergeAbortHint': '工作区与暂存区将回到合并前的状态，冲突标记全部清除',
          'git.conflictBanner': '存在未解决的合并冲突',
          'git.abort': '放弃合并',
          'git.files': '变更文件',
          'git.filesHint': '点击徽标展开/收起变更文件清单',
          'git.filesTruncated': '清单过长已截断，完整状态请看 git status',
          'git.f.added': '新增',
          'git.f.deleted': '删除',
          'git.f.modified': '修改',
          'git.f.renamed': '重命名',
          'git.f.copied': '复制',
          'git.f.conflict': '冲突',
          'git.f.untracked': '未跟踪',
          'git.commit': '提交',
          'git.commitTitle': '提交本地变更',
          'git.commitMsgPh': '提交信息（必填，≤500 字符）…',
          'git.commitNudge': '先把文件加入待提交区（点变更区的 +）',
          'git.confirm.commit': '确认提交？',
          'git.commitMsgLabel': '提交信息',
          'git.staged': '待提交',
          'git.unstaged': '变更',
          'git.stageAll': '全部暂存',
          'git.unstageAll': '全部取消',
          'git.stageSel': '暂存已选',
          'git.unstageSel': '取消已选',
          'git.untrackedNew': '未跟踪新文件',
          'git.diffEmpty': '没有差异内容',
          'git.openFull': '完整文件',
          'git.openFullTip': '在右侧边栏以文件预览打开完整内容',
          'git.legend': '+ 新增（已暂存的新文件）\n~ 修改（内容有改动）\n- 删除\n→ 重命名（悬浮看旧路径）\n? 未跟踪的新文件\n⚠ 合并冲突未解决\n\n目录后的数字 = 该目录下的变更文件总数',
          'git.stageTip': '加入待提交区（git add）',
          'git.unstageTip': '移出待提交区（git reset HEAD，不动文件内容）',
          'git.stageConflictTip': '标记冲突已解决并加入待提交区（git add）',
          'git.push': '推送',
          'git.pushTip': '推送到远端（无 upstream 时自动 -u origin 当前分支）',
          'git.confirm.push': '确认推送？',
        })
        ctx.locale.register('devctl', 'en', {
          title: 'Project runner', subtitle: 'Status panel · confirm before run',
          run: 'Run', build: 'Build', stop: 'Stop', refresh: 'Refresh',
          empty: 'No projects found', noMatch: 'No matching projects', loading: 'Loading…',
          'emptyHint': 'projects need a package.json / pom.xml under the workspace root',
          'noMatchHint': 'try another keyword or clear the search',
          'expandGroup': 'Expand this group',
          'collapseGroup': 'Collapse this group',
          'quickRunHint': 'run this task directly for this session (no confirm; resets on refresh)',
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
          'nav.projects': 'Projects',
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
          'git.vsBase': 'vs',
          'git.baseBehind': 'behind',
          'git.baseAhead': 'ahead',
          'git.notTracking': 'not tracking',
          'git.notTrackingTip': 'the remote already has this branch, but locally no upstream is set; run git branch --set-upstream-to',
          'git.noRemote': 'no remote',
          'git.noRemoteTip': 'no same-named branch on the remote now: it may never have been pushed, or was deleted there',
          'git.merge': 'merge',
          'git.mergeTip': 'merge this branch into the current one (git merge --no-edit)',
          'git.confirm.merge': 'Merge this branch?',
          'git.confirm.merge-abort': 'Abort the merge?',
          'git.mergeAbortHint': 'working tree and index return to the pre-merge state; all conflict markers are cleared',
          'git.conflictBanner': 'unresolved merge conflicts',
          'git.abort': 'Abort merge',
          'git.files': 'Changes',
          'git.filesHint': 'click a badge to expand/collapse the changed-file list',
          'git.filesTruncated': 'list truncated; run git status for the full picture',
          'git.f.added': 'added',
          'git.f.deleted': 'deleted',
          'git.f.modified': 'modified',
          'git.f.renamed': 'renamed',
          'git.f.copied': 'copied',
          'git.f.conflict': 'conflict',
          'git.f.untracked': 'untracked',
          'git.commit': 'Commit',
          'git.commitTitle': 'Commit local changes',
          'git.commitMsgPh': 'Commit message (required, ≤500 chars)…',
          'git.commitNudge': 'stage files first (click + in Changes)',
          'git.confirm.commit': 'Commit these changes?',
          'git.commitMsgLabel': 'Message',
          'git.staged': 'Staged',
          'git.unstaged': 'Changes',
          'git.stageAll': 'Stage all',
          'git.unstageAll': 'Unstage all',
          'git.stageSel': 'Stage selected',
          'git.unstageSel': 'Unstage selected',
          'git.untrackedNew': 'new untracked file',
          'git.diffEmpty': 'no differences',
          'git.openFull': 'Full file',
          'git.openFullTip': 'open the full file in the sidebar preview',
          'git.legend': '+ added (staged new file)\n~ modified\n- deleted\n→ renamed (hover for old path)\n? untracked new file\n⚠ unresolved merge conflict\n\nthe number after a folder = changed files under it',
          'git.stageTip': 'stage this file (git add)',
          'git.unstageTip': 'unstage (git reset HEAD; file content untouched)',
          'git.stageConflictTip': 'mark conflict resolved and stage (git add)',
          'git.push': 'Push',
          'git.pushTip': 'push to remote (-u origin <branch> when no upstream)',
          'git.confirm.push': 'Push to remote?',
        })
        const t = ctx.locale.bind('devctl')

        // FAB 快捷入口：不再自带浮层，点击打开右侧边栏的 devctl tab
        // （右侧边栏可折叠/拖宽/浮出为浮动面板，宽高交给宿主管）
        function DevctlFab() {
          const [count, setCount] = useState(0)
          useEffect(() => {
            // 仅计数用：10s 一次轻轮询，面板 tab 自己的 3s 轮询不受影响
            let alive = true
            const load = async () => {
              try {
                const d = await call('/status')
                if (alive) setCount((d.running || []).length + (d.recent || []).filter((r) => r.status === 'building').length)
              } catch { /* 后台计数失败静默 */ }
            }
            load()
            const timer = setInterval(load, 10000)
            return () => { alive = false; clearInterval(timer) }
          }, [])
          return h('div', { style: styles.layer },
            h('button', {
              style: styles.fab,
              onClick: () => ctx.sidebarRight.openTab('devctl'),
              title: t('subtitle'),
            }, '▦ ', t('title'), count ? ` · ${count}` : ''))
        }

        function Panel() {
          const [projects, setProjects] = useState([])
          // tab 根节点引用：keepMounted 后隐藏靠 display:none，轮询前用它判可见性
          const rootRef = useRef(null)
          const isVisible = () => {
            const el = rootRef.current
            if (!el) return false
            if (typeof el.checkVisibility === 'function') return el.checkVisibility()
            return Boolean(el.offsetParent) || el.getClientRects().length > 0
          }
          const [gitBranches, setGitBranches] = useState({})
          const [gitPanel, setGitPanel] = useState(null)
          const [gitConfirm, setGitConfirm] = useState(null)
          // 各项目最近一次 git-detail 的已知状态（脏/领先落后），行内 chip 展示用
          const [gitKnown, setGitKnown] = useState({})
          const [gitQuery, setGitQuery] = useState('')
          // git 面板里的变更文件清单展开状态（按项目 id 记，切项目互不影响）
          // null = 未表态：有变更时自动展开；用户点徽标后固定为显式选择
          const [gitShowFiles, setGitShowFiles] = useState(null)
          // commit 起草层：{ id, msg } —— 提交信息必须用户显式输入，面板不做任何自动提交
          const [gitCommitDraft, setGitCommitDraft] = useState(null)
          // 文件树目录折叠状态（Set<目录全路径>）
          const [gitCollapsedDirs, setGitCollapsedDirs] = useState(() => new Set())
          // 变更文件多选（Set<"side|path">）：批量暂存/取消用；openGitPanel 时重置
          const [gitSel, setGitSel] = useState(() => new Set())
          // 文件 diff 查看层：{ id, path, side, loading, unified, untracked, truncated, error }
          const [gitDiff, setGitDiff] = useState(null)
          const [excluded, setExcluded] = useState([])
          const [running, setRunning] = useState([])
          const [recent, setRecent] = useState([])
          const [query, setQuery] = useState('')
          const [expanded, setExpanded] = useState(null)
          const [busy, setBusy] = useState('')
          // 会话级免确认集合（Set<"projectId/taskName">，不持久化，刷新即重置）
          const [quickRun, setQuickRun] = useState(() => new Set())
          const [notice, setNotice] = useState(null)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(true)
          const [confirm, setConfirm] = useState(null)
          // 控制台：{ runId, text, offset, ready, autoScroll }
          const [con, setCon] = useState(null)
          const conBodyRef = useRef(null)
          const conStateRef = useRef(null)

          useEffect(() => { conStateRef.current = con }, [con])

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

          // tab 主体只在可见时轮询：keepMounted 后切走 tab 仍挂载（状态保留），
          // 但 display:none 下这些 interval 全部空转跳过，回来最多 3s 恢复
          useEffect(() => {
            loadStatus()
            const poll = setInterval(() => { if (isVisible()) loadStatus() }, 3000)
            const tick = setInterval(() => { if (isVisible()) setCon((c) => (c ? { ...c } : c)) }, 1000)
            return () => { clearInterval(poll); clearInterval(tick) }
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [loadStatus])

          // 控制台增量 tail：只拉新增字节，1.2s 一次；tab 隐藏期间暂停，回来按 offset 补齐
          useEffect(() => {
            if (!con || !con.runId) return undefined
            const runId = con.runId
            let stopped = false
            const timer = setInterval(async () => {
              const cur = conStateRef.current
              if (stopped || !cur || cur.runId !== runId) return
              if (!isVisible()) return
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

          // toast 自动消退：普通成功提示 4s 后消失；错误/带撤销的保留到用户处理
          useEffect(() => {
            if (!notice || notice.error || notice.undo) return undefined
            const timer = setTimeout(() => setNotice(null), 4000)
            return () => clearTimeout(timer)
          }, [notice])

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

          // 直接运行（会话级免确认路径与确认后执行走同一段逻辑）
          const runDirect = async (project, task) =>
            act(project.id, async () => {
              const r = await post('/run', { id: project.id, task: task.name })
              return `${project.id} · ${task.name} → ${r.url || 'started'}`
            })

          const requestAction = async (project, task, mode) => {
            // 会话级免确认（仅 run 且非发布类）：用户勾选过"本次会话直接运行"的任务
            // 不再弹确认卡，直接执行；刷新页面即重置——安全底线是会话级的
            if (mode === 'run' && task.section !== 'release' && quickRun.has(`${project.id}/${task.name}`)) {
              return runDirect(project, task)
            }
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

          // 分组折叠（localStorage 记忆）：项目多时收起不关心的组
          const [collapsedGroups, setCollapsedGroups] = useState(() => {
            try { return new Set(JSON.parse(localStorage.getItem('devctl.panel.collapsedGroups') || '[]')) } catch { return new Set() }
          })
          const toggleGroup = (g) => setCollapsedGroups((s) => {
            const n = new Set(s)
            if (n.has(g)) n.delete(g); else n.add(g)
            try { localStorage.setItem('devctl.panel.collapsedGroups', JSON.stringify([...n])) } catch { /* 忽略 */ }
            return n
          })

          /* ---- 设计令牌（4/8pt 栅格 + 三档字号）----
           * 间距：4 的倍数，主节奏 8；区头距上 8 / 内容距 12 / 区间距 16
           * 字号：11（辅助/等宽）· 12（正文）· 13（强调）；glyph 图标例外
           * 行高：列表行 ≥28px，点击目标 ≥24×24（WCAG 2.5.5）
           * 滚动：面板 body 是唯一主滚动容器，内嵌清单内滚且 contain 防穿透 */
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
            body: { overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 0', flex: 1, minHeight: 120 },
            groupTitle: { padding: '8px 12px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            // 分组头（可折叠）：整行可点，计数徽标在右
            groupHead: {
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              padding: '8px 12px', fontSize: 11, fontWeight: 600,
              color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.3,
              background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
              borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 4,
            },
            groupCount: {
              marginLeft: 'auto', padding: '0 7px', borderRadius: 999, fontSize: 10,
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
            },
            // 空状态：比一行灰字更能告诉用户"接下来该做什么"
            emptyState: {
              padding: '36px 16px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8,
            },
            liveTitle: { padding: '8px 12px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: 2 },
            row: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', minHeight: 28 },
            name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
            // 按钮三分类（次操作 btn / 主操作 btnRun / 危险 btnStop + 弱化 btnGhost）：
            // 统一 padding/字号/圆角，主/危险加浅色底，视觉层级一眼可辨
            btn: {
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '3px 9px',
              fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
            },
            btnRun: {
              borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)',
              background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)',
            },
            btnStop: {
              borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)',
              background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
            },
            btnGhost: { borderColor: 'transparent', color: 'var(--dsw-alias-label-secondary)', background: 'transparent' },
            notice: {
              display: 'flex', alignItems: 'center', gap: 8,
              wordBreak: 'break-all',
            },
            toast: {
              position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
              zIndex: 30, maxWidth: '92%', display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-overlay)',
              boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
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
              display: 'flex', flexDirection: 'column', overflowY: 'auto',
              overscrollBehavior: 'contain', padding: '12px 14px',
            },
            // 面包屑导航条：页面级覆盖层（git/控制台/提交）的定位标识
            crumb: {
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
              padding: '6px 12px', fontSize: 11,
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)', flexShrink: 0,
            },
            crumbBtn: {
              border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
              fontSize: 11, cursor: 'pointer', padding: '2px 5px', borderRadius: 4,
            },
            crumbSep: { color: 'var(--dsw-alias-label-secondary)', opacity: 0.5, padding: '0 1px' },
            // 底部抽屉：确认卡/提交起草层。不再全屏覆盖——
            // 上层页面保持可见，用户始终知道自己在哪
            drawer: {
              position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '68%',
              overflowY: 'auto', overscrollBehavior: 'contain', background: 'var(--dsw-alias-bg-overlay)',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              boxShadow: '0 -8px 24px rgba(0,0,0,0.25)', padding: '12px 14px',
              display: 'flex', flexDirection: 'column', zIndex: 20,
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
            conToolbar: {
              display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap',
              padding: '8px 10px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
            },
            // git 状态卡（hero）：品牌色左侧色条，分支名是页面主角
            gitHero: {
              display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px',
              borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderLeft: '3px solid var(--dsw-alias-brand-primary)', marginBottom: 8,
            },
            // git 分节头（本地分支/远端分支/待提交/变更 共用）
            sectionHead: {
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0 4px',
              fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.3,
            },
            // 暂存区卡片：待提交区用绿色描边区分语义
            zone: {
              margin: '6px 0', borderRadius: 8, overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l1)',
            },
            zoneStaged: {
              borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l1))',
            },
            zoneHead: {
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
            zoneBody: {
              maxHeight: 200, overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 8px',
              background: 'var(--dsw-alias-bg-layer-1)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            },
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

          // 抽屉 + 遮罩：压暗底层、点击关闭、阻断抽屉下方交互
          //（否则提交弹窗开着还能点到暂存区的 −，状态会和弹窗内计数打架）
          const drawerWith = (onClose, drawer) => h(React.Fragment, null,
            h('div', {
              style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 15 },
              onClick: onClose,
            }),
            drawer)

          // 面包屑：parts = [{label, onClick?}]；有 onClick 的是可返回的父级
          const crumbs = (parts) =>
            h('div', { style: styles.crumb },
              parts.flatMap((p, i) => [
                i ? h('span', { key: `s${i}`, style: styles.crumbSep }, '/') : null,
                p.onClick
                  ? h('button', { key: `b${i}`, style: styles.crumbBtn, onClick: p.onClick, title: p.title || '' }, p.label)
                  : h('span', { key: `t${i}`, style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, padding: '2px 5px' } }, p.label),
              ]))

          // 反馈改为顶部悬浮 toast（原底部一行条容易被抽屉/页面盖住）
          const noticeBar = () => {
            if (!notice) return null
            const isErr = Boolean(notice.error)
            return h('div', {
              style: {
                ...styles.toast,
                borderColor: isErr ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)',
                color: isErr ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
              },
            },
              h('span', { style: styles.noticeText }, isErr ? notice.error : notice.text),
              isErr ? h('button', { style: { ...styles.btn, fontSize: 10, padding: '1px 6px' }, onClick: () => navigator.clipboard?.writeText(notice.error) }, t('copy')) : null,
              notice && notice.undo ? h('button', {
                style: styles.btn,
                onClick: () => { const u = notice.undo; setNotice(null); u() },
              }, t('undo')) : null,
              h('button', { style: { ...styles.btn, ...styles.btnGhost, fontSize: 10, padding: '1px 6px' }, onClick: () => setNotice(null) }, '×'))
          }

          /* ---------------- git：Tier1 按需详情 + Tier2 显式操作 ---------------- */

          // 点开某个项目的 git 面板才拉详情（spawn git ~1s，不进热路径）
          const openGitPanel = useCallback(async (id) => {
            setConfirm(null)
            setCon(null)
            setGitQuery('')
            setGitCommitDraft(null)
            setGitSel(new Set())
            setGitDiff(null)
            // 变更文件清单：null = 未表态，随数据自动决定（有变更默认展开）
            setGitShowFiles(null)
            setGitPanel({ id, loading: true, data: null, error: null })
            try {
              const d = await call(`/git-detail?id=${encodeURIComponent(id)}`)
              setGitPanel((g) => (g && g.id === id ? { ...g, loading: false, data: d } : g))
              if (d && d.status && d.status.ok) {
                setGitKnown((k) => ({ ...k, [id]: d.status }))
              }
              // 有本地变更 → 清单默认展开；用户手动点徽标后（非 null）以后不再自动改
              setGitShowFiles((v) => (v === null ? Boolean(d && d.status && d.status.ok && d.status.files && d.status.files.length) : v))
            } catch (e) {
              setGitPanel((g) => (g && g.id === id ? { ...g, loading: false, error: e.message } : g))
            }
          }, [])

          // 静默刷新 git 详情：只替换 data，不进 loading、不重置搜索/展开/多选。
          // 暂存、merge、pull 这类操作后用它——openGitPanel 整页重挂会造成高度突变和闪烁
          const refreshGitDetail = useCallback(async (id) => {
            try {
              const d = await call(`/git-detail?id=${encodeURIComponent(id)}`)
              setGitPanel((g) => (g && g.id === id ? { ...g, data: d, error: null } : g))
              if (d && d.status && d.status.ok) {
                setGitKnown((k) => ({ ...k, [id]: d.status }))
              }
            } catch {
              /* 静默刷新失败保留旧数据 */
            }
          }, [])

          // git 写操作：先预演拿命令，弹确认卡（与 run/build 同款交互）。
          // op 'update' 时 remote 由分支 upstream 推出（面板已有数据，服务端预演零 spawn）
          const remoteOf = (b) => (b && b.upstream ? b.upstream.split('/')[0] : 'origin')

          const requestGitAction = async (op, id, branch, remote, msg) => {
            // 立即给出点击反馈：git 面板进入 busy，避免"没有反应"的观感
            setGitPanel((g) => (g && g.id === id ? { ...g, cmdBusy: op } : g))
            try {
              const pv = await post('/git-action', { id, op, branch, remote, msg, preview: true })
              setGitConfirm({ op, id, branch: branch || null, cmd: pv.cmd, cwd: pv.cwd, warn: pv.warn || null, msg: msg || null, error: null })
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

          const executeGitAction = async (force = false) => {
            const cur = gitConfirm
            if (!cur) return
            setGitConfirm(null)
            setBusy(`git:${cur.id}`)
            try {
              const r = await post('/git-action', {
                id: cur.id, op: cur.op, branch: cur.branch || undefined,
                force: force === true ? true : undefined,
                msg: cur.msg || undefined,
              })
              if (r.ok === false) {
                // 失败原因在 r.error（r.out 失败时为空）。必须同时写进 git 面板：
                // git 面板是 inset:0 的覆盖层，会把面板底部的 notice 条整个挡住，
                // 只写 notice 用户什么都看不到。失败时也不刷新面板，保留错误现场
                const reason = String(r.error || r.out || '').split('\n')[0].slice(0, 200) || '未知原因'
                const hint = cur.op === 'delete'
                  ? '（未合并分支受保护；确认放弃该分支请到终端执行 git branch -D）'
                  : cur.op === 'merge'
                    ? '（多为冲突：解决冲突后提交，或点「放弃合并」回到合并前）'
                    : cur.op === 'commit'
                      ? '（待提交区没有内容？先把文件加入待提交区；或信息为空）'
                      : ''
                const msg = `git ${cur.op} 失败: ${reason}${hint}`
                setNotice({ error: msg })
                setGitPanel((g) => (g && g.id === cur.id ? { ...g, error: msg } : g))
                // merge 冲突恰恰需要看现场：静默刷新详情让冲突横幅/清单出现（错误信息仍在面板顶部）
                if (cur.op === 'merge') {
                  await refreshGitDetail(cur.id)
                  setGitPanel((g) => (g && g.id === cur.id ? { ...g, error: msg } : g))
                }
                return
              }
              // fetch --prune 清理掉的远端分支：分支行上的 gone 徽标依赖本地分支的
              // upstream 配置，没跟踪远端的本地分支不会有任何提示，所以这里单独说一句
              const del = cur.op === 'fetch' && Array.isArray(r.deleted) && r.deleted.length
                ? `清理了 ${r.deleted.length} 个远端已删分支：${r.deleted.slice(0, 3).join('、')}${r.deleted.length > 3 ? ` 等 ${r.deleted.length} 个` : ''}`
                : ''
              setNotice({ text: `${cur.id} · git ${cur.op} 完成${del ? `，${del}` : ''}${r.out ? `：${String(r.out).split('\n')[0].slice(0, 120)}` : ''}` })
              // 静默刷新：保住搜索/展开/滚动位置，避免整页重挂闪烁
              await refreshGitDetail(cur.id)
              // git 面板是 inset:0 覆盖层，会挡住底部 notice 条，所以同时写进面板
              if (del) setGitPanel((g) => (g && g.id === cur.id ? { ...g, info: del } : g))
              await loadProjects()       // Tier0 分支名也可能变了
            } catch (e) {
              const msg = `git ${cur.op} 失败: ${e.message}`
              setNotice({ error: msg })
              setGitPanel((g) => (g && g.id === cur.id ? { ...g, error: msg } : g))
            } finally {
              setBusy('')
            }
          }

          // 打开单文件 diff（点击文件行触发，读操作零风险）
          const openGitDiff = async (id, f, side) => {
            setGitDiff({ id, path: f.path, side, state: f.state, loading: true, unified: null, error: null })
            try {
              const q = `id=${encodeURIComponent(id)}&path=${encodeURIComponent(f.path)}&staged=${side === 'staged' ? 1 : 0}&untracked=${f.state === 'untracked' ? 1 : 0}`
              const d = await call(`/git-diff?${q}`)
              setGitDiff((g) => (g && g.id === id && g.path === f.path ? { ...g, loading: false, ...d } : g))
            } catch (e) {
              setGitDiff((g) => (g && g.id === id && g.path === f.path ? { ...g, loading: false, error: e.message } : g))
            }
          }

          // 暂存/取消暂存：index 操作、可逆、不写历史 → 免确认直接执行，
          // 完成后刷新 git 详情（一次 spawn，用户显式动作才发生）
          const stageAction = async (op, paths) => {
            setGitPanel((g) => (g ? { ...g, cmdBusy: op } : g))
            try {
              const r = await post('/git-action', { id: gitPanel.id, op, paths })
              if (r.ok === false) {
                const msg = `git ${op} 失败: ${String(r.error || '').split('\n')[0].slice(0, 160)}`
                setNotice({ error: msg })
                setGitPanel((g) => (g ? { ...g, error: msg, cmdBusy: null } : g))
                return
              }
              setGitPanel((g) => (g ? { ...g, cmdBusy: null } : g))
              // 清掉已处理路径的多选标记（文件已换区，旧 side 前缀的选中不再有意义）
              setGitSel((s) => {
                if (!s.size) return s
                const n = new Set(s)
                for (const k of n) if (paths.includes(k.split('|')[1])) n.delete(k)
                return n
              })
              // 静默刷新：只替换 data，不重挂面板（高度不突变、不闪烁）
              await refreshGitDetail(gitPanel.id)
            } catch (e) {
              const msg = `git ${op} 失败: ${e.message}`
              setNotice({ error: msg })
              setGitPanel((g) => (g ? { ...g, error: msg, cmdBusy: null } : g))
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
            // 变更清单展开态：null=未表态（默认展开），点徽标后为显式 true/false
            const showFiles = gitShowFiles === null ? true : gitShowFiles
            const allFiles = st && st.ok && st.files ? st.files : []
            const stagedFiles = allFiles.filter((f) => f.staged)
            const unstagedFiles = allFiles.filter((f) => !f.staged)
            const fileMark = { added: '+', deleted: '-', modified: '~', renamed: '→', copied: '⧉', conflict: '⚠', untracked: '?' }
            const fileColor = {
              added: 'var(--dsw-alias-state-success-primary)',
              deleted: 'var(--dsw-alias-state-error-primary)',
              modified: 'var(--dsw-alias-state-warn-primary)',
              conflict: 'var(--dsw-alias-state-error-primary)',
            }

            // 目录树：files → { dirs: Map<seg,node>, files: [] }，node 带 {n,add,del} 聚合
            const buildTree = (files) => {
              const root = { dirs: new Map(), files: [] }
              for (const f of files) {
                const parts = f.path.split('/')
                let node = root
                for (let i = 0; i < parts.length - 1; i++) {
                  const seg = parts[i]
                  let next = node.dirs.get(seg)
                  if (!next) { next = { name: seg, dirs: new Map(), files: [] }; node.dirs.set(seg, next) }
                  node = next
                }
                node.files.push(f)
              }
              return root
            }
            // numstat 行数映射：staged/worktree 按区取；缺失（缓存旧/超限）返回 null
            const nsOf = (side) => {
              const ns = d && d.numstat
              if (!ns || !ns.ok) return null
              return side === 'staged' ? ns.staged : ns.worktree
            }
            const statOf = (side, path) => {
              const m = nsOf(side)
              return m ? m[path] || null : null
            }
            const countTree = (node, side) => {
              let n = node.files.length, add = 0, del = 0, has = false
              for (const f of node.files) {
                const s = statOf(side, f.path)
                if (s) { has = true; add += s.add || 0; del += s.del || 0 }
              }
              for (const sub of node.dirs.values()) {
                const r = countTree(sub, side)
                n += r.n; if (r.has) { has = true; add += r.add; del += r.del }
              }
              return { n, add, del, has }
            }

            // 树 → 行数组（目录行可折叠 + 整目录暂存/取消；文件行带 暂存/取消暂存 按钮）
            const collectPaths = (node) => [
              ...node.files.map((f) => f.path),
              ...[...node.dirs.values()].flatMap(collectPaths),
            ]
            const treeRows = (node, dirPath, depth, side) => {
              const rows = []
              for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
                const key = dirPath ? `${dirPath}/${d.name}` : d.name
                const collapsed = gitCollapsedDirs.has(key)
                // 目录聚合：优先 +N −M 行数（numstat 汇总），无统计时退回文件数
                const agg = countTree(d, side)
                rows.push(h('div', {
                  key: `d-${key}`,
                  style: { display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0 1px ' + (depth * 12) + 'px', fontSize: 11, cursor: 'pointer', userSelect: 'none' },
                  onClick: () => setGitCollapsedDirs((s) => {
                    const n = new Set(s)
                    if (n.has(key)) n.delete(key); else n.add(key)
                    return n
                  }),
                },
                  h('span', { style: { width: '1em', flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' } }, collapsed ? '▸' : '▾'),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } }, `${d.name}/`),
                  agg.has
                    ? h('span', { style: { fontSize: 10, flexShrink: 0 }, title: `${agg.n} 个变更文件 · 新增 ${agg.add} 行 / 删除 ${agg.del} 行` },
                        h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, `+${agg.add}`),
                        ' ',
                        h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `−${agg.del}`))
                    : h('span', { style: { ...styles.meta, fontSize: 10 }, title: '该目录下的变更文件总数' }, String(agg.n)),
                  // 整目录暂存/取消（子树全部文件一次提交给 git add / reset）
                  h('button', {
                    style: {
                      ...styles.btn, ...styles.btnGhost, marginLeft: 'auto', flexShrink: 0,
                      width: 26, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 16, fontWeight: 600, padding: 0, borderRadius: 5,
                    },
                    disabled: isBusy || Boolean(gitPanel.cmdBusy),
                    title: side === 'staged'
                      ? `${t('git.unstageAll')}（${agg.n} 个文件）`
                      : `${t('git.stageAll')}（${agg.n} 个文件）`,
                    onClick: (e) => {
                      e.stopPropagation()
                      stageAction(side === 'staged' ? 'unstage' : 'stage', collectPaths(d))
                    },
                  }, gitPanel.cmdBusy && (side === 'staged' ? 'unstage' : 'stage') ? '…' : side === 'staged' ? '−' : '+')))
                if (!collapsed) rows.push(...treeRows(d, key, depth + 1, side))
              }
              for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
                const name = f.path.split('/').pop()
                const color = fileColor[f.state] || 'var(--dsw-alias-label-secondary)'
                const selKey = `${side}|${f.path}`
                const sel = gitSel.has(selKey)
                const toggleSel = () => setGitSel((s) => {
                  const n = new Set(s)
                  if (n.has(selKey)) n.delete(selKey); else n.add(selKey)
                  return n
                })
                // 整行可点：点击 = 查看该文件修改前后对比（读操作，安全默认）；
                // 暂存/取消用 +/− 按钮或复选框多选批量
                rows.push(h('div', {
                  key: `f-${selKey}-${f.state}`,
                  title: f.orig ? `${f.orig} -> ${f.path}` : f.path,
                  className: `devctl-file-row${f.state === 'conflict' ? ' is-conflict' : ''}`,
                  style: {
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 4px 2px ' + (depth * 12 + 6) + 'px',
                    fontSize: 11, lineHeight: '20px', whiteSpace: 'nowrap',
                    background: sel ? 'var(--dsw-alias-bg-layer-2)' : undefined,
                    borderRadius: 4,
                  },
                  onClick: () => openGitDiff(gitPanel.id, f, side),
                },
                  h('input', {
                    type: 'checkbox',
                    style: { flexShrink: 0, margin: 0, cursor: 'pointer' },
                    checked: sel,
                    onClick: (e) => e.stopPropagation(),
                    onChange: toggleSel,
                  }),
                  h('span', { style: { width: '1em', flexShrink: 0, color } }, fileMark[f.state] || '·'),
                  h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: f.state === 'conflict' || f.state === 'deleted' ? color : 'inherit' } }, name),
                  // 行数统计（numstat，来自 git-detail 同批数据）：+N 绿 / −M 红；二进制/无数据显示 -
                  (() => {
                    const s = statOf(side, f.path)
                    if (!s) return null
                    return h('span', {
                      style: { flexShrink: 0, fontSize: 10, whiteSpace: 'nowrap', opacity: 0.85 },
                      title: `新增 ${s.add ?? '?'} 行 / 删除 ${s.del ?? '?'} 行`,
                    },
                      s.add == null && s.del == null
                        ? h('span', { style: { ...styles.meta } }, 'bin')
                        : h('span', null,
                            h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, `+${s.add || 0}`),
                            ' ',
                            h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `−${s.del || 0}`)))
                  })(),
                  side === 'staged'
                    ? h('button', {
                        style: {
                          ...styles.btn, ...styles.btnGhost,
                          width: 26, height: 26, flexShrink: 0,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 16, fontWeight: 600, padding: 0, borderRadius: 5,
                        },
                        disabled: isBusy || Boolean(gitPanel.cmdBusy),
                        title: t('git.unstageTip'),
                        onClick: (e) => { e.stopPropagation(); stageAction('unstage', [f.path]) },
                      }, '−')
                    : h('button', {
                        style: {
                          ...styles.btn, ...styles.btnGhost,
                          width: 26, height: 26, flexShrink: 0,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 16, fontWeight: 600, padding: 0, borderRadius: 5,
                        },
                        disabled: isBusy || Boolean(gitPanel.cmdBusy),
                        title: f.state === 'conflict' ? t('git.stageConflictTip') : t('git.stageTip'),
                        onClick: (e) => { e.stopPropagation(); stageAction('stage', [f.path]) },
                      }, '+')))
              }
              return rows
            }

            // 两个区：待提交（已暂存，绿色描边）/ 变更（未暂存，含未跟踪与冲突）
            const zone = (titleKey, files, side, bulkOp, bulkLabel, selLabel) => {
              if (!files.length) return null
              const selPaths = [...new Set(files.filter((f) => gitSel.has(`${side}|${f.path}`)).map((f) => f.path))]
              return h('div', {
                key: `zone-${side}`,
                style: { ...styles.zone, ...(side === 'staged' ? styles.zoneStaged : null) },
              },
                h('div', { style: styles.zoneHead },
                  h('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.3 } }, t(titleKey)),
                  h('span', { style: styles.groupCount }, String(files.length)),
                  selPaths.length
                    ? h('button', {
                        style: { ...styles.btn, marginLeft: 'auto', fontSize: 10, padding: '1px 8px', ...(bulkOp === 'stage' ? styles.btnRun : styles.btnStop) },
                        disabled: isBusy || Boolean(gitPanel.cmdBusy),
                        title: bulkOp === 'stage' ? t('git.stageTip') : t('git.unstageTip'),
                        onClick: () => stageAction(bulkOp, selPaths),
                      }, gitPanel.cmdBusy === bulkOp ? '…' : `${selLabel} (${selPaths.length})`)
                    : null,
                  selPaths.length
                    ? h('button', {
                        style: { ...styles.btn, ...styles.btnGhost, fontSize: 10, padding: '1px 6px' },
                        onClick: () => setGitSel(new Set()),
                      }, '×')
                    : null,
                  !selPaths.length && bulkOp
                    ? h('button', {
                        style: { ...styles.btn, ...styles.btnGhost, marginLeft: 'auto', fontSize: 10, padding: '1px 8px' },
                        disabled: isBusy || Boolean(gitPanel.cmdBusy),
                        onClick: () => stageAction(bulkOp, [...new Set(files.map((f) => f.path))]),
                      }, gitPanel.cmdBusy === bulkOp ? '…' : bulkLabel)
                    : null),
                h('div', { style: styles.zoneBody }, treeRows(buildTree(files), '', 0, side)))
            }

            // 分支列表：搜索过滤，当前分支永远置顶；不含"最近分支"区（保持简洁）
            const qBranch = gitQuery.trim().toLowerCase()
            const localAll = (br && br.local) || []
            const match = (n) => !qBranch || n.toLowerCase().includes(qBranch)
            // 本地分支展示列表：当前分支置顶，其余按名排序
            const locals = localAll
              .filter((b) => match(b.name))
              .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name))
            const remotes = ((br && br.remote) || []).filter((r) => match(r.name))

            // GitLens 风格徽标；optional=true 的在窄态（<380px 容器）自动隐藏
            const badge = (text, color, title, optional) =>
              h('span', {
                title,
                className: optional ? 'devctl-badge-optional' : undefined,
                style: {
                  display: 'inline-flex', alignItems: 'center', padding: '1px 6px', marginLeft: 4,
                  borderRadius: 999, fontSize: 10, fontWeight: 600,
                  background: 'var(--dsw-alias-bg-layer-2)', color,
                },
              }, text)

            // 没有 upstream 的本地分支：远端到底有没有同名分支，面板要说清楚。
            //   远端有同名分支 → 「未跟踪」（本地没设 upstream，可 set-upstream 关联）
            //   远端没有同名分支 → 「无远端」（可能从未推送，也可能远端已删）
            //   注：gone 徽标靠 upstream 配置才有比对基准，没 upstream 时它无从判断，
            //   所以这两条灰/黄徽标就是该类分支唯一的远端状态反馈
            const remoteRefNames = ((br && br.remote) || []).map((r) => r.name)
            const hasRemoteTwin = (name) => remoteRefNames.some((r) => r === name || r.endsWith(`/${name}`))
            const remoteBadge = (b) => {
              if (b.upstream) return null
              return hasRemoteTwin(b.name)
                ? badge(t('git.notTracking'), 'var(--dsw-alias-state-warn-primary)', t('git.notTrackingTip'), true)
                : badge(t('git.noRemote'), 'var(--dsw-alias-label-secondary)', t('git.noRemoteTip'), true)
            }

            // 相对基准分支（main/master）的进度：GitLab 式「落后|超前」
            //   落后 → 黄色（主干有它没有的提交，该合主干/rebase 了）
            //   只超前 → 绿色（干净地领先主干，可合入）
            // 数据来自 gitBranches 同一条 for-each-ref，不额外 spawn
            const baseBadge = (b) => {
              if (b.baseAhead == null || b.baseBehind == null) return null
              if (!b.baseAhead && !b.baseBehind) return null
              const title = `${t('git.vsBase')} ${br.base}：${t('git.baseBehind')} ${b.baseBehind} · ${t('git.baseAhead')} ${b.baseAhead}`
              const color = b.baseBehind
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-success-primary)'
              return badge(`${b.baseBehind}|${b.baseAhead}`, color, title, true)
            }

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

            // 分支行（GitLens 式两行）：行1 = 名称 + 徽标 + 相对时间；行2 = 短sha + 提交主题（悬浮全文）
            const commitLine = (b) =>
              b.subject || b.sha
                ? h('div', {
                    style: {
                      ...styles.meta, fontSize: 10, padding: '0 8px 2px 24px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                    title: [b.sha, b.subject, b.when].filter(Boolean).join(' · '),
                  },
                  b.sha ? h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', opacity: 0.8 } }, b.sha) : null,
                  b.sha && b.subject ? ' ' : null,
                  b.subject || '')
                : null

            const branchRow = (b, section) =>
              h('div', {
                key: `${section}-${b.name}`,
                style: { padding: '1px 0' },
              },
                h('div', {
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
                remoteBadge(b),
                baseBadge(b),
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
                  : null,
                // 合并进当前分支（非当前本地分支；冲突时状态卡会出现「放弃合并」）
                !b.current
                  ? h('button', {
                      style: { ...styles.btn, ...styles.btnGhost, fontSize: 10, padding: '1px 6px' },
                      disabled: isBusy || Boolean(gitPanel.cmdBusy),
                      title: t('git.mergeTip'),
                      onClick: () => requestGitAction('merge', gitPanel.id, b.name),
                    }, gitPanel.cmdBusy === 'merge' ? '…' : `⇤ ${t('git.merge')}`)
                  : null,
                // 相对时间（行尾，次级色）
                b.when ? h('span', { style: { ...styles.meta, fontSize: 10, flexShrink: 0 }, title: b.subject || '' }, b.when) : null),
                commitLine(b))

            return h('div', { style: { ...styles.overlay, padding: '10px 12px' } },
              // 面包屑 + 刷新：定位 = 项目列表 / <id> · Git（负边距让导航条通栏）
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '-10px -12px 8px' } },
                crumbs([
                  { label: t('nav.projects'), onClick: () => setGitPanel(null) },
                  { label: `${gitPanel.id} · ${t('git')}` },
                ]),
                h('button', { style: { ...styles.btn, marginRight: 12 }, disabled: isBusy, onClick: () => openGitPanel(gitPanel.id), title: t('git.refresh') }, '⟳')),

              // 状态卡（hero）：左 = 当前分支 + 徽标；右 = 同步操作（拉取/更新/提交/推送）。
              // 操作放顶部与分支状态同屏第一眼可见（GitLens 式布局）
              h('div', { style: styles.gitHero },
                h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
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
                  // 同步操作：behind>0 pull 高亮、待提交区有内容 commit 高亮、ahead>0 push 高亮
                  h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' } },
                    h('button', { style: { ...styles.btn, fontSize: 10, padding: '2px 8px' }, disabled: isBusy, title: t('git.confirm.fetch'), onClick: () => requestGitAction('fetch', gitPanel.id) }, `⟳ ${t('git.fetch')}`),
                    h('button', {
                      style: { ...(behind > 0 ? { ...styles.btn, ...styles.btnRun } : styles.btn), fontSize: 10, padding: '2px 8px' },
                      disabled: isBusy, title: t('git.confirm.pull'),
                      onClick: () => requestGitAction('pull', gitPanel.id),
                    }, `⇣ ${t('git.pull')}${behind > 0 ? ` (${behind})` : ''}`),
                    h('button', {
                      style: { ...(stagedFiles.length > 0 ? { ...styles.btn, ...styles.btnRun } : styles.btn), fontSize: 10, padding: '2px 8px' },
                      disabled: isBusy || !stagedFiles.length,
                      title: stagedFiles.length > 0 ? `${t('git.commitTitle')}（${stagedFiles.length} ${t('git.staged')}）` : t('git.commitNudge'),
                      onClick: () => setGitCommitDraft({ id: gitPanel.id, msg: '' }),
                    }, `✎ ${t('git.commit')}${stagedFiles.length > 0 ? ` (${stagedFiles.length})` : ''}`),
                    h('button', {
                      style: { ...(ahead > 0 ? { ...styles.btn, ...styles.btnRun } : styles.btn), fontSize: 10, padding: '2px 8px' },
                      disabled: isBusy || !ahead,
                      title: ahead > 0 ? t('git.pushTip') : t('git.aheadTip'),
                      onClick: () => requestGitAction('push', gitPanel.id),
                    }, `↑ ${t('git.push')}${ahead > 0 ? ` (${ahead})` : ''}`)))),

              // 冲突横幅：merge 撞冲突时 git 停在未合并状态，这里给出「放弃合并」出口
              st && st.ok && st.conflicts > 0
                ? h('div', {
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', padding: '6px 10px',
                      borderRadius: 6, fontSize: 12,
                      background: 'var(--dsw-alias-state-error-primary)', color: '#fff',
                    },
                  },
                  h('span', { style: { flex: 1, minWidth: 0 } }, `⚠ ${st.conflicts} ${t('git.conflictBanner')}`),
                  h('button', {
                    style: { ...styles.btn, borderColor: 'rgba(255,255,255,.7)', color: '#fff', background: 'transparent', fontSize: 11, padding: '1px 8px' },
                    disabled: isBusy || Boolean(gitPanel.cmdBusy),
                    onClick: () => requestGitAction('merge-abort', gitPanel.id),
                  }, t('git.abort')))
                : null,

              // 变更文件徽标行：+新增 ~修改 -删除 →重命名 ?未跟踪 ⚠冲突（数据来自同一条 status，零额外请求）
              // 清单默认展开（本地有修改直接可见）；点徽标收起/再展开
              st && st.ok && st.files && st.files.length
                ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', margin: '4px 0' } },
                    (() => {
                      const fc = st.fileCounts || {}
                      const cnt = { conflict: fc.conflict || 0, added: fc.added || 0, modified: fc.modified || 0, deleted: fc.deleted || 0, renamed: (fc.renamed || 0) + (fc.copied || 0), untracked: st.untracked || 0 }
                      const chipDefs = [
                        ['conflict', `⚠ ${t('git.f.conflict')} ${cnt.conflict}`, 'var(--dsw-alias-state-error-primary)'],
                        ['added', `+${t('git.f.added')} ${cnt.added}`, 'var(--dsw-alias-state-success-primary)'],
                        ['modified', `~${t('git.f.modified')} ${cnt.modified}`, 'var(--dsw-alias-state-warn-primary)'],
                        ['deleted', `-${t('git.f.deleted')} ${cnt.deleted}`, 'var(--dsw-alias-state-error-primary)'],
                        ['renamed', `→${t('git.f.renamed')} ${cnt.renamed}`, 'var(--dsw-alias-label-secondary)'],
                        ['untracked', `?${t('git.f.untracked')} ${cnt.untracked}`, 'var(--dsw-alias-label-secondary)'],
                      ].filter(([k]) => cnt[k] > 0)
                      return [
                        ...chipDefs.map(([k, text, color]) =>
                          h('button', {
                            key: k,
                            style: {
                              display: 'inline-flex', padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                              border: 'none', cursor: 'pointer',
                              background: showFiles ? 'var(--dsw-alias-bg-layer-active, rgba(128,128,128,.18))' : 'var(--dsw-alias-bg-layer-2)',
                              color,
                            },
                            title: t('git.filesHint'),
                            onClick: () => setGitShowFiles(!showFiles),
                          }, text),
                        ),
                        showFiles
                          ? h('span', { key: 'more', style: { ...styles.meta, fontSize: 10 } },
                              `${st.files.length}${st.filesTruncated ? '+' : ''} ${t('git.files')}`)
                          : null,
                      ]
                    })(),
                    // 状态图例：悬浮显示完整对照表（含目录计数说明），零渲染开销
                    h('button', {
                      style: {
                        ...styles.btn, ...styles.btnGhost, padding: '1px 6px', fontSize: 10, marginLeft: 'auto',
                      },
                      title: t('git.legend'),
                      tabIndex: -1,
                    }, 'ⓘ'),
                    // 变更文件双区树（默认展开）：待提交 / 变更，逐文件或全部暂存
                    showFiles
                      ? h('div', { key: 'files', style: { width: '100%' } },
                          zone('git.staged', stagedFiles, 'staged', stagedFiles.length ? 'unstage' : null, `− ${t('git.unstageAll')}`, `− ${t('git.unstageSel')}`),
                          zone('git.unstaged', unstagedFiles, 'unstaged', unstagedFiles.length ? 'stage' : null, `＋ ${t('git.stageAll')}`, `＋ ${t('git.stageSel')}`),
                          st.filesTruncated
                            ? h('div', { style: { ...styles.meta, fontSize: 10, padding: '4px 0' } }, t('git.filesTruncated'))
                            : null)
                      : null)
                : null,

              gitPanel.loading ? h('div', { style: { ...styles.meta, padding: '12px 0' } }, t('loading')) : null,
              gitPanel.error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: '8px 0' } }, gitPanel.error) : null,
              // fetch 后的一次性提示（本次清理了哪些远端已删分支）；openGitPanel 会重置
              gitPanel.info ? h('div', { style: { ...styles.meta, color: 'var(--dsw-alias-state-warn-primary)', padding: '6px 0' } }, gitPanel.info) : null,
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
                    // 本地分支列表：当前分支不单独拎出（顶部状态卡已显示），
                    // 与其他分支同列，● 圆点 + 「当前」标记区分，排序置顶
                    locals.length
                      ? h('div', null,
                          h('div', { style: styles.sectionHead },
                            h('span', null, t('git.local')),
                            h('span', { style: styles.groupCount }, String(locals.length)),
                            br.base ? h('span', { style: { ...styles.meta, fontSize: 10, marginLeft: 4 } }, `${t('git.vsBase')} ${br.base}`) : null),
                          locals.map((b) => branchRow(b, 'local')))
                      : null,
                    remotes.length
                      ? h('div', { style: { marginTop: 10 } },
                          h('div', { style: styles.sectionHead },
                            h('span', null, t('git.remote')),
                            h('span', { style: styles.groupCount }, String(remotes.length)),
                            h('span', { style: { ...styles.meta, fontSize: 10, marginLeft: 4 } }, t('git.remoteHint'))),
                          remotes.slice(0, 50).map((r) => {
                            // 去掉 origin/ 前缀：git switch <name> 会 DWIM 自动建本地跟踪分支
                            const short = r.name.replace(/^[^/]+\//, '')
                            const exists = localAll.some((b) => b.name === short)
                            return h('div', { key: `remote-${r.name}`, style: { padding: '1px 0' } },
                              h('button', {
                                className: 'devctl-git-item',
                                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12, width: '100%' },
                                disabled: isBusy,
                                onClick: () => requestGitAction('switch', gitPanel.id, short),
                                title: exists ? t('git.switchTo') + short : `${t('git.trackCreate')} ${short}`,
                              },
                                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, `  ${short}`),
                                // 远端分支同样给「落后|超前 main」的进度（与本地分支同源、同一条 for-each-ref）
                                baseBadge(r),
                                exists ? null : h('span', { style: { ...styles.meta, fontSize: 10 } }, '+track'),
                                r.when ? h('span', { style: { ...styles.meta, fontSize: 10, flexShrink: 0 } }, r.when) : null),
                              commitLine(r))
                          }))
                      : null)
                : null)
          }

          // 提交起草层：必须显式输入提交信息，确认后才走预演→执行（面板永不自动提交）
          // 底部抽屉：git 页面保持可见，面包屑定位（项目列表 / <id> · Git / 提交）
          const renderCommitDraft = () => {
            const d = gitCommitDraft
            const msg = d.msg || ''
            const trimmed = msg.trim()
            // 起草层随时反映当前待提交区（用户可能回列表继续勾选）
            const sd = gitPanel && gitPanel.id === d.id ? gitPanel.data : null
            const staged = sd && sd.status && sd.status.ok ? sd.status.files.filter((f) => f.staged) : []
            return drawerWith(() => setGitCommitDraft(null), h('div', { style: styles.drawer },
              crumbs([
                { label: t('nav.projects'), onClick: () => setGitCommitDraft(null) },
                { label: `${d.id} · ${t('git')}` },
                { label: t('git.commit') },
              ]),
              h('div', { style: { ...styles.confirmTitle, marginTop: 8 } }, `${t('git.commitTitle')} · ${staged.length} ${t('git.staged')}`),
              staged.length
                ? null
                : h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '4px 0 6px' } }, `! ${t('git.commitNudge')}`),
              h('div', { ...styles.meta, marginBottom: 8 }, t('git.commitMsgLabel')),
              h('textarea', {
                style: { ...styles.search, width: '100%', minHeight: 64, resize: 'vertical', fontFamily: 'inherit' },
                value: msg,
                placeholder: t('git.commitMsgPh'),
                maxLength: 500,
                autoFocus: true,
                onChange: (e) => setGitCommitDraft({ ...d, msg: e.target.value }),
              }),
              h('div', { style: { ...styles.meta, marginTop: 4 } }, `${msg.length}/500`),
              h('div', { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setGitCommitDraft(null) }, t('cancel')),
                h('button', {
                  style: { ...styles.btn, ...styles.btnRun },
                  disabled: !trimmed || !staged.length,
                  title: !trimmed ? t('git.commitMsgPh') : (!staged.length ? t('git.commitNudge') : ''),
                  onClick: () => {
                    const m = trimmed
                    setGitCommitDraft(null)
                    requestGitAction('commit', d.id, undefined, undefined, m)
                  },
                }, t('git.commit')))))
          }

          // 在右侧边栏打开完整文件（复用 DSH 内置 text 预览 tab）：
          // 地址 = dsh-resource://file/session/<会话id>/<绝对路径>（逐段编码，: 保留）
          const openInSidebar = (absPath, relPath) => {
            const sid = ctx.sidebarRight.mounted ? ctx.sidebarRight.mounted.getSnapshot() : undefined
            if (!sid) {
              setNotice({ error: '当前没有活动会话，无法在侧边栏打开文件' })
              return
            }
            const abs = (absPath + '/' + relPath).replace(/\\/g, '/')
            const enc = abs.split('/').map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/')
            ctx.sidebarRight.openResource(`dsh-resource://file/session/${encodeURIComponent(sid)}/${enc}`)
          }

          // 单文件 diff 抽屉：unified 格式逐行着色（+绿 / -红 / @@ 段头灰）
          const renderGitDiff = () => {
            const g = gitDiff
            if (!g) return null
            const all = (g.unified || '').split('\n')
            const shown = all.slice(0, 2000)
            const plus = all.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
            const minus = all.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
            const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            const lineRow = (l, i) => {
              let bg
              let color = 'inherit'
              let mark = ' '
              if (l.startsWith('@@')) { bg = 'var(--dsw-alias-bg-layer-2)'; color = 'var(--dsw-alias-label-secondary)' }
              else if (l.startsWith('+++') || l.startsWith('---')) { color = 'var(--dsw-alias-label-secondary)' }
              else if (l.startsWith('+')) { bg = 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)'; color = 'var(--dsw-alias-state-success-primary)'; mark = '+' }
              else if (l.startsWith('-')) { bg = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)'; color = 'var(--dsw-alias-state-error-primary)'; mark = '-' }
              else if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('\\')) return null
              return h('div', {
                key: i,
                style: { display: 'flex', gap: 8, background: bg, whiteSpace: 'pre', lineHeight: '18px', fontSize: 11, fontFamily: MONO },
              },
                h('span', { style: { width: '1ch', flexShrink: 0, color: 'var(--dsw-alias-label-secondary)', opacity: 0.6 } }, mark),
                h('span', { style: { flex: 1, minWidth: 0, overflowX: 'auto', color } }, l))
            }
            return drawerWith(() => setGitDiff(null), h('div', { style: styles.drawer },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  crumbs([
                    { label: t('nav.projects'), onClick: () => { setGitDiff(null); setGitPanel(null) } },
                    { label: `${g.id} · ${t('git')}`, onClick: () => setGitDiff(null) },
                    { label: g.path.split('/').pop(), title: g.path },
                  ])),
                // 关闭：常见设计——无边框幽灵按钮、次级色 ×，hover 变主文字色
                h('button', {
                  style: {
                    border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0,
                    width: 26, height: 26, borderRadius: 6, display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    fontSize: 15, lineHeight: 1, color: 'var(--dsw-alias-label-secondary)',
                  },
                  className: 'devctl-close-btn',
                  title: t('back'),
                  onClick: () => setGitDiff(null),
                }, '×')),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
                h('span', { style: { ...styles.meta, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  g.path + (g.untracked ? ` · ${t('git.untrackedNew')}` : '')),
                plus || minus
                  ? h('span', null,
                      h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 } }, `+${plus}`),
                      ' ',
                      h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, `−${minus}`))
                  : null,
                // 复用 DSH 内置侧边栏预览打开完整文件（删除态文件没有内容可看）
                g.state !== 'deleted' && gitPanel && gitPanel.data && gitPanel.data.absPath
                  ? h('button', {
                      style: { ...styles.btn, fontSize: 10, padding: '2px 8px', flexShrink: 0 },
                      title: t('git.openFullTip'),
                      onClick: () => openInSidebar(gitPanel.data.absPath, g.path),
                    }, `⇱ ${t('git.openFull')}`)
                  : null),
              g.loading
                ? h('div', { style: { ...styles.meta, padding: '12px 0' } }, t('loading'))
                : g.error
                  ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: '8px 0' } }, g.error)
                  : shown.length && g.unified
                    ? h('div', {
                        style: {
                          marginTop: 6, overflowX: 'auto', overflowY: 'auto', maxHeight: '52vh',
                          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
                          background: 'var(--dsw-alias-bg-layer-1)', padding: '4px 0',
                        },
                      },
                        shown.map(lineRow).filter(Boolean),
                        (g.truncated || all.length > 2000)
                          ? h('div', { style: { ...styles.meta, padding: '4px 8px' } }, t('git.filesTruncated'))
                          : null)
                    : h('div', { style: { ...styles.meta, padding: '12px 0' } }, t('git.diffEmpty'))))
          }

          const renderGitConfirm = () => {
            const isDelete = gitConfirm.op === 'delete'
            const isDanger = isDelete || gitConfirm.op === 'merge-abort'
            return drawerWith(() => setGitConfirm(null), h('div', { style: styles.drawer },
              h('div', { style: { ...styles.confirmTitle, ...(isDanger ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) } },
                t(`git.confirm.${gitConfirm.op}`)),
              h('div', { ...styles.meta, marginBottom: 8 }, t('confirmHint')),
              isDelete
                ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } }, `! ${t('git.deleteHint')}`)
                : gitConfirm.op === 'merge-abort'
                  ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } }, `! ${t('git.mergeAbortHint')}`)
                  : gitConfirm.warn
                    ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } }, `! ${gitConfirm.warn}`)
                    : null,
              kv(t('project'), gitConfirm.id),
              gitConfirm.branch ? kv(t('git.branch'), gitConfirm.branch) : null,
              gitConfirm.msg ? kv(t('git.commitMsgLabel'), gitConfirm.msg) : null,
              kv(t('cwd'), gitConfirm.cwd),
              h('div', { style: styles.cmdLabel }, t('command')),
              h('pre', { style: styles.pre }, gitConfirm.cmd),
              h('div', { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setGitConfirm(null) }, t('cancel')),
                isDelete
                  ? h('button', {
                      style: {
                        ...styles.btn,
                        borderColor: 'var(--dsw-alias-state-error-primary)',
                        background: 'var(--dsw-alias-state-error-primary)',
                        color: '#fff',
                      },
                      title: '强制删除：git branch -D。未合并分支独有的提交会被丢弃，仅在确认已在别处保留后使用',
                      onClick: () => executeGitAction(true),
                    }, '强制删除')
                  : null,
                h('button', {
                  style: isDanger
                    ? { ...styles.btn, ...styles.btnStop }
                    : { ...styles.btn, ...styles.btnRun },
                  onClick: () => executeGitAction(false),
                }, t('execute')))))
          }

          const renderConfirm = () => {
            const { mode, project, task, plan, loading: planLoading, error: planError } = confirm
            const isRelease = task.section === 'release'
            return drawerWith(() => setConfirm(null), h('div', { style: styles.drawer },
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
              // run 且非发布类：可勾选"本次会话直接运行"，降低高频操作确认成本
              mode === 'run' && task.section !== 'release'
                ? h('label', {
                    style: { ...styles.meta, display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, cursor: 'pointer', userSelect: 'none' },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: quickRun.has(`${project.id}/${task.name}`),
                    onChange: (e) => setQuickRun((s) => {
                      const n = new Set(s)
                      const k = `${project.id}/${task.name}`
                      if (e.target.checked) n.add(k); else n.delete(k)
                      return n
                    }),
                  }),
                  t('quickRunHint'))
                : null,
              h('div', { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setConfirm(null) }, t('cancel')),
                h('button', { style: { ...styles.btn, ...styles.btnRun }, disabled: planLoading || !plan, onClick: executeConfirmed }, t('execute'))))
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
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '-10px -12px 8px' } },
                crumbs([
                  { label: t('nav.projects'), onClick: () => setCon(null) },
                  { label: `${rec ? rec.projectId : con.runId} · ${t('console')}` },
                ])),
              rec && rec.task ? h('div', { style: { ...styles.meta, margin: '-4px 0 4px' } }, rec.task) : null,
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
            // 分组头：可折叠（localStorage 记忆），计数徽标在右
            const gCollapsed = collapsedGroups.has(g)
            rows.push(h('button', {
              key: `g-${g}`, style: styles.groupHead,
              onClick: () => toggleGroup(g),
              title: gCollapsed ? t('expandGroup') : t('collapseGroup'),
            },
              h('span', { style: { width: '1em', flexShrink: 0 } }, gCollapsed ? '▸' : '▾'),
              t(g),
              h('span', { style: styles.groupCount }, String(list.length))))
            if (gCollapsed) continue
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
                // 整行可点：点项目行 = 展开/收起任务区（展开状态即操作入口，
                // ▶/▾/× 都不再放行上——小图标命中难且易误触）
                h('div', {
                  key: p.id, style: { ...styles.row, cursor: taskCount ? 'pointer' : 'default' }, className: 'devctl-row',
                  onClick: () => { if (taskCount) setExpanded(isOpen ? null : p.id) },
                },
                  h('div', {
                    style: styles.name,
                    title: [p.id, p.packageName && p.packageName !== p.id ? `package: ${p.packageName}` : null, p.basePort ? `端口 ${p.basePort}` : null].filter(Boolean).join('\n'),
                  },
                    h('span', { style: live ? styles.dot : building ? styles.dotBuild : styles.dotIdle }),
                    p.id,
                    taskCount && !isOpen ? h('span', { style: { ...styles.meta, marginLeft: 6, fontSize: 10 }, title: t('more') }, '▾') : null,
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
                        onClick: (e) => { e.stopPropagation(); openGitPanel(p.id) },
                      }, (() => {
                        const g = gitBranches[p.id]
                        const kn = gitKnown[p.id]
                        const label = g.detached ? (g.sha || 'detached') : g.branch
                        const mark =
                          kn && kn.dirty ? '±' : kn && kn.ahead > 0 ? '↑' : kn && kn.behind > 0 ? '↓' : ''
                        return `⎇ ${label}${mark}`
                      })())
                    : null)
              )

              if (isOpen) {
                const grp = taskGroups([...runTasks, ...buildTasks])
                const kindOf = (tk) => (tk.kind === 'run' ? 'run' : 'build')
                // 发布类任务单独一组：它会把产物写到私服，和普通打包风险级别不同
                const relTasks = buildTasks.filter((x) => x.section === 'release')
                const mntTasks = buildTasks.filter((x) => x.section !== 'release')
                const buildLabel = relTasks.length ? t('section.build') : t('build')
                rows.push(
                  h('div', { key: `${p.id}-tasks`, style: { ...styles.taskBox, position: 'relative' } },
                    // 剔除入口：展开区右上角，红描边按钮（纯文字，悬浮提示）
                    h('button', {
                      style: {
                        ...styles.btn, ...styles.btnStop,
                        position: 'absolute', top: 6, right: 8,
                        padding: '3px 12px', background: 'transparent',
                      },
                      disabled: isBusy,
                      title: '把该项目从面板列表剔除（已剔除区可随时选回）',
                      onClick: () => toggleMember(p.id, 'exclude'),
                    }, t('drop')),
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
            rows.push(h('div', { key: 'no-match', style: styles.emptyState },
              h('div', { style: { fontSize: 22, lineHeight: 1.4 } }, q ? '🔍' : '▦'),
              h('div', null, q ? t('noMatch') : t('empty')),
              h('div', { style: { fontSize: 11 } }, q ? t('noMatchHint') : t('emptyHint'))))
          }

          if (excluded.length) {
            rows.push(h('div', {
              key: 'g-excluded',
              style: { ...styles.groupTitle, borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 4, paddingTop: 10 },
            }, `${t('dropped')} ${excluded.length}`))
            for (const e of excluded) {
              rows.push(
                h('div', { key: `x-${e.id}`, style: styles.row, className: 'devctl-row' },
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

          // tab 主体：占满右侧边栏 pane（宽高/折叠/浮动由宿主管），
          // position:relative 让内部 inset:0 的 git/确认/控制台覆盖层有正确定位基准
          return h('div', {
            ref: rootRef,
            className: 'devctl-panel-root',
            style: {
              ...styles.panel,
              position: 'relative', width: '100%', height: '100%',
              maxWidth: 'none', maxHeight: 'none', borderRadius: 0,
              border: 'none', boxShadow: 'none', right: 'auto', bottom: 'auto',
            },
          },
            h('div', { style: styles.header },
              h('div', null,
                h('div', { style: { fontWeight: 600 } }, t('title')),
                h('div', { style: styles.meta }, confirm ? t('confirmHint') : con ? t('console') : counts)),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', {
                  style: styles.btn,
                  title: '用系统默认编辑器打开 devctl.config.json',
                  onClick: async () => {
                    try {
                      const r = await post('/open-config', {})
                      setNotice({ text: `已在编辑器中打开：${r.file}` })
                    } catch (e) {
                      setNotice({ error: `打开配置失败: ${e.message}` })
                    }
                  },
                }, '⚙'),
                h('button', {
                  style: styles.btn,
                  onClick: () => { setConfirm(null); setCon(null); setGitPanel(null); setGitConfirm(null); loadProjects(); loadStatus() },
                }, t('refresh')))),
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
            gitConfirm ? renderGitConfirm() : null,
            gitDiff ? renderGitDiff() : null,
            gitCommitDraft ? renderCommitDraft() : null)
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'devctl.fab', order: 60 }, DevctlFab)
        )

        // 右侧边栏集成（与内置终端面板同款两段式注册）：
        //   ① sidebarRightTabs 注册页面类型（kind 'devctl'，guide 卡片出现在
        //      右侧边栏引导页，点卡片即开面板 tab）
        //   ② sidebar.right.pane.tab 以类型 id 为 key 注册 tab 主体 = Panel
        // tab 默认不 keepMounted：隐藏即卸载，/status 3s 轮询与日志 tail 随之停止
        const TYPE_ID = 'dsh-devctl-panel/projects'
        ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: 'devctl',
          priority: 'extension',
          // keepMounted：切走 tab 保持挂载（git 面板/控制台状态不丢）；
          // 隐藏期间的轮询由 Panel 内的可见性门控拦下，不会后台空转
          keepMounted: true,
          title: () => t('title'),
          guide: [{ id: 'projects', order: 40, title: () => t('title'), description: () => t('subtitle') }],
        })
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, Panel)
        )
      },
    }
  },
})
