# Changelog

## [Unreleased]

### Changed

- 将公开入口调整为 Agent-first 使用说明：用户直接在 Codex、Claude Code、Qwen Code 等本地 Agent 中打开复习仓库。
- GitHub Pages 不再承担聊天、建档、判分或学习进度存储，也不再要求下载 Local Agent Runtime。
- 将旧隐私页改为当前 `.study/` 本地数据边界说明，并把历史配对直链改为不可执行的停用提示。
- Service Worker 发现旧版 Pages 缓存时会清理缓存并将现有窗口迁移到新首页；后续导航采用网络优先，避免大版本切换继续命中旧壳。

### Removed

- 停止自动构建和发布新的 Local Agent Runtime 安装包。

### Migration

- 旧预览版保存在 Pages IndexedDB 的学习档案不会自动迁入 `.study/`，当前首页也不会读取或删除它；如不再需要，可从浏览器的网站数据设置中清理。本次断代发布不再把旧浏览器档案作为受支持的学习入口。
