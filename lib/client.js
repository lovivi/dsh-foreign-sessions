/**
 * dsh-foreign-sessions —— 客户端半端（预构建自注册脚本，非 ESM）
 *
 * 面板：左侧栏图标 + 全局面板。
 *   - 顶部：Agent 选择
 *   - 左列：项目（按 cwd 分组）
 *   - 中列：会话列表
 *   - 右列：预览 + 导入表单
 */
window.__DSH_FOREIGN_VERSION__ = '0.6.1'
window.__ModuleLoader__.load({
  id: 'dsh-foreign-sessions',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback } = React

    const API = '/api/foreign'

    async function jget(path) {
      const res = await fetch(API + path, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    async function jpost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
    const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

    const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '—')
    const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB')
    const fmtNum = (n) => n.toLocaleString('en-US')

    const CSS = {
      // 全部走 DSH 主题 token（浅色/深色自动跟随），失败才用中性回退
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13,
              color: 'var(--dsw-alias-label-primary)', background: 'transparent' },
      bar: { display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px',
             borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))' },
      cols: { display: 'flex', flex: 1, minHeight: 0 },
      col: { overflow: 'auto', padding: 10,
             borderRight: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))' },
      projHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '5px 4px', margin: '8px 0 2px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))', cursor: 'pointer',
                  borderRadius: 'var(--dsw-radius-xs, 4px)' },
      projTitle: { fontSize: 11, margin: '10px 0 4px',
                   color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
                   textShadow: '0 1px 1px rgba(0,0,0,.10)',
                   wordBreak: 'break-all' },
      row: { padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm, 6px)', cursor: 'pointer', marginBottom: 4 },
      rowOn: { background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))' },
      rowHover: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10))' },
      title: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
               color: 'var(--dsw-alias-label-primary)' },
      // 「用户信息」这类次级文字：靠二级色 + 一点点阴影提可读性，不做纯反差
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
              textShadow: '0 1px 1px rgba(0,0,0,.12)' },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
              textShadow: '0 1px 1px rgba(0,0,0,.10)' },
      dim: { color: 'var(--dsw-alias-label-tertiary, #8b93a1)', fontSize: 11 },
      input: { width: '100%', padding: '5px 7px', borderRadius: 'var(--dsw-radius-sm, 6px)',
               border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
               background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10))',
               color: 'var(--dsw-alias-label-primary)', fontSize: 12 },
      btn: { padding: '6px 12px', borderRadius: 'var(--dsw-radius-sm, 6px)',
             border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
             background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 12 },
      btnPri: { borderColor: 'var(--dsw-alias-state-business-primary, #4c8dff)',
                color: 'var(--dsw-alias-state-business-primary, #4c8dff)' },
      q: { background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10))',
           borderLeft: '2px solid var(--dsw-alias-state-business-primary, #4c8dff)',
           borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '6px 8px', marginBottom: 8, whiteSpace: 'pre-wrap' },
      a: { whiteSpace: 'pre-wrap', marginBottom: 12, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      tag: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      err: { padding: '6px 12px', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
      probe: { padding: '4px 12px', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
               textShadow: '0 1px 1px rgba(0,0,0,.10)',
               borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))' },
      badge: { fontSize: 10, padding: '0 4px', marginRight: 4, borderRadius: 'var(--dsw-radius-xs, 4px)',
               background: 'var(--dsw-alias-state-business-primary, #4c8dff)', color: '#fff' },
    }

    function Panel(props = {}) {
      const useSessionsHook = typeof props.useSessions === 'function' ? props.useSessions : null
      const [agents, setAgents] = useState([])
      const [agent, setAgent] = useState('kimi-code')
      const [sessions, setSessions] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [sel, setSel] = useState(null)
      const clientRow = useSessionsHook ? useSessionsHook((m) => (sel ? m.byId[sel.id] : null)) : null
      const [preview, setPreview] = useState(null)
      const [target, setTarget] = useState('')
      const [lastN, setLastN] = useState(50)
      const [result, setResult] = useState(null)
      const [kw, setKw] = useState('')
      const [lastRefresh, setLastRefresh] = useState(null)
      const [seen, setSeen] = useState(() => {
        try { return new Set(JSON.parse(localStorage.getItem('dsh.foreign.seen') || '[]')) }
        catch { return new Set() }
      })
      const [onlyNew, setOnlyNew] = useState(false)
      const [kindFilter, setKindFilter] = useState(() => lsGet('dsh.foreign.kind', 'main'))
      const [days, setDays] = useState(() => Number(lsGet('dsh.foreign.days', 0)))
      const [counts, setCounts] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set())
      const [collapsedProjects, setCollapsedProjects] = useState(() => {
        try { return new Set(JSON.parse(lsGet('dsh.foreign.collapsed', '[]'))) } catch { return new Set() }
      })
      const shortPath = (p0) => String(p0 || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/mnt\//, 'mnt:/')
      const baseName = (p0) => {
        const t = String(p0 || '').replace(/\/+$/, '')
        return t.split('/').pop() || t || '(未知目录)'
      }
      const parentTail = (p0) => {
        const segs = String(p0 || '').split('/').filter(Boolean)
        if (segs.length <= 1) return ''
        return '…/' + segs.slice(-3, -1).join('/')
      }
      const toggleProject = (key) => {
        setCollapsedProjects((prev) => {
          const n = new Set(prev)
          n.has(key) ? n.delete(key) : n.add(key)
          lsSet('dsh.foreign.collapsed', JSON.stringify([...n]))
          return n
        })
      }
      const [autoOpen, setAutoOpen] = useState(false)
      const [autoCfg, setAutoCfg] = useState(null)
      const [autoStatus, setAutoStatus] = useState(null)
      const [autoBusy, setAutoBusy] = useState('')
      const [projJob, setProjJob] = useState(null)   // {jobId,cwd,total,done,...}
      const [importedMap, setImportedMap] = useState(() => {
        try { return JSON.parse(lsGet('dsh.foreign.imported', '{}')) || {} } catch { return {} }
      })
      const [probe, setProbe] = useState(null)   // {status, body}

      const importProject = async (cwd, count) => {
        if (!cwd) return
        const kindsMap = { main: ['main'], all: ['main', 'sub', 'fork', 'exec'], sub: ['sub'], fork: ['fork'], exec: ['exec'] }
        const ok = window.confirm(`把项目下的 ${count} 条会话一起导入？\n\n${cwd}\n\n（已导入过的会自动跳过）`)
        if (!ok) return
        setBusy('项目导入中…')
        try {
          const r = await jpost('/import-project', {
            agent: 'all',
            cwd,
            lastN: Number(lastN) || 0,
            kinds: kindsMap[kindFilter] || ['main'],
          })
          setProjJob({ jobId: r.jobId, cwd, total: r.total, done: 0, state: 'running' })
        } catch (e) { setError(String(e.message || e)) }
        finally { setBusy('') }
      }

      const loadAuto = useCallback(async () => {
        try {
          const d = await jget('/auto')
          setAutoCfg(d.config)
          setAutoStatus(d.status)
        } catch (e) { /* 老版本 Host 没有 /auto，忽略 */ }
      }, [])

      useEffect(() => { loadAuto() }, [loadAuto])

      useEffect(() => {
        // 自检：把 Host 半端的状态直接显示出来，失败也能看见原因
        let alive = true
        ;(async () => {
          try {
            const res = await fetch('/api/foreign/agents', { credentials: 'same-origin' })
            const text = await res.text()
            if (alive) setProbe({ status: res.status, body: text.slice(0, 300) })
          } catch (e) {
            if (alive) setProbe({ status: 'ERR', body: String(e && e.message || e) })
          }
        })()
        return () => { alive = false }
      }, [])

      const load = useCallback(async (ag) => {
        setBusy('加载会话…')
        setError('')
        try {
          const a = await jget('/agents')
          setAgents(a.agents)
          if (a.agents.filter((x) => x.available).length > 1 && ag === 'kimi-code' && !window.__dshForeignAllTried) {
            window.__dshForeignAllTried = true
            setAgent('all')
            return
          }
          const s = await jget('/sessions?agent=' + encodeURIComponent(ag))
          setSessions(s.sessions)
          setCounts(s.counts || null)
          setLastRefresh(Date.now())
          setSeen((prev) => {
            if (prev.size) return prev
            // 首次打开：把现有会话全部视为"已见"，之后新增的才标 NEW
            const init = new Set(s.sessions.map((x) => x.id))
            try { localStorage.setItem('dsh.foreign.seen', JSON.stringify([...init])) } catch {}
            return init
          })
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }, [])

      const markSeen = useCallback((id) => {
        setSeen((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          try { localStorage.setItem('dsh.foreign.seen', JSON.stringify([...next])) } catch {}
          return next
        })
      }, [])

      const refreshSessions = useCallback(async (ag) => {
        const s = await jget('/sessions?agent=' + encodeURIComponent(ag))
        setSessions(s.sessions)
        setCounts(s.counts || null)
        setLastRefresh(Date.now())
        return s.sessions
      }, [])

      useEffect(() => {
        if (!projJob?.jobId || projJob.state !== 'running') return
        const t = setInterval(async () => {
          try {
            const st = await jget('/import-project/status?id=' + encodeURIComponent(projJob.jobId))
            setProjJob({ ...st, cwd: projJob.cwd })
            if (st.state !== 'running') {
              clearInterval(t)
              refreshSessions(agent).catch(() => {})
            }
          } catch (e) { /* 忽略轮询错误 */ }
        }, 900)
        return () => clearInterval(t)
      }, [projJob?.jobId, projJob?.state, agent, refreshSessions])

      useEffect(() => { load(agent) }, [agent, load])

      // 自动刷新：每 8 秒拉一次列表，新会话会被标 NEW
      useEffect(() => {
        const t = setInterval(() => {
          refreshSessions(agent).catch(() => {})
        }, 8000)
        return () => clearInterval(t)
      }, [agent, refreshSessions])

      const projects = useMemo(() => {
        const map = new Map()
        for (const s of sessions) {
          const key = s.cwd || '(未知目录)'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(s)
        }
        const out = [...map.entries()]
        out.sort((a, b) => (b[1][0]?.updatedAt ?? 0) - (a[1][0]?.updatedAt ?? 0))
        return out.map(([cwd, list]) => ({ cwd, list }))
      }, [sessions])

      // 子代理索引：parentId -> 子会话（不受类型筛选影响，用于折叠展开）
      const sinceMs = days ? Date.now() - days * 86400000 : 0

      const childrenOf = useMemo(() => {
        const m = new Map()
        for (const s of sessions) {
          if (!s.parentId) continue
          if (!m.has(s.parentId)) m.set(s.parentId, [])
          m.get(s.parentId).push(s)
        }
        return m
      }, [sessions])

      const filtered = useMemo(() => {
        const q = kw.trim().toLowerCase()
        const since = days ? Date.now() - days * 86400000 : 0
        const kindOk = (s) => {
          if (kindFilter === 'all') return true
          if (kindFilter === 'sub') return s.kind === 'sub'
          if (kindFilter === 'fork') return s.kind === 'fork'
          if (kindFilter === 'exec') return s.origin === 'exec'
          // main：排除子代理、副本、脚本运行、无目录的残档
          return s.kind !== 'sub' && s.kind !== 'fork' && s.kind !== 'unknown' && s.origin !== 'exec'
        }
        return projects
          .map((p) => ({
            ...p,
            list: p.list.filter((s) => {
              if (!kindOk(s)) return false
              if (since && (s.updatedAt ?? 0) < since) return false
              if (onlyNew && seen.has(s.id)) return false
              if (!q) return true
              return (s.title + s.cwd).toLowerCase().includes(q)
            }),
          }))
          .filter((p) => p.list.length)
      }, [projects, kw, onlyNew, seen, kindFilter, days])

      const pick = async (s) => {
        markSeen(s.id)
        setSel(s)
        setResult(null)
        setPreview(null)
        setTarget(s.cwd)
        setBusy('读取预览…')
        try {
          const p = await jget(`/turns?agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(s.id)}&limit=5`)
          setPreview(p)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const saveAuto = async (patch) => {
        setAutoBusy('保存…')
        try {
          const d = await jpost('/auto', { ...autoCfg, ...patch })
          setAutoCfg(d.config)
          await loadAuto()
        } catch (e) { setError(String(e.message || e)) }
        finally { setAutoBusy('') }
      }

      const runAutoNow = async () => {
        setAutoBusy('运行中…')
        try {
          const r = await jpost('/auto/run', {})
          setAutoStatus((s0) => ({ ...(s0 || {}), lastRunAt: Date.now(), lastResult: r }))
          await refreshSessions(agent)
        } catch (e) { setError(String(e.message || e)) }
        finally { setAutoBusy('') }
      }

      const doImport = async (force = false) => {
        if (!sel || !target) return
        setBusy('导入中…')
        setError('')
        try {
          const r = await jpost('/import', {
            agent: sel.agent,
            id: sel.id,
            targetCwd: target,
            lastN: Number(lastN) || 0,
            title: sel.title,
            force,
          })
          setResult(r)
          if (!r.duplicate) {
            const key = sel.agent + ':' + sel.id
            const next = { ...importedMap, [key]: r.sessionId }
            setImportedMap(next)
            lsSet('dsh.foreign.imported', JSON.stringify(next))
          }
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      return h('div', { style: CSS.wrap },
        h('div', { style: CSS.bar },
          h('strong', null, '外部会话导入'),
          h('span', { style: CSS.hint }, 'v' + (window.__DSH_FOREIGN_VERSION__ || '?')),
          h('select', {
            value: agent,
            onChange: (e) => setAgent(e.target.value),
            style: { ...CSS.input, width: 140 },
          }, [
            h('option', { key: 'all', value: 'all' }, '全部 Agents'),
            ...(agents.length ? agents : [{ id: 'kimi-code', label: 'Kimi Code', available: true }])
              .map((a) => h('option', { key: a.id, value: a.id, disabled: !a.available },
                a.label + (a.available ? '' : '（不可用）'))),
          ]),
          h('input', {
            style: { ...CSS.input, flex: 1, minWidth: 120 },
            placeholder: '搜索标题 / 路径',
            value: kw,
            onChange: (e) => setKw(e.target.value),
          }),
          h('select', {
            style: { ...CSS.input, width: 132 },
            value: kindFilter,
            title: '会话类型',
            onChange: (e) => { setKindFilter(e.target.value); lsSet('dsh.foreign.kind', e.target.value) },
          }, [
            h('option', { key: 'main', value: 'main' }, `主会话${counts ? ' (' + counts.main + ')' : ''}`),
            h('option', { key: 'all', value: 'all' }, `全部${counts ? ' (' + counts.all + ')' : ''}`),
            h('option', { key: 'sub', value: 'sub' }, `子代理${counts ? ' (' + counts.sub + ')' : ''}`),
            h('option', { key: 'fork', value: 'fork' }, `副本${counts ? ' (' + counts.fork + ')' : ''}`),
            h('option', { key: 'exec', value: 'exec' }, `脚本运行${counts ? ' (' + counts.exec + ')' : ''}`),
          ]),
          h('select', {
            style: { ...CSS.input, width: 96 },
            value: days,
            title: '时间范围',
            onChange: (e) => { setDays(Number(e.target.value)); lsSet('dsh.foreign.days', e.target.value) },
          }, [
            h('option', { key: 0, value: 0 }, '全部时间'),
            h('option', { key: 7, value: 7 }, '近 7 天'),
            h('option', { key: 30, value: 30 }, '近 30 天'),
            h('option', { key: 90, value: 90 }, '近 90 天'),
          ]),
          h('label', { style: { ...CSS.dim, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: onlyNew, onChange: (e) => setOnlyNew(e.target.checked) }),
            '只看新'),
          h('button', {
            style: CSS.btn,
            onClick: () => refreshSessions(agent).catch((e) => setError(String(e))),
          }, '刷新'),
          busy ? h('span', { style: CSS.dim }, busy)
               : h('span', { style: CSS.dim }, lastRefresh ? '更新于 ' + new Date(lastRefresh).toLocaleTimeString('zh-CN', { hour12: false }) : ''),
        ),

        autoCfg ? h('div', { style: { padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', fontSize: 12 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { cursor: 'pointer', fontWeight: 600 }, onClick: () => setAutoOpen(!autoOpen) },
              (autoOpen ? '▾ ' : '▸ ') + '自动导入'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              h('input', { type: 'checkbox', checked: !!autoCfg.enabled,
                onChange: (e) => { setAutoCfg({ ...autoCfg, enabled: e.target.checked }); saveAuto({ enabled: e.target.checked }) } }),
              autoCfg.enabled ? '已启用' : '关闭'),
            autoCfg.enabled ? h('span', { style: CSS.hint },
              `每 ${autoCfg.intervalSec}s · 最近 ${autoCfg.lastN || '全部'} 轮 · kinds=${(autoCfg.kinds || []).join('/') || 'main'}`) : null,
            autoStatus ? h('span', { style: CSS.hint },
              `已自动导入 ${autoStatus.imported || 0} 条` +
              (autoStatus.lastRunAt ? ` · 上次 ${new Date(autoStatus.lastRunAt).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)}` : '')) : null,
            h('button', { style: { ...CSS.btn, marginLeft: 'auto' }, onClick: runAutoNow, disabled: !!autoBusy },
              autoBusy || '立即运行一次'),
          ),
          autoOpen ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
            h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
              h('label', null, '间隔(秒) ',
                h('input', { style: { ...CSS.input, width: 80 }, type: 'number', value: autoCfg.intervalSec,
                  onChange: (e) => setAutoCfg({ ...autoCfg, intervalSec: Number(e.target.value) }) })),
              h('label', null, '最近N轮 ',
                h('input', { style: { ...CSS.input, width: 80 }, type: 'number', value: autoCfg.lastN,
                  onChange: (e) => setAutoCfg({ ...autoCfg, lastN: Number(e.target.value) }) })),
              h('label', null, '最少轮数 ',
                h('input', { style: { ...CSS.input, width: 70 }, type: 'number', value: autoCfg.minTurns,
                  onChange: (e) => setAutoCfg({ ...autoCfg, minTurns: Number(e.target.value) }) })),
              h('span', null, '类型：'),
              ...[['main', '主会话'], ['sub', '子代理'], ['fork', '副本'], ['exec', '脚本']].map(([k, label]) =>
                h('label', { key: k, style: { display: 'flex', alignItems: 'center', gap: 3 } },
                  h('input', { type: 'checkbox', checked: (autoCfg.kinds || []).includes(k),
                    onChange: (e) => {
                      const set = new Set(autoCfg.kinds || [])
                      e.target.checked ? set.add(k) : set.delete(k)
                      setAutoCfg({ ...autoCfg, kinds: [...set] })
                    } }),
                  label)),
            ),
            h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', null, '目标：'),
              h('select', { style: { ...CSS.input, width: 150 }, value: autoCfg.targetMode,
                onChange: (e) => setAutoCfg({ ...autoCfg, targetMode: e.target.value }) },
                [h('option', { key: 'same', value: 'same' }, '各会话自己的目录'),
                 h('option', { key: 'fixed', value: 'fixed' }, '固定目录')]),
              autoCfg.targetMode === 'fixed' ? h('input', { style: { ...CSS.input, flex: 1, minWidth: 200 }, placeholder: '固定目标目录（绝对路径）',
                value: autoCfg.fixedTargetCwd || '', onChange: (e) => setAutoCfg({ ...autoCfg, fixedTargetCwd: e.target.value }) }) : null,
              h('label', null, '标题前缀 ',
                h('input', { style: { ...CSS.input, width: 120 }, value: autoCfg.titlePrefix || '',
                  onChange: (e) => setAutoCfg({ ...autoCfg, titlePrefix: e.target.value }) })),
            ),
            h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
              h('label', { style: { flex: 1, minWidth: 220 } }, '只导这些目录（前缀，每行一个，空=全部）',
                h('textarea', { style: { ...CSS.input, height: 54, marginTop: 2 }, value: (autoCfg.includeCwd || []).join('\n'),
                  onChange: (e) => setAutoCfg({ ...autoCfg, includeCwd: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }) })),
              h('label', { style: { flex: 1, minWidth: 220 } }, '排除这些目录（前缀，每行一个）',
                h('textarea', { style: { ...CSS.input, height: 54, marginTop: 2 }, value: (autoCfg.excludeCwd || []).join('\n'),
                  onChange: (e) => setAutoCfg({ ...autoCfg, excludeCwd: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }) })),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { style: { ...CSS.btn, ...CSS.btnPri }, onClick: () => saveAuto({}), disabled: !!autoBusy }, '保存规则'),
              h('span', { style: CSS.hint },
                autoStatus ? `起点 ${autoStatus.baselineAt ? new Date(autoStatus.baselineAt).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '—'}（只导这之后更新的会话）` : ''),
            ),
            autoStatus && autoStatus.lastResult && autoStatus.lastResult.results && autoStatus.lastResult.results.length
              ? h('div', { style: { ...CSS.q, fontSize: 11 } },
                  autoStatus.lastResult.results.map((r, i) => h('div', { key: i },
                    `✓ ${r.agent} · ${(r.title || '').slice(0, 40)} → ${r.sessionId}`)))
              : null,
          ) : null,
        ) : null,

        h('div', { style: CSS.probe },
          probe === null ? '自检中… /api/foreign/agents'
          : probe.status === 'ERR' ? '❌ 请求失败：' + probe.body
          : probe.status !== 200 ? '❌ Host 返回 ' + probe.status + '：' + probe.body
          : '✅ Host 就绪 · ' + probe.body,
        ),
        error ? h('div', { style: CSS.err }, error) : null,

        h('div', { style: CSS.cols },
          // 项目列
          h('div', { style: { ...CSS.col, width: 300, flex: '0 0 300px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, position: 'sticky', top: -10,
                               padding: '6px 0 4px', zIndex: 3, background: 'var(--dsw-alias-bg-base, #0f1115)' } },
              h('span', { style: { ...CSS.hint, fontWeight: 600 } }, `项目 ${filtered.length}`),
              h('span', { style: { flex: 1 } }),
              h('span', {
                style: { ...CSS.hint, cursor: 'pointer', textDecoration: 'underline' },
                onClick: () => { setCollapsedProjects(new Set()); lsSet('dsh.foreign.collapsed', '[]') },
              }, '全展开'),
              h('span', {
                style: { ...CSS.hint, cursor: 'pointer', textDecoration: 'underline' },
                onClick: () => { const all = new Set(projects.map((x) => x.cwd)); setCollapsedProjects(all); lsSet('dsh.foreign.collapsed', JSON.stringify([...all])) },
              }, '全折叠'),
            ),
            !busy && !filtered.length ? h('div', { style: { ...CSS.dim, padding: 8 } },
              sessions.length ? '当前筛选下没有会话（换个类型/时间试试）' : '还没有拿到会话列表（看上面那行自检结果）') : null,
            filtered.map((p) => {
              const kidsOf = (id) => (childrenOf.get(id) || []).filter((k) => !days || (k.updatedAt ?? 0) >= sinceMs)
              const tops = p.list.filter((r) => !r.parentId || !p.list.some((x) => x.id === r.parentId))
              const collapsed = collapsedProjects.has(p.cwd)
              const newCount = p.list.filter((x) => !seen.has(x.id)).length
              const agentsIn = [...new Set(p.list.map((x) => x.agent))]
              return h('div', { key: p.cwd },
                h('div', {
                  style: { ...CSS.projHead, position: 'sticky', top: 26, zIndex: 2, background: 'var(--dsw-alias-bg-base, #0f1115)' },
                  title: p.cwd,
                  onClick: () => toggleProject(p.cwd),
                },
                  h('span', { style: { ...CSS.hint, width: 12, display: 'inline-block' } }, collapsed ? '▸' : '▾'),
                  h('span', { style: { fontWeight: 700, fontSize: 12, maxWidth: 128, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    baseName(p.cwd)),
                  h('span', { style: { ...CSS.hint, marginLeft: 6 } }, `${p.list.length}`),
                  h('span', {
                    style: { ...CSS.hint, marginLeft: 6, cursor: 'pointer', padding: '0 3px',
                             border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))', borderRadius: 4 },
                    title: '把这个项目下的会话批量导入到该项目',
                    onClick: (e) => { e.stopPropagation(); importProject(p.cwd, p.list.length) },
                  }, '⤓ 导入'),
                  projJob && projJob.cwd === p.cwd
                    ? h('span', { style: { ...CSS.hint, marginLeft: 6, color: 'var(--dsw-alias-state-business-primary, #4c8dff)' } },
                        projJob.state === 'running'
                          ? (projJob.total ? `${projJob.done || 0}/${projJob.total}` : '扫描中…')
                          : `✓ 导入 ${projJob.imported} · 跳过 ${projJob.skipped}${projJob.failed ? ' · 失败 ' + projJob.failed : ''}`)
                    : null,
                  newCount ? h('span', { style: { ...CSS.badge, marginLeft: 4 } }, `${newCount} 新`) : null,
                  agentsIn.length > 1
                    ? h('span', { style: { ...CSS.hint, marginLeft: 6, letterSpacing: 1 } },
                        agentsIn.map((a) => a === 'kimi-code' ? 'K' : a === 'claude-code' ? 'C' : 'X').join('·'))
                    : null,
                  h('span', { style: { ...CSS.hint, marginLeft: 'auto', fontSize: 10, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    parentTail(p.cwd)),
                ),
                collapsed ? null : tops.map((r) => {
                  const kids = kidsOf(r.id)
                  const open = expanded.has(r.id)
                  return h('div', { key: r.id },
                    h('div', {
                      style: { ...CSS.row, ...(sel?.id === r.id ? CSS.rowOn : {}) },
                      onClick: () => pick(r),
                      onMouseEnter: (e) => { if (sel?.id !== r.id) e.currentTarget.style.background = CSS.rowHover.background },
                      onMouseLeave: (e) => { if (sel?.id !== r.id) e.currentTarget.style.background = 'transparent' },
                    },
                      h('div', { style: CSS.title },
                        !seen.has(r.id) ? h('span', { style: CSS.badge }, 'NEW') : null,
                        kids.length
                          ? h('span', {
                              style: { ...CSS.badge, cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
                                       border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))' },
                              onClick: (e) => {
                                e.stopPropagation()
                                setExpanded((prev) => { const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })
                              },
                            }, (open ? '▾ ' : '▸ ') + kids.length + ' 子')
                          : null,
                        r.title),
                      h('div', { style: CSS.meta },
                        (r.kind === 'sub' ? h('span', { style: { ...CSS.badge, background: 'var(--dsw-alias-state-warn-label, #c98a2b)' } }, '子')
                         : r.kind === 'fork' ? h('span', { style: { ...CSS.badge, background: 'var(--dsw-alias-label-tertiary, #8b93a1)' } }, '副本')
                         : r.origin === 'exec' ? h('span', { style: { ...CSS.badge, background: 'var(--dsw-alias-label-tertiary, #8b93a1)' } }, 'exec')
                         : null),
                        `${r.agent === 'kimi-code' ? 'Kimi' : r.agent === 'claude-code' ? 'Claude' : 'Codex'} · ${fmtTime(r.updatedAt)} · ${fmtSize(r.size)}`),
                    ),
                    open ? kids.map((k) => h('div', {
                      key: k.id,
                      style: { ...CSS.row, marginLeft: 18, borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
                               ...(sel?.id === k.id ? CSS.rowOn : {}) },
                      onClick: () => pick(k),
                    },
                      h('div', { style: { ...CSS.title, fontWeight: 500 } }, k.title),
                      h('div', { style: CSS.meta }, '子代理 · ' + fmtTime(k.updatedAt)),
                    )) : null,
                  )
                }),
              )
            }),
          ),

          // 预览 + 导入
          h('div', { style: { ...CSS.col, flex: 1, minWidth: 0 } },
            !sel ? h('div', { style: CSS.dim }, '← 选一条会话看预览') : h('div', null,
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, sel.title),
              h('div', { style: { ...CSS.meta, marginBottom: 4, wordBreak: 'break-all' } }, sel.cwd),
              clientRow && clientRow.cwd === undefined
                ? h('div', { style: { ...CSS.hint, marginBottom: 10, color: 'var(--dsw-alias-state-warn-label, #c98a2b)' } },
                    '⚠ 客户端会话列表里这条会话缺 cwd（内置「Workspace files」会打不开）。刷新页面后即可恢复；若仍缺，说明会话未刷新进列表。')
                : null,

              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
                h('span', { style: CSS.dim }, '目标目录'),
                h('input', { style: CSS.input, value: target, onChange: (e) => setTarget(e.target.value) }),
              ),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
                h('span', { style: CSS.dim }, '范围'),
                h('select', { style: { ...CSS.input, width: 160 }, value: lastN, onChange: (e) => setLastN(Number(e.target.value)) },
                  h('option', { value: 50 }, '最近 50 轮'),
                  h('option', { value: 100 }, '最近 100 轮'),
                  h('option', { value: 0 }, '全量'),
                ),
                h('span', { style: CSS.dim },
                  preview ? `全量约 ${fmtNum(preview.estimate.chars)} 字 ≈ ${fmtNum(preview.estimate.tokens)} tokens` : ''),
                h('button', { style: { ...CSS.btn, ...CSS.btnPri, marginLeft: 'auto' }, onClick: () => doImport(false), disabled: !target || !!busy },
                  importedMap[sel.agent + ':' + sel.id] ? '已导入 · 再导一份' : '导入到 DSH'),
              ),

              result ? h('div', { style: { ...CSS.q, borderLeft: '3px solid var(--dsw-alias-state-' + (result.duplicate ? 'warn-label, #c98a2b' : 'success-primary, #2fb344') + ')' } },
                result.duplicate
                  ? `这条会话已经导入过（${importedMap[sel.agent + ':' + sel.id] || result.sessionId}）。要再导一份副本吗？`
                  : `已导入 ${result.turns} 轮 / ${result.events} 个事件 · 会话 ${result.sessionId}`,
                result.duplicate
                  ? h('button', { style: { ...CSS.btn, marginTop: 6 }, onClick: () => doImport(true) }, '仍然再导一份')
                  : h('div', { style: CSS.dim }, result.cwd),
              ) : null,

              preview ? preview.turns.map((t) => h('div', { key: t.n },
                h('div', { style: CSS.q }, h('strong', null, `问 ${t.n}：`), t.user.slice(0, 600) + (t.user.length > 600 ? '…' : '')),
                h('div', { style: CSS.a }, t.answer ? (t.answer.slice(0, 900) + (t.answer.length > 900 ? '…' : '')) : h('i', { style: CSS.dim }, '（本轮无文字回答）')),
              )) : null,
            ),
          ),
        ),
      )
    }

    function Icon() {
      return h('span', { style: { fontSize: 14 }, title: '外部会话导入' }, '⤓')
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'foreign-sessions' },
          Panel,
        ))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'foreign-sessions', order: 120, label: () => '外部会话' },
          Icon,
        ))
      },
    }
  },
})
