/**
 * 客户端半端离线自测：不启动浏览器，只验证「自注册 + slot 注册」这条链路。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
let loaded = null
const win = { __ModuleLoader__: { load(entry) { loaded = entry } } }
new Function('window', code)(win)

if (!loaded) { console.error('❌ 没有调用 __ModuleLoader__.load'); process.exit(1) }
console.log('✅ 自注册 id =', loaded.id)

const stubReact = {
  createElement: (...args) => ({ args }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useState: (v) => [v, () => {}],
}
const stubRequire = (name) => {
  if (name === 'react') return stubReact
  throw new Error('unexpected require: ' + name)
}
const mod = loaded.factory(stubRequire)
console.log('✅ factory 返回 inject =', JSON.stringify(mod.inject))

const registered = []
const ctx = {
  slots: {
    inject(name, fn) { fn() },
    register(def, comp) { registered.push({ name: def.name, key: def.key, id: def.id, order: def.order }); return () => {} },
  },
  layout: {},
}
mod.apply(ctx)
console.log('✅ apply 注册了', registered.length, '个 slot:')
for (const r of registered) console.log('   ', JSON.stringify(r))
const ok = registered.some((r) => r.name === 'main' && r.key === 'foreign-sessions')
  && registered.some((r) => r.name === 'sidebar.panellist' && r.id === 'foreign-sessions')
console.log(ok ? '\n✅ 通过：main + sidebar.panellist 成对注册' : '\n❌ 失败：slot 注册不完整')
process.exit(ok ? 0 : 1)
