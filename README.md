# dsh-foreign-sessions

在 DSH 里发现本机其他 Agent 的会话（**Kimi Code / Claude Code / Codex CLI**），按「项目(cwd) → 会话」浏览，选中后**导入成 DSH 会话**。

- Host 半端：`index.js` —— 三个适配器 + 发现 / 读取 / 导入（走 DSH 官方 `ctx.sessions`，不手写日志）
- 客户端半端：`lib/client.js` —— 已预构建的自注册脚本（侧栏图标 + 全局面板）
- 自测：`node test_host.mjs`（发现+导入+官方 codec 校验）、`node test_client.mjs`（slot 注册）

## 安装

**推荐：Web 面板安装**（会自动 link 进 profile 并加入 `dsh.profile.bundles` + HMR）

1. 打开 DSH Web → 设置 → 插件 → 添加插件
2. 填**本地绝对目录**：`/home/song/work/dshtest/dsh_foreign_sessions`
3. 启用后刷新页面，左侧栏出现「外部会话」图标（⤓）

**CLI 方式**（只装依赖，还要手动选包）：

```bash
dsh plugin --profile web add /home/song/work/dshtest/dsh_foreign_sessions
# 然后把 "dsh-foreign-sessions" 加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
```

安装/启用是 profile 级操作，会触发一次审批；失败信息在「设置 → 插件 → 插件列表」。

## 用

1. 点侧栏「外部会话」→ 打开面板
2. 左列按 cwd 分组列出 Kimi Code 的项目与会话（本机 194 个会话 / 57 个项目）
3. 点会话 → 右侧预览前 5 轮 + 全量体量（字数/≈tokens）
4. 选范围（最近 50 / 100 / 全量）、确认目标目录 → 「导入到 DSH」
5. 成功后刷新 DSH 会话列表即可看到；导进去的就是普通会话，能看、能搜、能续聊

## 自动 vs 手动

| 环节 | 现在 | 说明 |
|---|---|---|
| 发现 Agent / 项目 / 会话 | **自动** | 打开面板即全量扫描（本机 194 会话 / 57 项目），不需要填路径 |
| 列表刷新 | **自动**（8 秒轮询） | 顶栏显示「更新于 hh:mm:ss」，也可点「刷新」 |
| 新会话提示 | **自动** | 首开后新增的会话打 `NEW` 徽标；可勾「只看新」过滤 |
| 导入 | **手动点按钮** | 设计如此：导入会写 DSH 会话库，默认不自动灌 |
| 自动导入 | 未实现（可选） | 需要规则 + 去重，见下 |

**为什么导入默认手动**：自动导入会把每个新会话都灌进 DSH（token 成本、列表噪音），且失败时难以发现。若要做自动，建议规则化：

```yaml
autoImport:
  enabled: false
  onlyAfter: first-run        # 只导插件首次运行之后更新的会话
  lastN: 50                   # 默认只导最近 50 轮
  projectFilter: []           # 只导这些 cwd 下的（空=全部）
  dedupe: ~/.dsh/foreign-sessions/imported.json
```

## 适配器

| Agent | 数据源 | 解析要点 |
|---|---|---|
| `kimi-code` | `~/.kimi-code/sessions/*/session_*/` | `state.json` 取 cwd/标题；`wire.jsonl` 的 `turn.prompt` + `content.part(text)` |
| `claude-code` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 跳过 `isSidechain`/`isMeta`/`tool_result`；标题取 `ai-title`；回答取该轮最后一个 assistant 文本块 |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（含 archived） | `session_meta` 取 cwd；问答取 `event_msg` 的 `user_message` / `agent_message`；工具数取 `function_call` |

本机实测：Kimi 233 会话 / 61 项目，Claude 16 / 10，Codex 114 / 25；三份导入均通过官方 codec 校验。

## 当前边界

- **只读**外部数据；写只发生在 DSH 自己的会话库
- 只导入「提问 + 最终回答」，不含思考与工具调用（那些在 Kimi 原文里，插件不搬）
- 全量导入 425 轮 ≈ 35.5 万 tokens，**续聊请用最近 50 轮**（≈4.6 万 tokens）
- Gemini CLI / Cursor 等留了适配器接口，尚未实现（新增一个 `Adapter` 对象即可，UI 不用改）

## 接口

Host 端注册在 `/api/foreign` 前缀下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/foreign/agents` | 可用 Agent 列表 |
| GET | `/api/foreign/sessions?agent=kimi-code` | 全部会话（含 cwd/标题/大小/时间） |
| GET | `/api/foreign/turns?agent=…&id=…&limit=5` | 预览轮次 + 全量体量估算 |
| POST | `/api/foreign/import` | `{agent,id,targetCwd,lastN,title}` → 创建 DSH 会话 |

## 落盘要点（实现约束）

导入不是"建个内存会话"就行，DSH 的持久化只把事件路由给**已有写句柄**的会话：

```js
const handle = await ctx.sessionPersistence.create({
  version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
})
const session = ctx.sessions.create(id, { meta: { cwd } })   // 发布会话，事件开始路由到 handle
// …append 事件…
await handle.flush(); await handle.close()
```

少 `version: 4` 会报 `Session format version must be a non-negative safe integer`；漏掉句柄则文件根本不会出现。
另：`workspaceRegistry` 是可选服务，需用 `ctx.inject(['workspaceRegistry'], cb)` 捕获后再登记项目。

## 子代理 / 副本的识别（避免污染）

各家的"子代理"落盘方式不同，适配器统一给出 `kind`（`main` / `sub` / `fork`）与 `origin`：

| Agent | 判定规则 | 本机数量 |
|---|---|---|
| **Kimi Code** | 子代理不单独成会话（都在父会话的 `agents/agent-*` 里）；`state.json.forkedFrom` 存在 → `fork` | 主 198 / 副本 35 |
| **Claude Code** | 子代理在 `<sessionId>/subagents/*.jsonl`（子目录，本就不列入）；主文件里 `isSidechain` 行跳过 | 子 0（16 主） |
| **Codex** | `session_meta.thread_source === 'subagent'` 或 `source.subagent` 或 `parent_thread_id` → `sub`；`source: 'exec'` → `origin=exec`（脚本运行） | 子 17 / exec 31 / 主 66 |

汇总（本机实测）：**364 条 = 主 281 + 子代理 17 + 副本 35 + 脚本 31**。

另外修了一个 Codex 的坑：恢复会话会新开 rollout 文件，同一 thread id 可能出现在多个文件里；之前解析取了"最后一条 session_meta"，导致多个文件被算成同一会话（98 唯一 / 114 行）。现在按 id 合并分段、问答按时间拼接去重。

## UI：筛选优先

顶部筛选条（选择会存 localStorage）：

- **Agent**：全部 / Kimi / Claude / Codex
- **类型**：主会话（默认，排除子代理/副本/脚本）/ 全部 / 子代理 / 副本 / 脚本运行 —— 带实时计数
- **时间**：全部 / 近 7 / 30 / 90 天
- **只看新**（NEW 徽标）、搜索框、刷新与刷新时间

行内徽标：`子`（子代理）、`副本`（fork）、`exec`（脚本运行），来源标记 Kimi/Claude/Codex。

## 子代理折叠

- Codex 的 `parent_thread_id` / Kimi 的 `forkedFrom` 都映射到 `parentId`；客户端把子会话挂在父会话下面。
- 父行显示 `▸ N 子` 徽标，点击展开/折叠（缩进 + 左边条）；子会话不会混进主列表。
- 展开不受"类型"筛选限制——主视图里也能点开看某个父会话的子代理。
- 列表只按一级挂载：找不到父（父已归档/不在列表）的子会话退回顶层显示。

## 自动导入规则（可自定义）

面板顶栏「▸ 自动导入」展开即可编辑，规则落在 `~/.dsh/foreign-sessions/auto.json`，去重表在同目录 `imported.json`。

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关（默认关） |
| `intervalSec` | 轮询间隔秒（≥30） |
| `agents` | 参与自动导入的适配器 |
| `kinds` | `main` / `sub` / `fork` / `exec` 多选 |
| `includeCwd` / `excludeCwd` | 目录前缀白/黑名单（空 = 全部） |
| `lastN` | 每条只导最近 N 轮（默认 50） |
| `minTurns` | 少于 N 轮的跳过 |
| `maxPerRun` | 每次最多导入几条（默认 5） |
| `targetMode` | `same` = 用会话自己的 cwd；`fixed` = 固定目录 |
| `titlePrefix` | 导入后标题前缀（例如 `[导入] `） |

安全阀：**baseline**（首次运行时刻）之前的历史一律不导；已导过的 `agent:id` 记在去重表；失败只记错误不重试风暴；rules 改动后定时器立即重启。

HTTP：`GET /api/foreign/auto`（配置+状态）、`POST /api/foreign/auto`（保存）、`POST /api/foreign/auto/run`（立即跑一次）。

## 项目（路径）分组 UI

- 左列按 **cwd** 分组；每个项目头是**吸顶**的（滚动时保持可见），点击整行即折叠/展开。
- 项目头显示：`▾ 项目名  条数  [N 新]  [K·C·X]  …/父目录`，完整路径在 hover title 里。
  - `K/C/X` = 该项目下混合了 Kimi / Claude / Codex 的会话
- 顶部有 **全展开 / 全折叠**；折叠状态存 `localStorage`，刷新后保持。
- 子代理在同一项目内再挂一级（`▸ N 子`），与项目折叠互不干扰。

## 导入的规范化与去重（v0.5.0）

修复三个叠加问题：

1. **工作区标题**：以前把对话标题传给 `workspaceRegistry.create(cwd, title)`，导致项目被命名成对话名。
   现在标题永远取**目标目录的 basename**。
2. **cwd 尾斜杠**：Kimi 的 `state.json.cwd` 可能带 `/`（如 `/mnt/.../ukb_frailty_neuro/`），会让 `projectKey`
   多一个破折号（`--..._neuro---`），被当成另一个项目。现在导入前统一 `normalizeCwd()`：
   trim、去尾斜杠、必须绝对路径；目标目录不存在会自动 `mkdir -p`。
3. **重复导入**：每次点击都新建一份。现在维护 `~/.dsh/foreign-sessions/imported-manual.json`
   （`agent:id → sessionId`），重复导入返回 `{duplicate:true, sessionId}`，UI 显示
   「已导入过 · 再导一份」，要副本需显式确认。

另外导入成功后调用 `project.attachSession(sessionId)`，保证会话真的挂在项目下（而不是 UnGrouped）。

新增调试/维护接口：`GET /api/foreign/workspaces`、`POST /api/foreign/workspace/rename`、
`POST /api/foreign/workspace/attach`。

## 项目级批量导入（v0.6.0）

项目头右侧有「⤓ 导入」按钮：把该项目（同一 cwd）下**符合条件的会话一次性导入到该项目目录**。

- 走后台任务：`POST /api/foreign/import-project` 立即返回 `jobId`，前端轮询
  `GET /api/foreign/import-project/status?id=`，项目头上显示 `done/total`，完成后显示
  `✓ 导入 N · 跳过 M · 失败 K`。
- 匹配规则：**cwd 精确匹配**（先 `normalizeCwd`）+ 当前「类型」筛选（主会话/子代理/副本/脚本）。
- 复用去重表：已导过的会话自动跳过，不会重复灌。
- 导入的每条都走单条导入同一套逻辑：`normalizeCwd` → workspace（标题=目录名）→ 持久化句柄 → 事件 → `attachSession`。

维护接口（出现"歪项目"时可直接修）：

```
GET  /api/foreign/workspaces                列出项目（id/path/title/会话数）
POST /api/foreign/workspace/rename          { path, title }
POST /api/foreign/workspace/attach          { path, sessionId }
POST /api/foreign/workspace/delete          { path }
```
