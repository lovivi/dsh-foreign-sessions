/**
 * dsh-foreign-sessions —— Host 半端
 *
 * 职责：
 *   1. 发现本机其他 Agent 的会话（首期：Kimi Code），按「项目(cwd) → 会话」组织
 *   2. 提供只读 HTTP 接口给客户端面板
 *   3. 导入：用 DSH 官方会话服务 `ctx.sessions.create()` + `append()` 写入，不手写日志文件
 *
 * 只读外部数据；写只发生在 DSH 自己的会话库。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'foreign-sessions'
export const inject = ['webServer', 'sessions', 'sessionPersistence']

/** 可选服务：由 apply() 在可用时填充（importSession 是顶层函数，只能走模块级） */
let wsRegistry = null

const API_PREFIX = '/api/foreign'
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')

const log = (...a) => console.log('[dsh-foreign-sessions]', ...a)

// ---------------------------------------------------------------- 适配器：Kimi Code

async function kimiSessionDirs() {
  const out = []
  let workspaces = []
  try {
    workspaces = await readdir(join(KIMI_HOME, 'sessions'), { withFileTypes: true })
  } catch {
    return out
  }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue
    const wdir = join(KIMI_HOME, 'sessions', w.name)
    let sessions = []
    try {
      sessions = await readdir(wdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory() || !s.name.startsWith('session_')) continue
      out.push({ workspace: w.name, dir: join(wdir, s.name), id: s.name })
    }
  }
  return out
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 逐行读 wire.jsonl，抽取「提问 + 最终回答」 */
async function readTurns(wirePath, maxTurns = 0) {
  const exists = await stat(wirePath).then(() => true, () => false)
  if (!exists) return []
  const turns = new Map()
  const order = []

  const rl = createInterface({ input: createReadStream(wirePath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line || (!line.includes('"turn.prompt"') && !line.includes('"context.append_loop_event"'))) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const t = r.type
    if (t === 'turn.prompt') {
      const id = String(r.turnId ?? order.length)
      if (!turns.has(id)) {
        turns.set(id, { id, time: r.time, user: '', steps: [], tools: 0 })
        order.push(id)
      }
      turns.get(id).user += textOf(r.input)
    } else if (t === 'context.append_loop_event') {
      const e = r.event || {}
      const id = String(e.turnId ?? '')
      const turn = turns.get(id)
      if (!turn) continue
      if (e.type === 'step.begin') turn.steps.push([])
      else if (e.type === 'content.part') {
        const p = e.part || {}
        if (p.type === 'text' && p.text && p.text.trim() && turn.steps.length) turn.steps.at(-1).push(p.text.trim())
      } else if (e.type === 'tool.call') turn.tools++
    }
  }

  let list = order.map((id) => {
    const t = turns.get(id)
    let answer = ''
    for (let i = t.steps.length - 1; i >= 0; i--) {
      if (t.steps[i].length) {
        answer = t.steps[i].join('\n\n')
        break
      }
    }
    return { time: t.time, user: t.user.trim(), answer, tools: t.tools }
  })
  if (maxTurns > 0) list = list.slice(-maxTurns)
  return list.map((t, i) => ({ ...t, n: i + 1 }))
}

function textOf(input) {
  if (typeof input === 'string') return input
  const parts = []
  for (const c of input || []) {
    if (c && c.type === 'text' && c.text) parts.push(c.text)
  }
  return parts.join('\n')
}

const kimiAdapter = {
  id: 'kimi-code',
  label: 'Kimi Code',
  async detect() {
    return stat(join(KIMI_HOME, 'sessions')).then(() => true, () => false)
  },
  async list() {
    const rows = []
    for (const s of await kimiSessionDirs()) {
      const st = await readJson(join(s.dir, 'state.json'))
      if (!st) continue
      const wire = join(s.dir, 'agents', 'main', 'wire.jsonl')
      const size = await stat(wire).then((x) => x.size, () => 0)
      rows.push({
        agent: 'kimi-code',
        id: s.id,
        title: st.title || '(无标题)',
        cwd: st.cwd || '',
        // 子代理在 Kimi 里是父会话内部的 agent-*，不单独成会话；
        // forkedFrom 的是"副本"，同样不该混进主列表
        kind: st.forkedFrom ? 'fork' : (!st.cwd ? 'unknown' : 'main'),
        parentId: st.forkedFrom || null,
        origin: 'user',
        createdAt: st.createdAt ?? null,
        updatedAt: st.updatedAt ?? null,
        agents: Object.keys(st.agents || {}).length,
        size,
      })
    }
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return rows
  },
  async turns(sessionId, maxTurns) {
    const dir = (await kimiSessionDirs()).find((s) => s.id === sessionId)?.dir
    if (!dir) throw new Error(`session not found: ${sessionId}`)
    return readTurns(join(dir, 'agents', 'main', 'wire.jsonl'), maxTurns)
  },
}

// ---------------------------------------------------------------- 适配器：Claude Code
//
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// 每行一个事件：type=user|assistant|ai-title|last-prompt|mode|permission-mode|system
// 主对话：isSidechain=false；user 的 tool_result 块与 assistant 的 thinking/tool_use 不算正文。

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), '.claude')

function claudeText(content) {
  if (typeof content === 'string') return content
  const out = []
  for (const c of content || []) {
    if (c && c.type === 'text' && c.text) out.push(c.text)
  }
  return out.join('\n')
}

const claudeAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  async detect() {
    return stat(join(CLAUDE_HOME, 'projects')).then(() => true, () => false)
  },
  async list() {
    const root = join(CLAUDE_HOME, 'projects')
    const rows = []
    let projects = []
    try { projects = await readdir(root, { withFileTypes: true }) } catch { return rows }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = join(root, p.name)
      let files = []
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const f of files) {
        const full = join(dir, f)
        const st = await stat(full).catch(() => null)
        if (!st) continue
        const { title, cwd } = await claudeHead(full)
        rows.push({
          agent: 'claude-code',
          id: f.replace(/\.jsonl$/, ''),
          title: title || '(无标题)',
          cwd: cwd || decodeClaudeDir(p.name),
          kind: 'main',
          parentId: null,
          origin: 'user',
          createdAt: st.birthtimeMs || null,
          updatedAt: st.mtimeMs,
          agents: 0,
          size: st.size,
        })
      }
    }
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return rows
  },
  async turns(sessionId, maxTurns) {
    const file = await claudeFindFile(sessionId)
    if (!file) throw new Error(`session not found: ${sessionId}`)
    return claudeTurns(file, maxTurns)
  },
}

function decodeClaudeDir(name) {
  // "-home-song-work-x" -> "/home/song/work/x"（仅用于没有 cwd 字段时的兜底）
  const t = name.replace(/^-/, '/').replace(/-/g, '/')
  return t.startsWith('/') ? t : '/' + t
}

async function claudeFindFile(sessionId) {
  const root = join(CLAUDE_HOME, 'projects')
  let projects = []
  try { projects = await readdir(root, { withFileTypes: true }) } catch { return null }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const full = join(root, p.name, `${sessionId}.jsonl`)
    if (await stat(full).then(() => true, () => false)) return full
  }
  return null
}

/** 扫文件头部找标题/ cwd（避免为了列表把几 MB 的会话全读完） */
async function claudeHead(file) {
  let title = ''
  let cwd = ''
  let n = 0
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (++n > 200) break
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (!cwd && r.cwd) cwd = r.cwd
      if (!title && r.type === 'ai-title') title = r.aiTitle || r.message?.aiTitle || ''
      if (!title && r.type === 'user' && !r.isSidechain && !r.isMeta) {
        const t = claudeText(r.message?.content).trim()
        if (t && !t.startsWith('<')) title = t.slice(0, 60)
      }
      if (title && cwd) break
    }
  } finally {
    rl.close()
  }
  return { title, cwd }
}

async function claudeTurns(file, maxTurns) {
  const turns = []
  let cur = null
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (r.isSidechain) continue
      const type = r.type
      if (type === 'user') {
        if (r.isMeta) continue
        const text = claudeText(r.message?.content).trim()
        if (!text || text.startsWith('<')) continue // tool_result / 系统注入
        if (cur) turns.push(cur)
        cur = { time: r.timestamp ? Date.parse(r.timestamp) : null, user: text, answers: [], tools: 0 }
      } else if (type === 'assistant' && cur) {
        const content = r.message?.content
        const isArr = Array.isArray(content)
        const text = isArr ? claudeText(content) : claudeText([{ type: 'text', text: content }])
        if (isArr && content.some((c) => c && c.type === 'tool_use')) cur.tools += content.filter((c) => c && c.type === 'tool_use').length
        if (text.trim()) cur.answers.push(text.trim())
      }
    }
    if (cur) turns.push(cur)
  } finally {
    rl.close()
  }
  let list = turns.map((t) => ({ time: t.time, user: t.user, answer: t.answers.at(-1) || '', tools: t.tools }))
  if (maxTurns > 0) list = list.slice(-maxTurns)
  return list.map((t, i) => ({ ...t, n: i + 1 }))
}

// ---------------------------------------------------------------- 适配器：Codex CLI
//
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（另有 ~/.codex/archived_sessions）
// session_meta.payload 给 cwd/session_id；event_msg 给 user_message / agent_message（问答最干净）。

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')

async function codexFiles() {
  const out = []
  for (const root of [join(CODEX_HOME, 'sessions'), join(CODEX_HOME, 'archived_sessions')]) {
    const walk = async (dir) => {
      let ents = []
      try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.jsonl')) out.push(full)
      }
    }
    await walk(root)
  }
  return out
}

/** 读一个 rollout 文件的头部：session_meta 给 id/cwd/父线程/来源；首条 user_message 给标题。 */
async function codexHead(file) {
  let id = ''
  let cwd = ''
  let title = ''
  let kind = 'main'
  let parentId = null
  let origin = 'cli'
  let n = 0
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (++n > 120 || (title && cwd && id)) break
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      const p = r.payload || {}
      if (r.type === 'session_meta' && !id) {
        id = p.id || p.session_id || ''
        cwd = p.cwd || ''
        const src = p.source
        const isSub = p.thread_source === 'subagent' || (src && typeof src === 'object' && 'subagent' in src) || !!p.parent_thread_id
        kind = isSub ? 'sub' : 'main'
        parentId = p.parent_thread_id || null
        origin = (src && typeof src === 'object') ? 'subagent' : (typeof src === 'string' ? src : 'cli')
      } else if (r.type === 'event_msg' && p.type === 'user_message' && !title) {
        const t = String(p.message || '').trim()
        if (t && !t.startsWith('<')) title = t.slice(0, 60)
      }
    }
  } finally { rl.close() }
  return { id, cwd, title, kind, parentId, origin }
}

/** 解析一个 rollout 文件的问答轮次。 */
async function codexTurns(file, maxTurns) {
  const turns = []
  let cur = null
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      const p = r.payload || {}
      if (r.type === 'event_msg') {
        if (p.type === 'user_message') {
          const t = String(p.message || '').trim()
          if (!t || t.startsWith('<')) continue
          if (cur) turns.push(cur)
          cur = { time: r.timestamp ? Date.parse(r.timestamp) : null, user: t, answers: [], tools: 0 }
        } else if (p.type === 'agent_message' && cur) {
          const t = String(p.message || '').trim()
          if (t) cur.answers.push(t)
        }
      } else if (r.type === 'response_item' && cur) {
        // 老版本 codex 的助手正文可能只在 response_item 里
        if (p.type === 'function_call') cur.tools++
        else if (p.type === 'message' && p.role === 'assistant') {
          const texts = (p.content || []).filter((c) => c && (c.type === 'output_text' || c.type === 'text')).map((c) => c.text || '')
          const t = texts.join('\n').trim()
          if (t) cur.answers.push(t)
        }
      }
    }
    if (cur) turns.push(cur)
  } finally { rl.close() }
  let list = turns.map((t) => ({ time: t.time, user: t.user, answer: t.answers.at(-1) || '', tools: t.tools }))
  if (maxTurns > 0) list = list.slice(-maxTurns)
  return list.map((t, i) => ({ ...t, n: i + 1 }))
}

let codexIndexCache = null

/** 一次扫描全部 rollout，按 session id 合并分段（codex 恢复会话会新开文件但沿用同一 id）。 */
async function buildCodexIndex() {
  const byId = new Map()
  for (const file of await codexFiles()) {
    const st = await stat(file).catch(() => null)
    if (!st) continue
    const meta = await codexHead(file)
    if (!meta.id) continue
    const cur = byId.get(meta.id)
    if (!cur) {
      byId.set(meta.id, {
        id: meta.id, cwd: meta.cwd, kind: meta.kind, parentId: meta.parentId, origin: meta.origin,
        files: [{ file, mtime: st.mtimeMs }],
        createdAt: st.birthtimeMs || st.mtimeMs, updatedAt: st.mtimeMs, size: st.size,
        title: meta.title,
      })
    } else {
      cur.files.push({ file, mtime: st.mtimeMs })
      cur.size += st.size
      cur.updatedAt = Math.max(cur.updatedAt, st.mtimeMs)
      cur.createdAt = Math.min(cur.createdAt, st.birthtimeMs || st.mtimeMs)
      if (!cur.cwd && meta.cwd) cur.cwd = meta.cwd
      if (meta.kind === 'sub') cur.kind = 'sub'
      if (meta.origin && cur.origin !== 'subagent') cur.origin = meta.origin
    }
  }
  for (const rec of byId.values()) {
    rec.files.sort((a, b) => a.mtime - b.mtime)
  }
  return [...byId.values()]
}

const codexAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  async detect() {
    return stat(join(CODEX_HOME, 'sessions')).then(() => true, () => false)
  },
  async list() {
    const index = await buildCodexIndex()
    codexIndexCache = index
    const rows = index.map((r) => ({
      agent: 'codex',
      id: r.id,
      title: r.title || '(无标题)',
      cwd: r.cwd || '',
      kind: r.kind,
      parentId: r.parentId,
      origin: r.origin,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      agents: 0,
      size: r.size,
    }))
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return rows
  },
  async turns(sessionId, maxTurns) {
    const index = codexIndexCache || (await buildCodexIndex())
    const rec = index.find((r) => r.id === sessionId)
    if (!rec) throw new Error(`session not found: ${sessionId}`)
    let all = []
    for (const seg of rec.files) {
      all = all.concat(await codexTurns(seg.file, 0))
    }
    // 分段之间可能有重叠（恢复时重放），按 user+time 去重
    const seen = new Set()
    all = all.filter((t) => {
      const k = `${t.time}|${t.user.slice(0, 80)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    all.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    if (maxTurns > 0) all = all.slice(-maxTurns)
    return all.map((t, i) => ({ ...t, n: i + 1 }))
  },
}

export const adapters = { 'kimi-code': kimiAdapter, 'claude-code': claudeAdapter, codex: codexAdapter }

// ---------------------------------------------------------------- 全文搜索（标题之外，搜对话内容）
//
// 索引懒加载：第一次搜索时把各会话解析成 turns 缓存（按 mtime/size 失效），
// 之后同一进程内搜索是纯内存扫描；有超时预算，超时返回已扫描到的部分。

const searchCache = new Map()
const SEARCH_CACHE_FILE = join(homedir(), '.dsh', 'foreign-sessions', 'search-cache.json')
let warmPromise = null
let saveTimer = null

async function loadSearchCacheFromDisk() {
  const d = await readJsonFile(SEARCH_CACHE_FILE, null).catch(() => null)
  if (!d?.docs || !Array.isArray(d.docs)) return 0
  for (const doc of d.docs) {
    if (doc?.key && Array.isArray(doc.turns)) searchCache.set(doc.key, doc)
  }
  return searchCache.size
}

function scheduleSaveSearchCache() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await writeJsonFile(SEARCH_CACHE_FILE, { savedAt: Date.now(), docs: [...searchCache.values()] })
    } catch (e) {
      log('search-cache 写入失败:', e?.message)
    }
  }, 4000)
  saveTimer.unref?.()
}

function searchKey(row) {
  return `${row.agent}:${row.id}`
}

async function loadSearchDoc(row) {
  const key = searchKey(row)
  const hit = searchCache.get(key)
  if (hit && hit.mtime === row.updatedAt && hit.size === row.size) return hit
  const adapter = adapters[row.agent]
  if (!adapter) return null
  const turns = await adapter.turns(row.id, 0)
  const doc = {
    key,
    agent: row.agent,
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    kind: row.kind,
    origin: row.origin,
    parentId: row.parentId || null,
    updatedAt: row.updatedAt,
    size: row.size,
    mtime: row.updatedAt,
    hash: row.size,
    turns,
  }
  searchCache.set(key, doc)
  return doc
}

export async function warmSearchIndex(limitAgents = ['kimi-code', 'claude-code', 'codex']) {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    for (const id of limitAgents) {
      const a = adapters[id]
      if (!a) continue
      if (!(await a.detect().catch(() => false))) continue
      let rows = []
      try { rows = await a.list() } catch { continue }
      const queue = rows.filter((r) => r.kind !== 'sub')
      let i = 0
      const worker = async () => {
        while (i < queue.length) {
          const row = queue[i++]
          await loadSearchDoc(row).catch(() => {})
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker))
    }
  })().finally(() => {
    warmPromise = null
    scheduleSaveSearchCache()
  })
  return warmPromise
}

/** 从文本里挖一段命中上下文（压掉换行）。 */
function snippetOf(text, needle, radius = 46) {
  const i = text.toLowerCase().indexOf(needle)
  if (i < 0) return ''
  const from = Math.max(0, i - radius)
  const to = Math.min(text.length, i + needle.length + radius)
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '')
}

export async function searchSessions({ q, agent = 'all', limit = 40, maxMs = 6000 }) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return { results: [], scanned: 0, total: 0, truncated: false, cached: searchCache.size }
  const started = Date.now()
  const agentIds = agent === 'all' ? Object.keys(adapters) : [agent]
  let rows = []
  for (const id of agentIds) {
    const a = adapters[id]
    if (!a) continue
    if (!(await a.detect().catch(() => false))) continue
    try { rows.push(...(await a.list())) } catch (e) { log('search list 失败', id, e?.message) }
  }
  rows.sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0))

  const results = []
  let scanned = 0
  let truncated = false

  for (const row of rows) {
    if (results.length >= limit) { truncated = true; break }
    if (Date.now() - started > maxMs) { truncated = true; break }
    let doc
    try { doc = await loadSearchDoc(row) } catch { continue }
    scanned++
    if (!doc) continue
    const hits = []
    for (const t of doc.turns) {
      const inUser = t.user && t.user.toLowerCase().includes(needle)
      const inAnswer = t.answer && t.answer.toLowerCase().includes(needle)
      if (!inUser && !inAnswer) continue
      hits.push({
        n: t.n,
        which: inUser ? 'user' : 'answer',
        snippet: snippetOf(inUser ? t.user : t.answer, needle),
      })
      if (hits.length >= 3) break
    }
    if (!hits.length) continue
    results.push({
      agent: doc.agent,
      id: doc.id,
      title: doc.title,
      cwd: doc.cwd,
      kind: doc.kind,
      origin: doc.origin,
      parentId: doc.parentId,
      updatedAt: doc.updatedAt,
      size: doc.size,
      hits,
    })
  }
  return { results, scanned, total: rows.length, truncated, cached: searchCache.size }
}


// ---------------------------------------------------------------- 导入

function estimateTokens(turns) {
  let chars = 0
  for (const t of turns) chars += (t.user?.length ?? 0) + (t.answer?.length ?? 0)
  return { chars, tokens: Math.round(chars / 1.6) }
}

/**
 * 把外部会话写成一个 DSH 会话。
 * @param ctx DSH host context（需要 sessions；可选 workspaceRegistry）
 */
export function normalizeCwd(input) {
  let cwd = String(input || '').trim()
  if (!cwd) throw new Error('目标目录不能为空')
  if (!cwd.startsWith('/')) throw new Error(`目标目录必须是绝对路径：${cwd}`)
  cwd = cwd.replace(/\/+$/, '') || '/'
  return cwd
}

export async function importSession(ctx, { agent, id, targetCwd, lastN = 0, title, force = false }) {
  const adapter = adapters[agent]
  if (!adapter) throw new Error(`unknown adapter: ${agent}`)
  const cwd = normalizeCwd(targetCwd)
  const normalizedTitle = String(title || '').trim()

  if (!force) {
    const prev = await findExistingImport(agent, id).catch(() => null)
    if (prev) {
      return { duplicate: true, sessionId: prev.sessionId, agent, cwd, turns: prev.turns ?? null, events: null }
    }
  }

  const all = await adapter.turns(id, lastN || 0)
  if (!all.length) throw new Error('该会话没有可导入的问答')

  const meta = ctx.sessions && typeof ctx.sessions === 'object' ? ctx.sessions : null
  if (!meta) throw new Error('宿主没有 sessions 服务')

  // 目标目录不存在就建出来（否则 workspace 登记会失败，会话会落进"未分组"）
  let workspace = null
  try {
    await mkdir(cwd, { recursive: true })
    workspace = await wsRegistry?.create(cwd, cwd.split('/').pop() || cwd)
  } catch (e) {
    log('workspace.create 跳过:', e?.message)
  }

  const sessionId = `import-${agent}-${randomUUID()}`
  const createdAt = all[0]?.time || Date.now()

  // 关键：先向持久化后端 create 一个写句柄（agent-loop 也是先拿句柄再发布会话）。
  // 没有活跃写句柄的会话不会被落盘（session-persistence 的实时写路径只路由到已有句柄）。
  let handle = null
  if (ctx.sessionPersistence?.create) {
    try {
      handle = await ctx.sessionPersistence.create({
        version: 4,
        id: sessionId,
        createdAt,
        cwd,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
      })
    } catch (e) {
      log('persistence.create 失败，退回内存会话:', e?.message)
    }
  }

  const session = ctx.sessions.create(sessionId, { meta: { cwd } })
  const est = estimateTokens(all)
  let events = 0
  let firstUserSeq = null

  const head = (await loadSystemHead().catch(() => null)) || {
    message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] },
  }
  let headWritten = false

  for (const t of all) {
    const n = t.n
    session.append('turn/start', { turn: n }); events++
    session.append('step/start', { turn: n, step: 1 }); events++
    if (!headWritten && head?.message) {
      // 受保护 surface 头：必须是日志里第一个 surface 事件
      session.append('system/message', { turn: n, step: 1, message: head.message }, { surfaceOp: 'append' }); events++
      headWritten = true
    }
    const ue = session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: t.user }],
      source: { kind: 'user' },
      id: `import-${n}-u`,
    }, { surfaceOp: 'append' }); events++
    if (firstUserSeq === null) firstUserSeq = ue?.seq ?? null
    session.append('step/end', { turn: n, step: 1 }); events++
    if (t.answer) {
      session.append('step/start', { turn: n, step: 2 }); events++
      session.append('assistant/message', {
        turn: n,
        step: 2,
        message: {
          role: 'assistant',
          id: `import-${n}-a`,
          content: [{ type: 'text', text: t.answer }],
          source: { kind: 'model', provider: 'imported', model: agent },
        },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
        stream: [],
      }, { surfaceOp: 'append' }); events++
      session.append('step/end', { turn: n, step: 2 }); events++
    }
    session.append('turn/end', { turn: n, reason: { kind: 'completed' } }); events++
  }

  // 标题：写入一条 session/title，避免被"首条提示词"自动命名覆盖
  if (title && firstUserSeq !== null) {
    try {
      session.append('session/title', {
        title: (normalizedTitle || title || '').slice(0, 80),
        messageSeqs: [firstUserSeq],
        source: { kind: 'fallback' },
      })
    } catch (e) {
      log('session/title 追加失败（忽略）:', e?.message)
    }
  }

  try {
    if (handle) {
      await handle.flush?.()
      await handle.close?.()
    } else {
      await ctx.sessions.flush?.(session)
    }
  } catch (e) {
    log('flush 失败:', e?.message)
  }
  // 导入完成后把「已发布但无 agent」的会话从 sessions store 摘掉：
  // 否则客户端打开这条会话时 resume 会撞上 "session already exists"，发送消息直接失败。
  try {
    const entry = ctx.sessions.liveEntryFor?.(session)
    if (entry && ctx.sessions.detachEntered) {
      ctx.sessions.detachEntered(entry)
      log('session 已从 store 摘除（等待首次打开时再 resume）:', sessionId)
    }
  } catch (e) {
    log('detach 跳过:', e?.message)
  }

  if (workspace?.attachSession) {
    try { await workspace.attachSession(sessionId) } catch (e) { log('attachSession 跳过:', e?.message) }
  }
  await rememberImport(agent, id, { sessionId, at: Date.now(), turns: all.length, cwd }).catch(() => {})

  return {
    sessionId,
    agent,
    turns: all.length,
    events,
    chars: est.chars,
    tokens: est.tokens,
    workspace: workspace ? { id: workspace.id, title: workspace.title } : null,
    cwd: cwd,
  }
}

// ---------------------------------------------------------------- 项目级批量导入

const projectJobs = new Map()
let jobSeq = 0

function newJob(total) {
  const id = `pj-${++jobSeq}-${Date.now().toString(36)}`
  const job = { id, state: 'running', total, done: 0, imported: 0, skipped: 0, failed: 0, results: [], errors: [], startedAt: Date.now(), finishedAt: null }
  projectJobs.set(id, job)
  return job
}

/**
 * 把一个项目（同一 cwd）下的多条会话批量导入到该项目目录。
 * 后台跑，立即返回 jobId；前端轮询 /import-project/status。
 */
export function startProjectImport(ctx, { agent = 'all', cwd, lastN = 0, kinds = ['main'], titlePrefix = '' }) {
  const targetCwd = normalizeCwd(cwd)
  const kindSet = new Set(kinds?.length ? kinds : ['main'])

  const pick = (row) => {
    if (row.kind === 'sub' && !kindSet.has('sub')) return false
    if (row.kind === 'fork' && !kindSet.has('fork')) return false
    if (row.origin === 'exec' && !kindSet.has('exec')) return false
    if (!kindSet.has('main') && row.kind === 'main' && row.origin !== 'exec') return false
    return true
  }

  const job = newJob(0)

  ;(async () => {
    try {
      const agents = agent === 'all' ? Object.keys(adapters) : [agent]
      let rows = []
      for (const a of agents) {
        const ad = adapters[a]
        if (!ad) continue
        if (!(await ad.detect().catch(() => false))) continue
        let list = []
        try { list = await ad.list() } catch (e) { job.errors.push(`${a}: ${e?.message}`); continue }
        for (const r of list) {
          if (normalizeCwdSafe(r.cwd) !== targetCwd) continue
          if (!pick(r)) continue
          rows.push(r)
        }
      }
      rows.sort((x, y) => (x.updatedAt ?? 0) - (y.updatedAt ?? 0))
      job.total = rows.length

      for (const row of rows) {
        if (ctx.__foreignAbort) break
        try {
          const prev = await findExistingImport(row.agent, row.id).catch(() => null)
          if (prev) { job.skipped++; job.done++; continue }
          const title = (titlePrefix || '') + (row.title || row.id)
          const r = await importSession(ctx, { agent: row.agent, id: row.id, targetCwd, lastN, title })
          job.imported++
          job.results.push({ agent: row.agent, id: row.id, title, sessionId: r.sessionId, turns: r.turns })
        } catch (e) {
          job.failed++
          job.errors.push(`${row.agent}:${row.id}: ${e?.message}`)
        } finally {
          job.done++
        }
      }
      job.state = 'done'
    } catch (e) {
      job.state = 'error'
      job.errors.push(String(e?.message || e))
    } finally {
      job.finishedAt = Date.now()
    }
  })()

  return job
}

function normalizeCwdSafe(p) {
  try { return normalizeCwd(p) } catch { return '' }
}

// ---------------------------------------------------------------- 自动导入

const AUTO_DIR = join(homedir(), '.dsh', 'foreign-sessions')
const MANUAL_FILE = join(AUTO_DIR, 'imported-manual.json')
const SYSTEM_HEAD_FILE = join(AUTO_DIR, 'system-head.json')

let systemHeadCache = null

/** 从一份已落盘的会话里取第一条 system/message 的 message（作为导入会话的受保护 surface 头）。 */
function readSystemMessageFrom(file) {
  try {
    const raw = readFileSync(file)
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const parts = []
    let pos = 0
    while (true) {
      const i = raw.indexOf(MAGIC, pos)
      if (i < 0) break
      const j = i + 4 < raw.length ? raw.indexOf(MAGIC, i + 4) : -1
      parts.push(zstdDecompressSync(raw.subarray(i, j < 0 ? raw.length : j)).toString('utf8'))
      pos = j < 0 ? raw.length : j
    }
    for (const line of parts.join('').split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.type === 'system/message' && row.data?.message?.role === 'system') return row.data.message
    }
  } catch { /* 读不了就跳过 */ }
  return null
}

/**
 * 导入会话必须带一个「受保护的 system/message surface 头」：
 * 否则之后 agent 恢复时会把它追加在中间，导致 v4 关系校验失败、会话打不开。
 * 模板取自本机任意正常会话（同一 profile 的系统提示词），并缓存下来。
 */
async function loadSystemHead() {
  if (systemHeadCache) return systemHeadCache
  const cached = await readJsonFile(SYSTEM_HEAD_FILE, null).catch(() => null)
  if (cached?.message) { systemHeadCache = cached; return cached }
  const root = join(homedir(), '.dsh', 'sessions')
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const proj = join(root, d.name)
    const entries = await readdir(proj, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue
      const msg = readSystemMessageFrom(join(proj, e.name, 'session.v4.jsonl.zstd'))
      if (msg) {
        systemHeadCache = { message: msg, from: join(proj, e.name) }
        await writeJsonFile(SYSTEM_HEAD_FILE, systemHeadCache).catch(() => {})
        return systemHeadCache
      }
    }
  }
  return null
}

async function findExistingImport(agent, id) {
  const map = await readJsonFile(MANUAL_FILE, {})
  const rec = map[`${agent}:${id}`]
  if (!rec?.sessionId) return null
  const root = join(homedir(), '.dsh', 'sessions')
  let dirs = []
  try { dirs = await readdir(root, { withFileTypes: true }) } catch { return null }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const f = join(root, d.name, rec.sessionId, 'session.v4.jsonl.zstd')
    if (await stat(f).then(() => true, () => false)) return rec
  }
  return null
}

async function rememberImport(agent, id, rec) {
  const map = await readJsonFile(MANUAL_FILE, {})
  map[`${agent}:${id}`] = rec
  await writeJsonFile(MANUAL_FILE, map)
}
const AUTO_FILE = join(AUTO_DIR, 'auto.json')
const IMPORTED_FILE = join(AUTO_DIR, 'imported.json')

let autoRestartHook = null

const AUTO_DEFAULTS = {
  enabled: false,
  intervalSec: 120,
  agents: ['kimi-code', 'claude-code', 'codex'],
  kinds: ['main'],              // main | sub | fork | exec
  includeCwd: [],               // 前缀匹配；空 = 全部
  excludeCwd: [],
  lastN: 50,
  minTurns: 1,
  maxPerRun: 5,
  targetMode: 'same',           // same = 用会话自己的 cwd；fixed = fixedTargetCwd
  fixedTargetCwd: '',
  titlePrefix: '',
  since: null,                  // ISO 时间；null = 用首次启用时刻
}

async function readJsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJsonFile(path, value) {
  await mkdir(AUTO_DIR, { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function loadAutoConfig() {
  const saved = await readJsonFile(AUTO_FILE, {})
  return { ...AUTO_DEFAULTS, ...(saved.config || {}) }
}

async function saveAutoConfig(patch) {
  const cur = await loadAutoConfig()
  const next = { ...cur, ...patch }
  await writeJsonFile(AUTO_FILE, { config: next })
  return next
}

function cwdAllowed(cwd, cfg) {
  if (!cwd) return false
  const inc = cfg.includeCwd?.filter(Boolean) || []
  const exc = cfg.excludeCwd?.filter(Boolean) || []
  if (exc.some((p) => cwd.startsWith(p))) return false
  if (inc.length && !inc.some((p) => cwd.startsWith(p))) return false
  return true
}

function kindAllowed(row, cfg) {
  const kinds = new Set(cfg.kinds?.length ? cfg.kinds : ['main'])
  if (kinds.has('main') && row.kind === 'main' && row.origin !== 'exec') return true
  if (kinds.has('sub') && row.kind === 'sub') return true
  if (kinds.has('fork') && row.kind === 'fork') return true
  if (kinds.has('exec') && row.origin === 'exec') return true
  return false
}

async function runAutoImport(ctx, { manual = false } = {}) {
  const cfg = await loadAutoConfig()
  const store = await readJsonFile(IMPORTED_FILE, { imported: {}, baselineAt: null, lastRunAt: null, lastResult: null })
  if (!store.baselineAt) store.baselineAt = Date.now()
  const sinceMs = cfg.since ? Date.parse(cfg.since) : store.baselineAt
  const imported = store.imported || {}
  const results = []
  let attempted = 0

  for (const agent of cfg.agents || []) {
    const a = adapters[agent]
    if (!a) continue
    if (!(await a.detect().catch(() => false))) continue
    let rows = []
    try { rows = await a.list() } catch (e) { log(`auto: ${agent} list 失败`, e?.message); continue }
    rows.sort((x, y) => (x.updatedAt ?? 0) - (y.updatedAt ?? 0)) // 老的先导
    for (const row of rows) {
      if (attempted >= (cfg.maxPerRun || 5)) break
      const key = `${agent}:${row.id}`
      if (imported[key]) continue
      if (!kindAllowed(row, cfg)) continue
      if ((row.updatedAt ?? 0) < sinceMs) continue
      const targetCwd = cfg.targetMode === 'fixed' ? cfg.fixedTargetCwd : row.cwd
      if (!cwdAllowed(targetCwd, cfg)) continue
      attempted++
      try {
        const turns = await a.turns(row.id, cfg.lastN || 0)
        if (turns.length < (cfg.minTurns || 1)) { continue }
        const title = (cfg.titlePrefix || '') + (row.title || row.id)
        const r = await importSession(ctx, { agent, id: row.id, targetCwd, lastN: cfg.lastN || 0, title })
        imported[key] = { sessionId: r.sessionId, at: Date.now(), turns: r.turns, cwd: targetCwd }
        results.push({ agent, id: row.id, title, ...r })
        log('auto imported', key, '->', r.sessionId)
      } catch (e) {
        log('auto import 失败', key, e?.message)
        imported[key] = { error: String(e?.message || e), at: Date.now() }
      }
    }
  }

  store.imported = imported
  store.lastRunAt = Date.now()
  store.lastResult = { at: store.lastRunAt, manual, imported: results.length, results: results.slice(0, 10) }
  await writeJsonFile(IMPORTED_FILE, store)
  return { ...store.lastResult, baselineAt: store.baselineAt, totalImported: Object.keys(imported).length }
}

// ---------------------------------------------------------------- HTTP

function sameOrigin(req) {
  const host = req.headers?.host
  const origin = req.headers?.origin
  if (!origin) return true // CLI/curl 不带 Origin
  try {
    const u = new URL(origin)
    return !host || u.host === host
  } catch { return false }
}

function send(res, code, body) {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  })
  res.end(data)
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export function apply(ctx, config = {}) {
  // 可选服务：没有就跳过项目登记，不影响导入
  try {
    ctx.inject?.(['workspaceRegistry'], (scoped) => { wsRegistry = scoped.workspaceRegistry })
  } catch (e) { log('workspaceRegistry 不可用:', e?.message) }

  const enabled = new Set(config.adapters?.length ? config.adapters : Object.keys(adapters))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request blocked' })
        const url = new URL(req.url ?? '/', 'http://x')
        const path = url.pathname.slice(API_PREFIX.length) || '/'

        if (req.method === 'GET' && path === '/agents') {
          const list = []
          for (const [id, a] of Object.entries(adapters)) {
            if (!enabled.has(id)) continue
            list.push({ id, label: a.label, available: await a.detect().catch(() => false) })
          }
          return send(res, 200, { agents: list })
        }

        if (req.method === 'GET' && path === '/sessions') {
          const agent = url.searchParams.get('agent') || 'all'
          let rows = []
          if (agent === 'all') {
            for (const [id, a] of Object.entries(adapters)) {
              if (!enabled.has(id)) continue
              if (!(await a.detect().catch(() => false))) continue
              try {
                for (const r of await a.list()) rows.push(r)
              } catch (e) {
                log(`adapter ${id} list 失败:`, e?.message)
              }
            }
          } else {
            const a = adapters[agent]
            if (!a) return send(res, 404, { error: `unknown agent: ${agent}` })
            rows = await a.list()
          }
          rows.sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0))
          const counts = { all: rows.length, main: 0, sub: 0, fork: 0, exec: 0, unknown: 0 }
          for (const r of rows) {
            if (r.kind === 'sub') counts.sub++
            else if (r.kind === 'fork') counts.fork++
            else if (r.kind === 'unknown' || !r.cwd) counts.unknown++
            else if (r.origin === 'exec') counts.exec++
            else counts.main++
          }
          return send(res, 200, { agent, sessions: rows, counts })
        }

        if (req.method === 'GET' && path === '/turns') {
          const agent = url.searchParams.get('agent') || 'kimi-code'
          const id = url.searchParams.get('id')
          const limit = Number(url.searchParams.get('limit') || 5)
          const a = adapters[agent]
          if (!a || !id) return send(res, 400, { error: 'agent and id required' })
          const turns = await a.turns(id, limit)
          const est = estimateTokens(await a.turns(id, 0))
          return send(res, 200, { agent, id, turns, estimate: est })
        }

        if (req.method === 'POST' && path === '/import-project') {
          const body = await readBody(req)
          if (!body?.cwd) return send(res, 400, { error: 'cwd required' })
          const job = startProjectImport(ctx, body)
          return send(res, 200, { jobId: job.id, total: job.total })
        }

        if (req.method === 'GET' && path === '/import-project/status') {
          const id = url.searchParams.get('id')
          const job = projectJobs.get(id)
          if (!job) return send(res, 404, { error: 'job not found' })
          return send(res, 200, job)
        }

        if (req.method === 'POST' && path === '/workspace/delete') {
          const body = await readBody(req)
          if (!body?.path) return send(res, 400, { error: 'path required' })
          if (!wsRegistry?.list) return send(res, 503, { error: 'workspaceRegistry 不可用' })
          const list = await wsRegistry.list()
          const target = list.find((w) => w.path === body.path)
          if (!target) return send(res, 404, { error: 'workspace not found: ' + body.path })
          if (typeof wsRegistry.deleteKnown === 'function') await wsRegistry.deleteKnown(target.id)
          else if (typeof target.delete === 'function') await target.delete()
          else return send(res, 501, { error: '没有可用的删除方法' })
          return send(res, 200, { ok: true })
        }

        if (req.method === 'GET' && path === '/search') {
          const q = url.searchParams.get('q') || ''
          const agent = url.searchParams.get('agent') || 'all'
          const limit = Math.min(100, Number(url.searchParams.get('limit')) || 40)
          const maxMs = Math.min(15000, Number(url.searchParams.get('ms')) || 6000)
          const out = await searchSessions({ q, agent, limit, maxMs })
          return send(res, 200, out)
        }

        if (req.method === 'GET' && path === '/search/warm') {
          warmSearchIndex().catch(() => {})
          return send(res, 200, { warming: true, cached: searchCache.size })
        }

        if (req.method === 'GET' && path === '/debug/agent') {
          const id = url.searchParams.get('id')
          if (!id) return send(res, 400, { error: 'id required' })
          const out = { id }
          try {
            const live = ctx.sessions.get?.(id)
            out.sessionKeys = live ? Object.keys(live) : null
            out.lastSeq = live?.lastSeq ?? live?.seq ?? null
          } catch (e) { out.sessionError = String(e?.message) }
          try {
            const agents = ctx.get?.('agents')
            out.hasAgents = !!agents
            try {
              const proto = agents ? Object.getPrototypeOf(agents) : null
              out.agentMethods = proto ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor') : null
            } catch {}
            const agent = agents?.get?.(id)
            out.hasAgent = !!agent
            if (agent) {
              out.agentKeys = Object.keys(agent).slice(0, 40)
              for (const k of ['status', 'state', 'phase', 'error', 'failure', 'lastError', 'busy', 'running', 'turn', 'disposed']) {
                try { const v = agent[k]; if (v !== undefined && typeof v !== 'function') out[k] = (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v) } catch {}
              }
            }
          } catch (e) { out.agentError = String(e?.message) }
          return send(res, 200, out)
        }

        if (req.method === 'GET' && path === '/debug/resume2') {
          const id = url.searchParams.get('id')
          const agents = ctx.get?.('agents')
          if (!agents?.resume) return send(res, 503, { error: 'agents.resume 不可用' })
          try {
            const r = await agents.resume({ resumeSessionId: id })
            return send(res, 200, { ok: true, agent: !!r?.agent, keys: r ? Object.keys(r) : null })
          } catch (e) {
            return send(res, 500, { ok: false, name: e?.name, error: String(e?.message || e), code: e?.code })
          }
        }

        if (req.method === 'GET' && path === '/debug/prompt') {
          const id = url.searchParams.get('id')
          const agents = ctx.get?.('agents')
          if (!agents?.resume) return send(res, 503, { error: 'agents.resume 不可用' })
          const out = { id, steps: [] }
          try {
            let agent = agents.get?.(id)
            if (!agent) {
              const r = await agents.resume({ resumeSessionId: id })
              agent = r?.agent ?? r
              out.steps.push('resumed')
            } else out.steps.push('already-live')
            const msg = { role: 'user', content: [{ type: 'text', text: 'debug ping' }], source: { kind: 'user' }, id: `dbg-${Date.now()}` }
            try { agent.followup(msg); out.steps.push('followup-ok') } catch (e) { out.steps.push('followup-fail'); out.followupError = { name: e?.name, message: String(e?.message), code: e?.code } }
            return send(res, 200, out)
          } catch (e) {
            out.steps.push('resume-fail')
            out.resumeError = { name: e?.name, message: String(e?.message), code: e?.code }
            return send(res, 200, out)
          }
        }

        if (req.method === 'GET' && path === '/debug/observe') {
          const id = url.searchParams.get('id')
          const sq = ctx.get?.('sessionQuery')
          if (!sq?.observeSession) return send(res, 503, { error: 'sessionQuery 不可用' })
          try {
            const ob = await sq.observeSession(id)
            const h = ob?.header
            const ev = ob?.snapshotEvents?.() ?? ob?.events ?? null
            let n = null
            try { n = Array.isArray(ev) ? ev.length : (typeof ob?.lastSeq === 'number' ? ob.lastSeq : null) } catch {}
            return send(res, 200, { ok: true, id: h?.id, cwd: h?.cwd, events: n })
          } catch (e) {
            return send(res, 500, { ok: false, name: e?.name, error: String(e?.message || e), code: e?.code })
          }
        }

        if (req.method === 'GET' && path === '/debug/list') {
          const sq = ctx.get?.('sessionQuery')
          if (!sq?.listSessions) return send(res, 503, { error: 'sessionQuery.listSessions 不可用' })
          try {
            const rows = await sq.listSessions()
            const arr = Array.isArray(rows) ? rows : [...(rows || [])]
            return send(res, 200, {
              ok: true,
              count: arr.length,
              hasAmd: arr.some((r) => String(r?.id || r?.sessionId || '').includes('1ce90976')),
              hasUkb: arr.some((r) => String(r?.id || r?.sessionId || '').includes('fa1212d7')),
              sample: arr.slice(0, 3).map((r) => ({ id: r?.id || r?.sessionId, cwd: r?.cwd || r?.header?.cwd })),
              raw0: arr[0] || null,
              rawKeys: arr[0] ? Object.keys(arr[0]) : null,
              amdRow: arr.find((r) => JSON.stringify(r).includes('1ce90976')) || null,
              normalRow: arr.find((r) => JSON.stringify(r).includes('19b2ada6')) || null,
            })
          } catch (e) {
            return send(res, 500, { ok: false, name: e?.name, error: String(e?.message || e) })
          }
        }

        if (req.method === 'GET' && path === '/debug/resume') {
          const id = url.searchParams.get('id')
          if (!id) return send(res, 400, { error: 'id required' })
          const agents = ctx.get?.('agents')
          if (!agents?.resume) return send(res, 503, { error: 'agents.resume 不可用' })
          try {
            const r = await agents.resume(id)
            return send(res, 200, { ok: true, result: typeof r === 'object' ? Object.keys(r || {}) : String(r) })
          } catch (e) {
            return send(res, 500, { ok: false, name: e?.name, error: String(e?.message || e), code: e?.code, data: e?.data })
          }
        }

        if (req.method === 'GET' && path === '/debug/read') {
          const id = url.searchParams.get('id')
          if (!id) return send(res, 400, { error: 'id required' })
          try {
            const h = await ctx.sessionPersistence.open(id, 'read')
            const out = await h.read(0, 5)
            const last = await h.read(Math.max(0, (out.eventState?.nextSeq ?? 1) - 3), 3).catch(() => null)
            await h.close?.()
            return send(res, 200, {
              ok: true,
              events: Array.isArray(out.events) ? out.events.length : null,
              first: out.events?.slice(0, 3).map((e) => e.type),
              tail: last?.events?.map((e) => e.type) ?? null,
              nextSeq: out.eventState?.nextSeq ?? null,
            })
          } catch (e) {
            return send(res, 500, { ok: false, error: String(e?.message || e), name: e?.name })
          }
        }

        if (req.method === 'POST' && path === '/debug/detach') {
          const body = await readBody(req)
          const ids = Array.isArray(body?.ids) ? body.ids : [body?.id]
          const out = []
          for (const id of ids.filter(Boolean)) {
            try {
              const session = ctx.sessions.get?.(id)
              const agent = ctx.get?.('agents')?.get?.(id)
              if (!session) { out.push({ id, detached: false, reason: 'not-live' }); continue }
              if (agent) { out.push({ id, detached: false, reason: 'agent-attached' }); continue }
              const entry = ctx.sessions.liveEntryFor?.(session)
              if (!entry) { out.push({ id, detached: false, reason: 'no-entry' }); continue }
              ctx.sessions.detachEntered(entry)
              out.push({ id, detached: true })
            } catch (e) { out.push({ id, detached: false, reason: String(e?.message) }) }
          }
          return send(res, 200, { ok: true, results: out })
        }

        if (req.method === 'GET' && path === '/debug/methods') {
          const name = url.searchParams.get('name') || 'sessions'
          const svc = name === 'sessions' ? ctx.sessions : ctx.get?.(name)
          const out = { name, has: !!svc, methods: null, own: null }
          try {
            if (svc) {
              out.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter((k) => k !== 'constructor')
              out.own = Object.keys(svc)
            }
          } catch (e) { out.error = String(e?.message) }
          return send(res, 200, out)
        }

        if (req.method === 'GET' && path === '/debug/session') {
          const id = url.searchParams.get('id')
          if (!id) return send(res, 400, { error: 'id required' })
          const out = { id }
          try { const live = ctx.sessions.get?.(id); out.live = !!live; out.liveCwd = live?.header?.cwd } catch (e) { out.liveError = String(e?.message) }
          try {
            const st = await ctx.sessionPersistence?.stat?.(id)
            out.hasStat = !!st
            out.storedCwd = st?.header?.cwd
            out.header = st?.header
          } catch (e) { out.statError = String(e?.message || e) }
          return send(res, 200, out)
        }

        if (req.method === 'GET' && path === '/workspaces') {
          if (!wsRegistry?.list) return send(res, 200, { workspaces: [], note: 'workspaceRegistry 不可用' })
          const list = await wsRegistry.list()
          return send(res, 200, { workspaces: list.map((w) => ({
            id: w.id, path: w.path, title: w.title,
            hasSetTitle: typeof w.setTitle === 'function',
            sessions: w.sessionIds?.length ?? null,
          })) })
        }

        if (req.method === 'POST' && path === '/workspace/rename') {
          const body = await readBody(req)
          if (!body?.path || !body?.title) return send(res, 400, { error: 'path, title required' })
          if (!wsRegistry?.list) return send(res, 503, { error: 'workspaceRegistry 不可用' })
          const list = await wsRegistry.list()
          const target = list.find((w) => w.path === body.path) || (wsRegistry.resolveByPath ? await wsRegistry.resolveByPath(body.path) : null)
          if (!target) return send(res, 404, { error: 'workspace not found: ' + body.path })
          await target.setTitle(body.title)
          return send(res, 200, { ok: true, id: target.id, title: target.title })
        }

        if (req.method === 'POST' && path === '/workspace/attach') {
          const body = await readBody(req)
          if (!body?.path || !body?.sessionId) return send(res, 400, { error: 'path, sessionId required' })
          if (!wsRegistry?.list) return send(res, 503, { error: 'workspaceRegistry 不可用' })
          const list = await wsRegistry.list()
          const target = list.find((w) => w.path === body.path)
          if (!target) return send(res, 404, { error: 'workspace not found: ' + body.path })
          await target.attachSession(body.sessionId)
          return send(res, 200, { ok: true, id: target.id, sessions: target.sessionIds?.length ?? null })
        }

        if (req.method === 'GET' && path === '/auto') {
          const cfg = await loadAutoConfig()
          const store = await readJsonFile(IMPORTED_FILE, { imported: {}, baselineAt: null, lastRunAt: null, lastResult: null })
          return send(res, 200, { config: cfg, status: {
            baselineAt: store.baselineAt, lastRunAt: store.lastRunAt,
            imported: Object.keys(store.imported || {}).length,
            lastResult: store.lastResult,
          } })
        }

        if (req.method === 'POST' && path === '/auto') {
          const body = await readBody(req)
          const cfg = await saveAutoConfig(body || {})
          autoRestartHook?.()
          return send(res, 200, { config: cfg })
        }

        if (req.method === 'POST' && path === '/auto/run') {
          const out = await runAutoImport(ctx, { manual: true })
          return send(res, 200, out)
        }

        if (req.method === 'POST' && path === '/import') {
          const body = await readBody(req)
          if (!body.agent || !body.id || !body.targetCwd) {
            return send(res, 400, { error: 'agent, id, targetCwd required' })
          }
          const result = await importSession(ctx, body)
          log('imported', body.agent, body.id, '->', result.sessionId)
          return send(res, 200, result)
        }

        return send(res, 404, { error: 'not found' })
      } catch (e) {
        log('route error:', e?.stack || e)
        return send(res, 500, { error: String(e?.message || e) })
      }
    },
  }), 'foreign-sessions: routes')

  // 自动导入定时器（规则存在 ~/.dsh/foreign-sessions/auto.json，可被 UI 修改）
  let autoTimer = null
  const startAuto = () => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
    loadAutoConfig().then((cfg) => {
      if (!cfg.enabled) return
      const ms = Math.max(30, Number(cfg.intervalSec) || 120) * 1000
      autoTimer = setInterval(() => { runAutoImport(ctx).catch((e) => log('auto 运行失败', e?.message)) }, ms)
      autoTimer.unref?.()
      log(`auto-import 已启用：每 ${ms / 1000}s，kinds=${cfg.kinds.join('|')}`)
    }).catch((e) => log('auto 配置读取失败', e?.message))
  }
  startAuto()
  autoRestartHook = startAuto
  // 全文索引：先用磁盘缓存（重启后秒搜），再后台增量预热
  loadSearchCacheFromDisk()
    .then((n) => { if (n) log('search-cache 载入', n, '条') })
    .catch(() => {})
    .finally(() => setTimeout(() => { warmSearchIndex().catch(() => {}) }, 3000).unref?.())
  
  ctx.effect(() => () => { if (autoTimer) clearInterval(autoTimer) }, 'foreign-sessions: auto timer')

  log('ready; adapters =', [...enabled].join(','), '; kimi home =', KIMI_HOME)
}
