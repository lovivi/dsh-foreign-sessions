/**
 * 修复「导入会话缺少受保护 system/message 头」导致的打不开问题。
 *
 * 症状：会话在 DSH 里能打开一次，之后就报错/白屏；日志校验报
 *   `system/message requires a protected first surface head`
 * 原因：v4 日志要求第一个 surface 事件是 system/message（受保护头）。
 *   早期版本的导入器没有写这个头，agent 恢复时会把 system/message 追加在中间，
 *   于是整份日志不再合法，重启后无法恢复。
 *
 * 用法：
 *   node tools/repair-system-head.mjs <session.v4.jsonl.zstd>
 *
 * 做的事：
 *   1) 解压多帧 zstd，按 v4 规则找到第一个 surface 事件
 *   2) 在它前面插入一条 surfaceOp:"append" 的 system/message（模板取自本文件里已有的 system/message）
 *   3) 重编号 seq 并同步 messageSeqs 引用
 *   4) 以「首帧=header 行、后续帧=事件行」的物理布局写回（DSH 要求首帧恰好一行 header）
 *   5) 用官方格式目录做 finish 校验；备份原文件为 *.bak-repair
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

const CATALOG_CANDIDATES = [
  '/home/song/.npm/_npx/50d2c97abf8f4186/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js',
  '@deepseek-ai/dsh-session-format-catalog',
]

const file = process.argv[2]
if (!file) { console.error('usage: node tools/repair-system-head.mjs <session.v4.jsonl.zstd>'); process.exit(2) }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeAll(buf) {
  const frames = []
  let pos = 0
  while (true) {
    const i = buf.indexOf(MAGIC, pos)
    if (i < 0) break
    const j = i + 4 < buf.length ? buf.indexOf(MAGIC, i + 4) : -1
    frames.push(buf.subarray(i, j < 0 ? buf.length : j))
    pos = j < 0 ? buf.length : j
  }
  return frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('')
}

const text = decodeAll(readFileSync(file))
const lines = text.split('\n').filter(Boolean)
const [header, ...events] = lines.map((l) => JSON.parse(l))

const SURFACE = new Set(['system/message', 'user/message', 'assistant/message', 'developer/message'])
const firstSurface = events.findIndex((e) => SURFACE.has(e.type))
if (firstSurface < 0) { console.error('日志里没有 surface 事件，不需要修复'); process.exit(0) }
const template = events.find((e) => e.type === 'system/message' && e.data?.message?.role === 'system')
if (!template) { console.error('日志里没有可作模板的 system/message（改用 --template 指向另一个会话）'); process.exit(1) }

const out = []
const newSeqOf = new Map()
let next = 0
for (let i = 0; i < events.length; i++) {
  if (i === firstSurface) {
    out.push({
      type: 'system/message',
      seq: next++,
      time: events[firstSurface].time - 1,
      data: { turn: 1, step: 1, message: template.data.message },
      surfaceOp: 'append',
    })
  }
  const e = events[i]
  newSeqOf.set(e.seq, next)
  out.push({ ...e, seq: next++ })
}
for (const e of out) {
  if (e.type !== 'session/title' || !Array.isArray(e.data?.messageSeqs)) continue
  e.data.messageSeqs = e.data.messageSeqs.map((s) => newSeqOf.get(s) ?? s)
}

const headerLine = JSON.stringify(header) + '\n'
const body = out.map((e) => JSON.stringify(e)).join('\n') + '\n'
copyFileSync(file, file + '.bak-repair')
writeFileSync(file, Buffer.concat([zstdCompressSync(Buffer.from(headerLine)), zstdCompressSync(Buffer.from(body))]))
console.log(`已修复 ${file}：插入 system/message 头，事件 ${out.length} 条`)

let catalog
for (const c of CATALOG_CANDIDATES) {
  try { catalog = (await import(c)).sessionFormatCatalog; break } catch { /* 试下一个 */ }
}
if (!catalog) { console.warn('未找到 @deepseek-ai/dsh-session-format-catalog，跳过校验'); process.exit(0) }
const restore = catalog.createRestore(header, { recovery: 'recoverable', validation: 'current' })
for (const e of out) restore.decodeRow(e)
const cur = restore.finish()
console.log(`✅ 校验通过：${cur.events.length} 条事件`)
