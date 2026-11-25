/**
 * 渲染冒烟测试：用最小版 React 直接执行 Panel()，捕获同步异常（如 TDZ / 未定义变量）。
 * 这能抓住"面板一片空白"最常见的原因：组件在 render 阶段抛错。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
let loaded = null
new Function('window', code)({ __ModuleLoader__: { load(e) { loaded = e } } })
if (!loaded) { console.error('❌ 未自注册'); process.exit(1) }

function makeReact() {
  let storage = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(init) {
      const v = typeof init === 'function' ? init() : init
      storage.push(v)
      return [v, () => {}]
    },

    useEffect(fn, deps) { /* SSR 不执行副作用 */ },
    useMemo(fn, deps) { return fn() },
    useCallback(fn, deps) { return fn },
  }
  return React
}

const React = makeReact()
const mod = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

const slots = []
const ctx = {
  slots: { inject(n, fn) { fn() }, register(def, comp) { slots.push({ def, comp }); return () => {} } },
  layout: {},
}
mod.apply(ctx)

const main = slots.find((s) => s.def.name === 'main')
if (!main) { console.error('❌ 没注册 main'); process.exit(1) }

// 直接执行组件函数：任何同步错误都会在这里抛出
let tree
try {
  tree = main.comp({})
} catch (e) {
  console.error('❌ Panel 渲染抛错:', e && e.stack || e)
  process.exit(1)
}

// 把树摊平成文本，确认关键 UI 真的产出
const texts = []
;(function walk(node) {
  if (node == null) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) return node.forEach(walk)
  if (node.children) node.children.forEach(walk)
})(tree)
const flat = texts.join(' | ')
const checks = ['外部会话导入', '自检中', '选一条会话看预览', '只看新']
const missing = checks.filter((c) => !flat.includes(c) && !JSON.stringify(tree).includes(c))
console.log('渲染文本片段:', flat.slice(0, 160))
if (missing.length) { console.error('❌ 缺少元素:', missing.join(', ')); process.exit(1) }
console.log('\n✅ Panel 渲染通过（无同步异常），关键元素齐全')
