# Changelog

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
