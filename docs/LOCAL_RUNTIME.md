# Local Agent Runtime 使用说明

Local Agent Runtime 是“架构过线私教”的本机配对与 Agent 执行桥。考生始终在 [GitHub Pages](https://peterguy326.github.io/senior-architect-pass-coach/) 学习；Runtime 不建立第二个学习入口，也不保存第二份档案。学习档案、可信判分和进度仍由该 Pages Origin 的浏览器 Harness 写入，Digital Employee `0.3.0` 只负责运行用户明确选择且通过检查的 Agent。

## 考生使用

1. 从 [GitHub Releases](https://github.com/PeterGuy326/senior-architect-pass-coach/releases) 下载系统对应的预览包；需要核验下载完整性时，对照同一 Release 的 `SHA256SUMS`。
2. macOS 解压并打开 `Senior Architect Pass Coach.app`；Linux x64（glibc 2.28+，不适用于 Alpine/musl）解压并运行 `start-local-coach`。
3. macOS 首次解压后打开一次 `.app`，让系统登记 `senior-architect-pass-coach://` 启动入口。它是固定、无参数的 launch-only 信号；应用启动器忽略系统传入的全部参数，网页不会在这里放令牌、配对 state、命令、URL 或文件路径。Runtime 仍只监听 `http://127.0.0.1:43127`。
4. 在 Pages 的私教大脑面板里直接点击目标 Agent 卡片。网页会在这次点击内探测固定健康端点：已经运行就直接配对；macOS 没有运行时才用上面的固定入口唤起应用并短暂等待，Linux 必须先手工运行 `start-local-coach`。只有健康响应同时匹配协议、状态和实例标识后，等待窗口才会进入 Runtime 自己的确认页。点击“允许并返回私教页面”，再按浏览器提示允许访问本地网络；目标 Agent 通过检查后会自动进入对话。
5. Runtime 先用 Digital Employee 密封一份只读员工工作区，并将员工名、版本和 digest 返回给 Page；Schema 校验、兼容性探测和执行都绑定到该工作区。
6. Runtime 只会激活刚才点击且实际检查为“可用”的 Agent，不会回退到其他模型。Codex 会先显示“需要本人同意”，确认复用本机 Codex / ChatGPT 登录后才进入对话。答题仍由固定答案键批改；提交后才会追加 Agent 的个性化讲解，也可以继续追问。
7. Codex 连接后可选择“快速 / 均衡 / 深入”档位。页面只显示本机 Codex 当次实际认证通过的项目；切换只影响下一轮，不改学习档案。对话与批改期间会显示可验证执行阶段和真实耗时，但不会展示模型内部思维链。输入框 Enter 发送、Shift+Enter 换行，中文输入法组合态不会误发。

不需要 clone 仓库、安装 npm 包或编译源码。当前 macOS 包是未 notarize 的开源预览版；ad-hoc 签名只用于完整性检查，不代表 Developer ID 或 Apple 背书。首次启动可先在 Finder 中右键应用并选择“打开”；若仍被拦，请先尝试启动一次，再到“系统设置 → 隐私与安全 → 仍要打开”，详见 [Apple 官方说明](https://support.apple.com/102445)。

## 浏览器支持与降级

当前配对主路径是桌面 Chrome/Edge。公开 HTTPS 页面访问本机 loopback 时，浏览器可能显示本地网络访问许可；只有用户点击连接才会请求固定确认页，只有确认后才会调用受保护 API。拒绝许可不会影响基础私教。Chrome 的权限模型说明见 [Local Network Access](https://developer.chrome.com/blog/local-network-access)。

- Safari、Firefox 或受管浏览器如果拦截 HTTPS → HTTP loopback，页面会保留 `content-only`，不会丢失或改写进度；需要 Agent 时请改用支持该路径的桌面浏览器。
- 手机或平板中的 `127.0.0.1` 是移动设备自身，不是运行 Runtime 的电脑；移动端只能使用基础私教。
- Runtime 不会为了兼容移动端而监听 LAN 地址，也不支持把端口暴露给局域网或公网。

## 配对协议与记忆

Pages 加载时不会探测本机端口。用户点击连接后，页面同步保留一个不含秘密的等待窗口，再探测固定 `/v1/health`。若 Runtime 未运行，macOS 等待窗口只导航到精确的 `senior-architect-pass-coach://launch`，随后轮询健康状态；Linux 没有注册该入口，需先运行 `start-local-coach`。若超时，会关闭等待窗口并在 Pages 内提示安装或启动，不会把用户送到拒绝连接的 `127.0.0.1` 错误页。若端口被其他服务占用或响应不符合 Runtime 协议，也会停止并明确诊断，不会继续配对。

确认服务身份和就绪后，页面才把同一个窗口导航到固定的 `http://127.0.0.1:43127/pair.html`，并在此时生成随机配对 state。这个由 Runtime 提供的页面要求用户再次确认，并通过同源 `/v1/bootstrap` 取得一个绑定到精确 Pages Origin 的短期 Bearer。授权消息只发回发起配对的窗口，接收方还会校验 popup 来源、窗口引用、随机 state、协议版本和 Runtime 实例。

明文 Bearer 在浏览器侧只短暂经过确认页的 JavaScript 对象，之后只留在 Pages 的 JavaScript 私有字段；Runtime 只保留其摘要与绑定 Origin。它不进入 URL、DOM、IndexedDB、`localStorage`、`sessionStorage`、导出文件或日志；刷新 Pages 或重启 Runtime 后需要重新配对。后续跨 Origin API 只允许精确的 `https://peterguy326.github.io`，不使用 wildcard CORS 或 cookie credentials。

配对窗口不读取、不复制也不保存学习档案。切换 Agent 只改变讲解引擎，不会清空当前题目、session revision、attempt 或进度；这些数据始终留在 Pages Origin 的 IndexedDB，因此正常使用不需要在 Pages 与 Runtime 之间导出、导入或合并档案。导出仍只用于用户主动备份或换浏览器。

Runtime 的工作区绑定格式为 `coach-local-workspace.v1`。它不把本机目录暴露给 Page，只返回固定员工身份、版本和 `sha256:` 摘要。旧 Runtime、错误员工、摘要格式不匹配或带路径的绑定都会被新版 Page 拒绝；重启 Runtime 会重新密封并重新配对。

## Agent 与凭证

Runtime 不会把 Agent CLI 一起打包，也不会从网页收集 API Key。Digital Employee 会探测本机已有的 Host，并要求 Runtime 进程环境中存在对应服务凭证；“安装了 CLI”不等于“可选择”，最终以员工包级 preflight 为准。Codex 是额外、明确标注的个人实验路径，不改变框架探测结论。

| Agent | 当前执行边界 |
|---|---|
| Claude Code | 有执行 Adapter；还需兼容版本、`ANTHROPIC_API_KEY` 与员工包级 preflight 通过 |
| Qwen Code | 有执行 Adapter；还需 `0.17.1`、`OPENAI_API_KEY`、`OPENAI_MODEL` 与 preflight 通过 |
| CodeBuddy | 有执行 Adapter；还需 `2.106.4`、`CODEBUDDY_API_KEY`、`CODEBUDDY_MODEL` 与 preflight 通过 |
| Qoder | 不可选择；当前 Adapter 缺少本员工包要求的 `structured_output` 能力 |
| Codex | Digital Employee `0.3.0` 仍是 probe-only；当前仅开放已审计的 Codex CLI `0.146.0`，且 `codex login status` 有效时，可经当前 Bearer 下的二次同意启用“个人实验模式” |
| Hermes Agent（Nous Research） | 不可选择；当前只以 `hermes --version` 探测安装状态，执行 Adapter 尚未实现 |

预览版只读取启动环境，不提供网页密钥表单。不要把 Key 放进 URL、聊天内容、仓库文件或命令参数；请使用自己信任的本机凭证管理方式先建立 Runtime 的环境，再启动应用。后续正式安装器应接入操作系统 Keychain/Credential Manager。

Codex 个人实验模式不会复制或记录 `auth.json` 内容。每轮只在 owner-only 临时目录放置一个指向现有登录文件的短生命周期链接，以一次性 `codex exec --ephemeral --json --output-schema` 执行；教学 Prompt 经 stdin 发送，不进入命令行参数。它不参与出题。提交后只向模型投影科目、考点、掌握结果和去身份化进度，不发送题干、选项、作答、参考答案或解析；模型只能选择枚举化补救计划，本地模板再生成显示文字。无题面的复习追问才允许有界自由文本。Runtime 会忽略用户规则与配置、禁用已知工具特性、关闭模型工具网络和工作区写入，并拒绝任何工具事件、提交轮自由文本、未知 JSONL 事件、异常 stderr、非零退出或不合格结构化输出。临时目录在本轮结束后清理。

模型档位来自 `codex debug models` 针对本机已保存登录态返回的有界可见目录，并且只接受当前已审计 CLI 版本中 exact model + reasoning effort 同时匹配的项目。Page API 只能发送 `lite / fast / balanced / deep` 档位 ID；不能提交模型 slug、命令参数、endpoint 或 fallback。每轮由 Runner 做一次紧邻执行的完整认证；没有合法档位时 Codex 保持不可选。当前预览依次尝试展示轻量（GPT-5.4 mini / low）、快速（Luna / low）、均衡（Terra / medium）和深入（Sol / low），最终是否显示仍以用户本机当次目录为准。轻量档若从实时目录消失会直接不可用，不会在同一请求里静默换成其他模型。受控同提示冒烟中 Mini 并不比 Luna 快，因此仍以 `fast` 为默认；`lite` 作为用户明确选择的较弱实验档保留，不承诺一定更快。

这仍然是 **unqualified personal experiment**：当前 stock Codex 可以无交互执行，但尚不能向 Digital Employee 证明完整的模型可见工具目录，也不能证明所有内建工具已从目录移除。因此页面会持续显示 `framework_adapter_status: probe_only`，不会把“能运行一次”冒充为合格 Adapter。Codex 请求由用户本机已有账号发往 OpenAI；其处理仍受该账号与 OpenAI 服务条款约束。

## 信任边界

- Runtime 只绑定 IPv4 loopback `127.0.0.1`，拒绝 `localhost`、LAN Host、代理头和非白名单 Origin。
- bootstrap 只允许 Runtime 自己的确认页调用；Pages 不能直接为自己签发授权。
- API 请求不能选择可执行文件、目录、环境变量、身份或模型密钥。
- Codex 的个人模式同意只保存在当前 Bearer 对应的 Runtime 内存中；新配对、刷新或重启不会继承。
- 出题不调用 Agent；提交后先完成可信判分与进度事务，再调用 Agent。
- Agent 输出必须通过员工包 Schema、动作、答案门和可信判定一致性检查；Runtime 只返回有界 coaching text，丢弃所有进度事件提案。
- 模型失败不会回滚或重复提交学习进度；Runtime 停止后所有内存授权立即失效。

## 源码开发

开发者可以在依赖已安装的仓库中运行：

```bash
npm run runtime -- --open
```

默认端口为 `43127`。`--open` 只允许打开精确的正式 Pages URL，不能用来启动任意 URL 或 shell 命令。macOS Release 应用注册的 custom scheme 也只有“启动”语义，启动脚本不会转发 deep link 或其他外部参数。源码入口只用于开发；考生应使用 Release 中的自包含预览包。
