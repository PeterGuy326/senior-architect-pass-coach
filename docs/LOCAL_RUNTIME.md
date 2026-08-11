# Local Agent Runtime 使用说明

Local Agent Runtime 是“架构过线私教”的本机配对与 Agent 执行桥。考生始终在 [GitHub Pages](https://peterguy326.github.io/senior-architect-pass-coach/) 学习；Runtime 不建立第二个学习入口，也不保存第二份档案。学习档案、可信判分和进度仍由该 Pages Origin 的浏览器 Harness 写入，Digital Employee `0.3.0` 只负责运行用户明确选择且通过检查的 Agent。

## 考生使用

1. 从 [GitHub Releases](https://github.com/PeterGuy326/senior-architect-pass-coach/releases) 下载系统对应的预览包；需要核验下载完整性时，对照同一 Release 的 `SHA256SUMS`。
2. macOS 解压并打开 `Senior Architect Pass Coach.app`；Linux x64（glibc 2.28+，不适用于 Alpine/musl）解压并运行 `start-local-coach`。
3. Runtime 只在 `http://127.0.0.1:43127` 启动配对桥，并打开正式 Pages。若浏览器没有自动打开，可手动打开上面的 Pages 链接。
4. 在 Pages 点击“连接本机 Agent”。新窗口会显示 Runtime 自己的确认页；点击“允许并返回私教页面”，再按浏览器提示允许访问本地网络。
5. 回到同一个 Pages 页面，从 Runtime 实际检查为“可用”的 Agent 中选择一个。答题仍由固定答案键批改；提交后才会追加 Agent 的个性化讲解，也可以继续追问。

不需要 clone 仓库、安装 npm 包或编译源码。当前 macOS 包是未 notarize 的开源预览版；ad-hoc 签名只用于完整性检查，不代表 Developer ID 或 Apple 背书。首次启动可先在 Finder 中右键应用并选择“打开”；若仍被拦，请先尝试启动一次，再到“系统设置 → 隐私与安全 → 仍要打开”，详见 [Apple 官方说明](https://support.apple.com/102445)。

## 浏览器支持与降级

当前配对主路径是桌面 Chrome/Edge。公开 HTTPS 页面访问本机 loopback 时，浏览器可能显示本地网络访问许可；只有用户点击连接才会请求固定确认页，只有确认后才会调用受保护 API。拒绝许可不会影响基础私教。Chrome 的权限模型说明见 [Local Network Access](https://developer.chrome.com/blog/local-network-access)。

- Safari、Firefox 或受管浏览器如果拦截 HTTPS → HTTP loopback，页面会保留 `content-only`，不会丢失或改写进度；需要 Agent 时请改用支持该路径的桌面浏览器。
- 手机或平板中的 `127.0.0.1` 是移动设备自身，不是运行 Runtime 的电脑；移动端只能使用基础私教。
- Runtime 不会为了兼容移动端而监听 LAN 地址，也不支持把端口暴露给局域网或公网。

## 配对协议与记忆

Pages 加载时不会探测本机端口。用户点击连接后，页面才打开固定的 `http://127.0.0.1:43127/pair.html`；这个由 Runtime 提供的页面要求用户再次确认，并通过同源 `/v1/bootstrap` 取得一个绑定到精确 Pages Origin 的短期 Bearer。授权消息只发回发起配对的窗口，接收方还会校验 popup 来源、窗口引用、随机 state、协议版本和 Runtime 实例。

明文 Bearer 在浏览器侧只短暂经过确认页的 JavaScript 对象，之后只留在 Pages 的 JavaScript 私有字段；Runtime 只保留其摘要与绑定 Origin。它不进入 URL、DOM、IndexedDB、`localStorage`、`sessionStorage`、导出文件或日志；刷新 Pages 或重启 Runtime 后需要重新配对。后续跨 Origin API 只允许精确的 `https://peterguy326.github.io`，不使用 wildcard CORS 或 cookie credentials。

配对窗口不读取、不复制也不保存学习档案。切换 Agent 只改变讲解引擎，不会清空当前题目、session revision、attempt 或进度；这些数据始终留在 Pages Origin 的 IndexedDB，因此正常使用不需要在 Pages 与 Runtime 之间导出、导入或合并档案。导出仍只用于用户主动备份或换浏览器。

## Agent 与凭证

Runtime 不会把 Agent CLI 一起打包，也不会从网页收集 API Key。Digital Employee 会探测本机已有的 Host，并要求 Runtime 进程环境中存在对应服务凭证；“安装了 CLI”不等于“可选择”，最终以员工包级 preflight 为准。

| Agent | 当前执行边界 |
|---|---|
| Claude Code | 有执行 Adapter；还需兼容版本、`ANTHROPIC_API_KEY` 与员工包级 preflight 通过 |
| Qwen Code | 有执行 Adapter；还需 `0.17.1`、`OPENAI_API_KEY`、`OPENAI_MODEL` 与 preflight 通过 |
| CodeBuddy | 有执行 Adapter；还需 `2.106.4`、`CODEBUDDY_API_KEY`、`CODEBUDDY_MODEL` 与 preflight 通过 |
| Qoder | 不可选择；当前 Adapter 缺少本员工包要求的 `structured_output` 能力 |
| Codex | 不可选择；Digital Employee `0.3.0` 目前只有 probe-only Adapter |
| Hermes Agent（Nous Research） | 不可选择；当前只以 `hermes --version` 探测安装状态，执行 Adapter 尚未实现 |

预览版只读取启动环境，不提供网页密钥表单。不要把 Key 放进 URL、聊天内容、仓库文件或命令参数；请使用自己信任的本机凭证管理方式先建立 Runtime 的环境，再启动应用。后续正式安装器应接入操作系统 Keychain/Credential Manager。

## 信任边界

- Runtime 只绑定 IPv4 loopback `127.0.0.1`，拒绝 `localhost`、LAN Host、代理头和非白名单 Origin。
- bootstrap 只允许 Runtime 自己的确认页调用；Pages 不能直接为自己签发授权。
- API 请求不能选择可执行文件、目录、环境变量、身份或模型密钥。
- 出题不调用 Agent；提交后先完成可信判分与进度事务，再调用 Agent。
- Agent 输出必须通过员工包 Schema、动作、答案门和可信判定一致性检查；Runtime 只返回有界 coaching text，丢弃所有进度事件提案。
- 模型失败不会回滚或重复提交学习进度；Runtime 停止后所有内存授权立即失效。

## 源码开发

开发者可以在依赖已安装的仓库中运行：

```bash
npm run runtime -- --open
```

默认端口为 `43127`。`--open` 只允许打开精确的正式 Pages URL，不能用来启动任意 URL 或 shell 命令。源码入口只用于开发；考生应使用 Release 中的自包含预览包。
