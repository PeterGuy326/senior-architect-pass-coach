# Local Agent Runtime 使用说明

Local Agent Runtime 是“架构过线私教”的本机 Agent 执行层。它把同一套网页从 `http://127.0.0.1:43127/` 打开，并通过 Digital Employee `0.3.0` 调用用户明确选择的兼容 Agent。学习档案、可信判分和进度仍只由浏览器 Harness 写入。

## 考生使用

1. 从 [GitHub Releases](https://github.com/PeterGuy326/senior-architect-pass-coach/releases) 下载系统对应的预览包；需要核验下载完整性时，对照同一 Release 的 `SHA256SUMS`。
2. macOS 解压并打开 `Senior Architect Pass Coach.app`；Linux x64（glibc 2.28+，不适用于 Alpine/musl）解压并运行 `start-local-coach`。
3. 浏览器打开后，先建档或导入从 GitHub Pages 导出的档案。
4. 点击页面顶部的“连接本机 Agent”，等待员工包级兼容性检查。
5. 选择状态为“可用”的 Agent。答题仍由固定答案键批改；提交后会追加 Agent 的个性化讲解，也可以继续追问。

不需要 clone 仓库、安装 npm 包或编译源码。当前 macOS 包是未 notarize 的开源预览版；ad-hoc 签名只用于完整性检查，不代表 Developer ID 或 Apple 背书。首次启动可先在 Finder 中右键应用并选择“打开”；若仍被拦，请先尝试启动一次，再到“系统设置 → 隐私与安全 → 仍要打开”，详见 [Apple 官方说明](https://support.apple.com/102445)。

## Agent 与凭证

Runtime 不会把 Agent CLI 一起打包，也不会从网页收集 API Key。Digital Employee 当前会探测本机已有的 Host，并要求 Runtime 进程环境中存在对应服务凭证：

| Agent | 运行要求 |
|---|---|
| Claude Code | 兼容版本、`ANTHROPIC_API_KEY` |
| Qwen Code | `0.17.1`、`OPENAI_API_KEY`、`OPENAI_MODEL` |
| CodeBuddy | `2.106.4`、`CODEBUDDY_API_KEY`、`CODEBUDDY_MODEL` |

Qoder 当前缺少本员工包要求的结构化输出能力；Codex 在 Digital Employee `0.3.0` 中只有 probe-only Adapter，因此二者会显示但不能选择。

预览版只读取启动环境，不提供网页密钥表单。不要把 Key 放进 URL、聊天内容、仓库文件或命令参数；请使用自己信任的本机凭证管理方式先建立 Runtime 的环境，再启动应用。后续正式安装器应接入操作系统 Keychain/Credential Manager。

## 记忆与迁移

切换 Agent 只改变讲解引擎，不会清空当前题目、session revision、attempt 或进度。

GitHub Pages 和 `127.0.0.1` 属于两个不同浏览器 Origin，因此不会自动共享 IndexedDB。第一次从 Pages 转到 Runtime 时：

1. 在 Pages 页面点击“导出档案”；
2. 在 Runtime 页面点击“导入档案”；
3. 核对进度后继续。

导出文件不含题干、选项、原始作答、参考答案、解析、Agent 回复、Bearer 或 API Key。当前没有云端同步和双向冲突合并。

## 信任边界

- Runtime 只绑定 IPv4 loopback `127.0.0.1`，拒绝 `localhost`、LAN Host 和代理头。
- 页面必须显式连接；短期 Bearer 只存在 JavaScript 内存，Runtime 重启即失效。
- API 请求不能选择可执行文件、目录、环境变量、身份或模型密钥。
- 出题不调用 Agent；提交后先完成可信判分与进度事务，再调用 Agent。
- Agent 输出必须通过员工包 Schema、动作、答案门和可信判定一致性检查；Runtime 只返回有界 coaching text，丢弃所有进度事件提案。
- 模型失败不会回滚或重复提交学习进度。

## 源码开发

开发者可以在依赖已安装的仓库中运行：

```bash
npm run runtime
```

默认端口为 `43127`。源码入口只用于开发；考生应使用 Release 中的自包含预览包。
