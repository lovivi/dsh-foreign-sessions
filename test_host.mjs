/**
 * Host 半端离线自测：对每个适配器跑「发现 → 预览 → 导入」，再用官方 codec 校验事件流。
 * 用法: node test_host.mjs [每个适配器导入的轮数]
 */
import { Readable } from 'node:stream'
import { adapters, apply, importSession } from './index.js'

const CATALOG = process.env.DSH_FORMAT_CATALOG
  || '/home/song/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'

const N = Number(process.argv[2] || 5)

function mockCtx() {
  const state = { routes: [], events: [], created: null, flushed: false }
  let seq = 0
  const ctx = {
    effect(fn) { fn(); return () => {} },
    webServer: { register(route) { state.routes.push(route); return () => {} } },
    sessions: {
      create(id, opts) {
        state.created = { id, opts }
        return { append(type, data, o = {}) {
          const row = { type, seq: seq++, time: Date.now(), data }
          if (o.surfaceOp) row.surfaceOp = o.surfaceOp
          state.events.push(row)
          return row
        } }
      },
      async flush() { state.flushed = true },
    },
    workspaceRegistry: { async create(cwd, title) { return { id: 'ws-1', title } } },
  }
  return { ctx, state }
}

function callRoute(route, { method = 'GET', url, body }) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.method = method
    req.url = url
    const chunks = []
    const res = {
      writeHead(code, headers) { this.code = code },
      end(data) { if (data) chunks.push(Buffer.from(data)); resolve({ code: this.code, body: Buffer.concat(chunks).toString('utf8') }) },
    }
    route.handler(req, res).catch((e) => resolve({ code: 500, body: String(e) }))
  })
}

const { sessionFormatCatalog } = await import(CATALOG)

for (const [id, adapter] of Object.entries(adapters)) {
  console.log('\n' + '='.repeat(60))
  const t0 = Date.now()
  const available = await adapter.detect().catch(() => false)
  if (!available) { console.log(`[${id}] 不可用（未安装）`); continue }
  const list = await adapter.list()
  const byCwd = new Map()
  for (const s of list) byCwd.set(s.cwd, (byCwd.get(s.cwd) ?? 0) + 1)
  console.log(`[${id}] 会话 ${list.length} · 项目 ${byCwd.size} · 列表耗时 ${Date.now() - t0}ms`)
  const top = [...byCwd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
  for (const [cwd, n] of top) console.log(`         ${n} 会话 · ${cwd}`)

  const target = list[0]
  if (!target) { console.log(`[${id}] 没有可测会话`); continue }
  const preview = await adapter.turns(target.id, 2)
  console.log(`[${id}] 预览 ${target.title.slice(0, 40)} → ${preview.length} 轮`)
  for (const t of preview) console.log(`         Q: ${t.user.slice(0, 50).replace(/\n/g, ' ')} | A: ${(t.answer || '').slice(0, 40).replace(/\n/g, ' ')}`)

  const { ctx, state } = mockCtx()
  const result = await importSession(ctx, { agent: id, id: target.id, targetCwd: '/tmp/foreign-import-test', lastN: N, title: target.title })
  const restore = sessionFormatCatalog.createRestore(
    { type: 'session', version: 4, id: 'test', createdAt: state.events[0].time, cwd: result.cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { recovery: 'recoverable', validation: 'current' })
  let bad = 0
  for (const ev of state.events) { try { restore.decodeRow(ev) } catch (e) { bad++; console.error('   ❌', ev.type, e.message) } }
  const cur = restore.finish()
  console.log(`[${id}] 导入 ${result.turns} 轮 / ${result.events} 事件 / ${result.chars} 字 → ${bad ? `❌ ${bad} 个事件被拒` : `✅ codec 通过（${cur.events.length}）`}`)
}

// /agents 路由
const { ctx, state } = mockCtx()
apply(ctx, { adapters: ['kimi-code', 'claude-code', 'codex'] })
const r = await callRoute(state.routes[0], { url: '/api/foreign/agents' })
console.log('\n[route] /agents →', r.code, r.body.slice(0, 220))
const rAll = await callRoute(state.routes[0], { url: '/api/foreign/sessions?agent=all' })
console.log('[route] /sessions?agent=all →', rAll.code, '会话数', JSON.parse(rAll.body).sessions.length)
