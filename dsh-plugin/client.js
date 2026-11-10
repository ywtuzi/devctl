/**
 * DevCTL 面板 —— Client 半。
 * 在 shell.overlay（可穿透的浮动层）里渲染右下角悬浮按钮 + 项目面板。
 *
 * 定位：面板以「状态展示」为主。
 * - 顶部常驻「运行中 / 打包中」区块，带时长与停止按钮
 * - 运行 / 打包 一律先弹确认，把将要执行的完整命令摊开给用户看
 */
window.__ModuleLoader__.load({
  id: 'dsh-devctl-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/devctl-api'

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

    function groupOf(p) {
      if (p.kind === 'mixed') return 'fullstack'
      if (p.kind === 'maven') return 'backend'
      const t = p.type
      if (t === 'vue-cli' || t === 'vite' || t === 'uni-app' || t === 'vuepress') return 'frontend'
      return 'tool'
    }

    const GROUPS = ['frontend', 'backend', 'fullstack', 'tool']

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('devctl', 'zh', {
          title: '项目运行器',
          subtitle: '状态面板 · 执行前确认',
          run: '运行',
          build: '打包',
          stop: '停止',
          refresh: '刷新',
          empty: '没有扫描到项目',
          loading: '加载中…',
          frontend: '前端',
          backend: '后端',
          fullstack: '全栈',
          tool: '工具',
          running: '运行中',
          building: '打包中',
          failed: '失败',
          pick: '选入',
          drop: '剔除',
          dropped: '已剔除',
          byUser: '面板剔除',
          byConfig: '配置排除',
          more: '更多任务',
          fewer: '收起任务',
          project: '项目',
          task: '任务',
          cwd: '执行目录',
          runtime: '运行时',
          port: '端口',
          command: '命令',
          process: '实际进程',
          cancel: '取消',
          execute: '确认执行',
          confirmRun: '确认运行？',
          confirmBuild: '确认打包？',
          confirmHint: '执行前请确认以下指令',
          viewCommand: '查看命令',
        })
        ctx.locale.register('devctl', 'en', {
          title: 'Project runner',
          subtitle: 'Status panel · confirm before run',
          run: 'Run',
          build: 'Build',
          stop: 'Stop',
          refresh: 'Refresh',
          empty: 'No projects found',
          loading: 'Loading…',
          frontend: 'Frontend',
          backend: 'Backend',
          fullstack: 'Full stack',
          tool: 'Tools',
          running: 'Running',
          building: 'Building',
          failed: 'Failed',
          pick: 'Include',
          drop: 'Exclude',
          dropped: 'Excluded',
          byUser: 'Excluded here',
          byConfig: 'Config exclude',
          more: 'More tasks',
          fewer: 'Hide tasks',
          project: 'Project',
          task: 'Task',
          cwd: 'Working dir',
          runtime: 'Runtime',
          port: 'Port',
          command: 'Command',
          process: 'Process',
          cancel: 'Cancel',
          execute: 'Run it',
          confirmRun: 'Run this?',
          confirmBuild: 'Build this?',
          confirmHint: 'Review the exact command before running',
          viewCommand: 'Show command',
        })
        const t = ctx.locale.bind('devctl')

        function Panel() {
          const [open, setOpen] = useState(false)
          const [projects, setProjects] = useState([])
          const [excluded, setExcluded] = useState([])
          const [running, setRunning] = useState([])
          const [expanded, setExpanded] = useState(null)
          const [busy, setBusy] = useState('')
          const [notice, setNotice] = useState(null)
          const [error, setError] = useState(null)
          const [loading, setLoading] = useState(true)
          // 二次确认：{ mode, project, task, plan, loading, error }
          const [confirm, setConfirm] = useState(null)

          const loadProjects = useCallback(async () => {
            setLoading(true)
            try {
              const d = await call('/projects')
              setProjects(d.projects || [])
              setExcluded(d.excluded || [])
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
            } catch {
              /* 状态轮询失败不打断界面 */
            }
          }, [])

          useEffect(() => {
            loadProjects()
          }, [loadProjects])

          useEffect(() => {
            if (!open) return undefined
            loadStatus()
            const id = setInterval(loadStatus, 3000)
            return () => clearInterval(id)
          }, [open, loadStatus])

          const act = async (label, fn) => {
            setBusy(label)
            setNotice(null)
            try {
              const msg = await fn()
              setNotice(msg)
              await loadStatus()
              await loadProjects()
            } catch (e) {
              setNotice({ error: `${t('failed')}: ${e.message}` })
            } finally {
              setBusy('')
            }
          }

          const toggleMember = (id, mode) =>
            act(id, async () => {
              const r = await post(mode === 'exclude' ? '/exclude' : '/include', { id })
              if (r.status === 'visible') return `${id} · ${t('pick')}`
              if (r.status === 'excluded') return `${id} · ${t('drop')}`
              return `${id} · 未找到对应项目`
            })

          // —— 打开确认框：先取「预演」，不执行任何东西 ——
          const requestAction = async (project, task, mode) => {
            setNotice(null)
            setConfirm({ mode, project, task, plan: null, loading: true, error: null })
            try {
              const plan = await post('/preview', { id: project.id, task: task.name })
              setConfirm((c) => (c ? { ...c, plan, loading: false } : c))
            } catch (e) {
              setConfirm((c) => (c ? { ...c, loading: false, error: e.message } : c))
            }
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
              const r = await post('/build', { id: project.id, task: task.name })
              if (r && r.busy) return `${project.id} 已在打包中（${r.runId}）`
              return `${project.id} · ${task.name} 开始打包`
            })
          }

          const runInstances = []
          const buildInstances = []
          const runningByProject = {}
          for (const r of running) {
            const def = (projects.find((p) => p.id === r.projectId)?.tasks || []).find(
              (x) => x.name === r.task
            )
            const kind = def ? def.kind : 'run'
            if (kind === 'build') buildInstances.push({ ...r, label: def?.label })
            else {
              runInstances.push({ ...r, label: def?.label })
              runningByProject[r.projectId] = r
            }
          }
          const buildingByProject = {}
          for (const b of buildInstances) {
            if (!buildingByProject[b.projectId]) buildingByProject[b.projectId] = []
            buildingByProject[b.projectId].push(b)
          }

          const elapsed = (r) => {
            const s = Math.max(0, Math.round((Date.now() - Date.parse(r.startedAt)) / 1000))
            return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
          }

          const grouped = {}
          for (const p of projects) {
            const g = groupOf(p)
            if (!grouped[g]) grouped[g] = []
            grouped[g].push(p)
          }

          const styles = {
            layer: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9000, fontFamily: 'inherit' },
            fab: {
              position: 'fixed',
              right: 20,
              bottom: 20,
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 12px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-overlay)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            },
            panel: {
              position: 'fixed',
              right: 20,
              bottom: 64,
              width: 440,
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              pointerEvents: 'auto',
              borderRadius: 12,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-overlay)',
              boxShadow: '0 10px 32px rgba(0,0,0,0.24)',
              overflow: 'hidden',
              fontSize: 12,
              color: 'var(--dsw-alias-label-primary)',
            },
            header: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
            body: { overflowY: 'auto', padding: '4px 0' },
            groupTitle: { padding: '8px 12px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            liveTitle: {
              padding: '8px 12px 4px',
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              marginBottom: 2,
            },
            row: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' },
            name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
            btn: {
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              borderRadius: 6,
              padding: '2px 7px',
              fontSize: 11,
              cursor: 'pointer',
            },
            btnRun: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
            btnStop: {
              borderColor: 'var(--dsw-alias-state-error-primary)',
              color: 'var(--dsw-alias-state-error-primary)',
            },
            btnGhost: { borderColor: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
            notice: {
              padding: '6px 12px',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              maxHeight: 64,
              overflowY: 'auto',
              wordBreak: 'break-all',
            },
            dot: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: 'var(--dsw-alias-state-success-primary)',
              display: 'inline-block',
              marginRight: 6,
            },
            dotBuild: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: 'var(--dsw-alias-state-warn-primary)',
              display: 'inline-block',
              marginRight: 6,
            },
            taskBox: {
              padding: '2px 12px 10px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'var(--dsw-alias-bg-layer-1)',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
            chips: { display: 'flex', flexWrap: 'wrap', gap: 4 },
            chip: {
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              borderRadius: 999,
              padding: '2px 9px',
              fontSize: 11,
              cursor: 'pointer',
            },
            chipRun: { borderColor: 'var(--dsw-alias-brand-primary)' },
            taskGroupLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 },
            confirm: { padding: '12px 14px' },
            confirmTitle: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
            kvRow: { display: 'flex', gap: 8, padding: '2px 0' },
            kvKey: { width: 62, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' },
            kvVal: { flex: 1, minWidth: 0, wordBreak: 'break-all' },
            cmdLabel: { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' },
            pre: {
              margin: '3px 0 0',
              padding: '7px 9px',
              borderRadius: 6,
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 120,
              overflowY: 'auto',
              userSelect: 'text',
            },
            actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
          }

          // —— 确认视图 ——
          const renderConfirm = () => {
            const cur = confirm
            const { mode, project, task, plan, loading: planLoading, error: planError } = cur
            const kv = (k, v) =>
              v == null || v === ''
                ? null
                : h('div', { key: k, style: styles.kvRow }, h('span', { style: styles.kvKey }, k), h('span', { style: styles.kvVal }, String(v)))

            return h(
              'div',
              { style: styles.confirm },
              h(
                'div',
                { style: styles.confirmTitle },
                mode === 'run' ? t('confirmRun') : t('confirmBuild')
              ),
              h('div', { style: { ...styles.meta, marginBottom: 8 } }, t('confirmHint')),
              kv(t('project'), project.id),
              kv(t('task'), `${task.label || task.name}  (${task.name})`),
              planLoading ? h('div', { style: styles.meta }, t('loading')) : null,
              planError
                ? h(
                    'div',
                    { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 } },
                    planError
                  )
                : null,
              plan
                ? h(
                    'div',
                    null,
                    kv(t('cwd'), plan.cwd),
                    kv(
                      t('runtime'),
                      plan.type === 'mvn' ? `java ${plan.javaHome || ''}` : `node ${plan.nodeVersion}`
                    ),
                    kv(t('port'), plan.port ? `${plan.port}  ${plan.url || ''}` : null),
                    plan.debugPort
                      ? kv('调试端口', `${plan.debugPort}（IDE 远程 attach 到 localhost:${plan.debugPort}）`)
                      : null,
                    plan.debug
                      ? kv('启动方式', 'suspend=n —— 应用照常启动，随时可以 attach')
                      : null,
                    h('div', { style: styles.cmdLabel }, t('command')),
                    h('pre', { style: styles.pre }, plan.display),
                    h('div', { style: styles.cmdLabel }, t('process')),
                    h('pre', { style: styles.pre }, [plan.cmd, ...(plan.args || [])].join(' ')),
                    plan.warnings && plan.warnings.length
                      ? h(
                          'div',
                          { style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 8 } },
                          plan.warnings.map((w, i) => h('div', { key: i }, `! ${w}`))
                        )
                      : null
                  )
                : null,
              h(
                'div',
                { style: styles.actions },
                h('button', { style: styles.btn, onClick: () => setConfirm(null) }, t('cancel')),
                h(
                  'button',
                  {
                    style: { ...styles.btn, ...styles.btnRun },
                    disabled: planLoading || !plan,
                    onClick: executeConfirmed,
                  },
                  t('execute')
                )
              )
            )
          }

          // —— 列表视图 ——
          const rows = []

          if (runInstances.length) {
            rows.push(h('div', { key: 'h-run', style: styles.liveTitle }, `${t('running')} ${runInstances.length}`))
            for (const r of runInstances) {
              rows.push(
                h(
                  'div',
                  { key: `run-${r.runId}`, style: styles.row },
                  h(
                    'div',
                    { style: styles.name },
                    h('span', { style: styles.dot }),
                    r.projectId,
                    h(
                      'div',
                      { style: styles.meta },
                      `${r.task}${r.url ? ` · ${r.url}` : ''} · ${elapsed(r)}`
                    )
                  ),
                  h(
                    'button',
                    {
                      style: { ...styles.btn, ...styles.btnStop },
                      disabled: busy === r.runId,
                      onClick: () =>
                        act(r.runId, async () => {
                          await post('/stop', { runId: r.runId })
                          return `${r.projectId} 已停止`
                        }),
                    },
                    t('stop')
                  )
                )
              )
            }
          }

          if (buildInstances.length) {
            rows.push(
              h('div', { key: 'h-build', style: styles.liveTitle }, `${t('building')} ${buildInstances.length}`)
            )
            for (const r of buildInstances) {
              rows.push(
                h(
                  'div',
                  { key: `build-${r.runId}`, style: styles.row },
                  h(
                    'div',
                    { style: styles.name },
                    h('span', { style: styles.dotBuild }),
                    r.projectId,
                    h('div', { style: styles.meta }, `${r.task} · ${elapsed(r)}`)
                  ),
                  h(
                    'button',
                    {
                      style: { ...styles.btn, ...styles.btnStop },
                      disabled: busy === r.runId,
                      onClick: () =>
                        act(r.runId, async () => {
                          await post('/stop', { runId: r.runId })
                          return `${r.projectId} 打包已中止`
                        }),
                    },
                    t('stop')
                  )
                )
              )
            }
          }

          for (const g of GROUPS) {
            const list = grouped[g]
            if (!list || !list.length) continue
            rows.push(h('div', { key: `g-${g}`, style: styles.groupTitle }, t(g)))
            for (const p of list) {
              const runTasks = (p.tasks || []).filter((x) => x.kind === 'run')
              const buildTasks = (p.tasks || []).filter((x) => x.kind === 'build')
              const runTask = runTasks[0]
              const buildTask = buildTasks[0]
              const hasChoices = runTasks.length > 1 || buildTasks.length > 1
              const isOpen = expanded === p.id
              const live = runningByProject[p.id]
              const building = buildingByProject[p.id]
              const isBusy = busy === p.id

              let meta
              if (live) meta = `${t('running')} ${live.url || ''} · ${elapsed(live)}`
              else if (building) meta = `${t('building')}… · ${building.map((b) => b.task).join(', ')}`
              else
                meta = `${p.type}${p.node ? ` · n${p.node}` : ''}${
                  hasChoices ? ` · ${runTasks.length + buildTasks.length} 个任务` : ''
                }`

              rows.push(
                h(
                  'div',
                  { key: p.id, style: styles.row },
                  h(
                    'div',
                    {
                      style: styles.name,
                      title: [p.id, p.packageName && p.packageName !== p.id ? `package: ${p.packageName}` : null, p.basePort ? `端口 ${p.basePort}` : null]
                        .filter(Boolean)
                        .join('\n'),
                    },
                    live ? h('span', { style: styles.dot }) : building ? h('span', { style: styles.dotBuild }) : null,
                    p.id,
                    h('div', { style: styles.meta }, meta)
                  ),
                  runTask
                    ? h(
                        'button',
                        {
                          style: { ...styles.btn, ...styles.btnRun },
                          disabled: isBusy,
                          title: t('viewCommand'),
                          onClick: () => requestAction(p, runTask, 'run'),
                        },
                        t('run')
                      )
                    : null,
                  buildTask
                    ? h(
                        'button',
                        {
                          style: styles.btn,
                          disabled: isBusy || Boolean(building),
                          title: building ? `${t('building')}…` : t('viewCommand'),
                          onClick: () => requestAction(p, buildTask, 'build'),
                        },
                        t('build')
                      )
                    : null,
                  hasChoices
                    ? h(
                        'button',
                        {
                          style: styles.btn,
                          disabled: isBusy,
                          title: isOpen ? t('fewer') : t('more'),
                          onClick: () => setExpanded(isOpen ? null : p.id),
                        },
                        isOpen ? '▴' : '▾'
                      )
                    : null,
                  live
                    ? h(
                        'button',
                        {
                          style: { ...styles.btn, ...styles.btnStop },
                          disabled: isBusy,
                          onClick: () =>
                            act(p.id, async () => {
                              await post('/stop', { projectId: p.id })
                              return `${p.id} 已停止`
                            }),
                        },
                        t('stop')
                      )
                    : null,
                  h(
                    'button',
                    {
                      style: { ...styles.btn, ...styles.btnGhost },
                      disabled: isBusy,
                      title: t('drop'),
                      onClick: () => toggleMember(p.id, 'exclude'),
                    },
                    '×'
                  )
                )
              )

              if (isOpen) {
                const chipList = (tasks, kind) =>
                  h(
                    'div',
                    { style: styles.chips },
                    tasks.map((tk) =>
                      h(
                        'button',
                        {
                          key: `${kind}-${tk.name}`,
                          style: kind === 'run' ? { ...styles.chip, ...styles.chipRun } : styles.chip,
                          disabled: isBusy || (kind === 'build' && Boolean(building)),
                          title: `${tk.name} · ${t('viewCommand')}`,
                          onClick: () => requestAction(p, tk, kind === 'run' ? 'run' : 'build'),
                        },
                        tk.label || tk.name
                      )
                    )
                  )

                rows.push(
                  h(
                    'div',
                    { key: `${p.id}-tasks`, style: styles.taskBox },
                    runTasks.length
                      ? h('div', { style: styles.taskGroupLabel }, `${t('run')} (${runTasks.length})`)
                      : null,
                    runTasks.length ? chipList(runTasks, 'run') : null,
                    buildTasks.length
                      ? h('div', { style: styles.taskGroupLabel }, `${t('build')} (${buildTasks.length})`)
                      : null,
                    buildTasks.length ? chipList(buildTasks, 'build') : null
                  )
                )
              }
            }
          }

          if (excluded.length) {
            rows.push(
              h(
                'div',
                {
                  key: 'g-excluded',
                  style: {
                    ...styles.groupTitle,
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    marginTop: 4,
                    paddingTop: 10,
                  },
                },
                `${t('dropped')} ${excluded.length}`
              )
            )
            for (const e of excluded) {
              rows.push(
                h(
                  'div',
                  { key: `x-${e.id}`, style: styles.row },
                  h(
                    'div',
                    { style: styles.name, title: e.pattern ? `排除规则: ${e.pattern}` : '' },
                    h('span', { style: { ...styles.meta, marginRight: 0 } }, e.id),
                    h('div', { style: styles.meta }, e.reason === 'user' ? t('byUser') : t('byConfig'))
                  ),
                  h(
                    'button',
                    {
                      style: styles.btn,
                      disabled: busy === e.id,
                      onClick: () => toggleMember(e.id, 'include'),
                    },
                    t('pick')
                  )
                )
              )
            }
          }

          const counts = [
            `${projects.length} 个项目`,
            `${runInstances.length} ${t('running')}`,
            buildInstances.length ? `${buildInstances.length} ${t('building')}` : null,
            excluded.length ? `${excluded.length} ${t('dropped')}` : null,
          ]
            .filter(Boolean)
            .join(' · ')

          return h(
            'div',
            { style: styles.layer },
            open
              ? h(
                  'div',
                  { style: styles.panel },
                  h(
                    'div',
                    { style: styles.header },
                    h(
                      'div',
                      null,
                      h('div', { style: { fontWeight: 600 } }, t('title')),
                      h('div', { style: styles.meta }, confirm ? t('confirmHint') : counts)
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6 } },
                      h(
                        'button',
                        {
                          style: styles.btn,
                          onClick: () => {
                            setConfirm(null)
                            loadProjects()
                            loadStatus()
                          },
                        },
                        t('refresh')
                      ),
                      h(
                        'button',
                        {
                          style: styles.btn,
                          onClick: () => {
                            setConfirm(null)
                            setOpen(false)
                          },
                        },
                        '×'
                      )
                    )
                  ),
                  h(
                    'div',
                    { style: styles.body },
                    confirm
                      ? renderConfirm()
                      : [
                          loading && !projects.length
                            ? h('div', { key: 'ld', style: styles.groupTitle }, t('loading'))
                            : null,
                          error
                            ? h(
                                'div',
                                { key: 'err', style: { ...styles.notice, color: 'var(--dsw-alias-state-error-primary)' } },
                                error
                              )
                            : null,
                          !loading && !projects.length && !error
                            ? h('div', { key: 'empty', style: styles.groupTitle }, t('empty'))
                            : null,
                          ...rows,
                        ]
                  ),
                  notice
                    ? h(
                        'div',
                        {
                          style: {
                            ...styles.notice,
                            color: notice.error
                              ? 'var(--dsw-alias-state-error-primary)'
                              : 'var(--dsw-alias-label-secondary)',
                          },
                        },
                        notice.error || notice
                      )
                    : null
                )
              : null,
            h(
              'button',
              {
                style: styles.fab,
                onClick: () => {
                  const next = !open
                  setOpen(next)
                  if (next) {
                    loadProjects()
                    loadStatus()
                  }
                },
                title: t('subtitle'),
              },
              '▦ ',
              t('title'),
              runInstances.length || buildInstances.length
                ? ` · ${runInstances.length + buildInstances.length}`
                : ''
            )
          )
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'devctl.panel', order: 60 }, Panel)
        )
      },
    }
  },
})
