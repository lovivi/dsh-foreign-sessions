# Changelog

## 0.7.2
- **修复导入会话无法继续对话**：导入后会话被发布在 sessions store 里却没有 agent，客户端打开后 resume 报 `session "..." already exists`，发送消息直接失败。
  现在导入结束会把这条"已发布但无 agent"的会话从 store 摘除，只保留磁盘日志，等客户端首次打开时正常 resume。
- 清理：导入路径不再留下 live 会话实体（重启前也能正常续聊）。

## 0.7.1
- 搜索结果按**项目分组**（组头显示目录名、父目录、命中数）
- 命中关键词**高亮**（标题与正文片段）
- 仅客户端渲染改动，搜索只读，不写会话

## 0.7.0
- 新增**内容搜索**：勾选「搜内容」后在会话正文里检索，命中显示轮次与上下文片段，点结果直接预览/导入
- 搜索索引内存 + 磁盘缓存（`~/.dsh/foreign-sessions/search-cache.json`），重启后秒搜；全量 371 会话约 0.3s
- 修复：`fmtTime` 时间格式（去掉多余冒号）
- 加 `npm run check`（模块可加载）+ `npm test`

## 0.6.2
- **修复导入会话打不开**：导入时写入受保护的 `system/message` surface 头（v4 格式要求），避免恢复后日志非法
- 新增 `tools/repair-system-head.mjs`：修复历史坏会话（插入系统头 + 重编号 + 正确帧布局 + 官方校验）
- 无模板时退回最小系统提示，保证结构合法

## 0.6.1
- 预览面板：当选中的导入会话在客户端会话列表里缺 `cwd` 时给出黄色提示（内置「Workspace files」会因此打不开，刷新页面可恢复）

## 0.6.0
- 项目级批量导入（`/api/foreign/import-project` 后台任务 + 进度轮询）
- 项目维护接口：`/workspaces`、`/workspace/rename`、`/workspace/attach`、`/workspace/delete`
- 修复：项目标题误用对话标题；cwd 尾斜杠导致项目分叉；重复导入无去重；导入后未挂到项目

## 0.5.0
- `normalizeCwd()`（去尾斜杠、必须绝对路径、自动建目录）
- 手动导入去重表 `imported-manual.json`
- 导入后 `attachSession` 到项目

## 0.4.x
- 子代理挂到父会话下折叠
- 可配置自动导入规则（面板内编辑，落盘 `auto.json`）
- 项目分组 UI：吸顶、折叠、计数、混合 Agent 标记

## 0.3.0
- 会话类型识别（main / sub / fork / unknown）与来源（exec 等）
- 类型/时间筛选、`NEW` 徽标、自动刷新

## 0.2.0
- 新增 Claude Code、Codex 适配器；`全部 Agents` 视图
- 修复导入不落盘（先取持久化写句柄再发布会话）

## 0.1.x
- Kimi Code 适配器、面板 UI、导入执行器、离线自测
