# 架构与信任边界

产品只有一个考生主入口：GitHub Pages 上无需安装的静态 Web Chatbot。用户可选启动 Local Agent Runtime，让同一个 Pages 页面获得本机 Agent 讲解；Runtime 是 loopback 配对与执行桥，不是第二个学习站点。面向开发者和未来连接器的本地 Node CLI Conversation Harness 是另一种集成接口。它们共享 45/52、每日最多 3 项、三态判分和答案门规则；当前不是多用户在线平台。

## 组件

### `docs/`

可直接由 GitHub Pages 托管的零构建静态应用。浏览器端 `content-only` Harness 负责聊天状态、每日任务和确定性进度；Dedicated Worker 从白名单中的固定题库 commit 读取题目，作答前只向主线程返回题干与选项，提交后才返回参考答案与解析。

个人档案、派生进度、无题文作答证据和最小会话状态以一个 IndexedDB 事务原子提交。作答行为模块用单调时钟累计前台有效用时、首次选择和有界改选次数；多选构造不算改选，失焦/隐藏/刷新后的残缺计时不作熟练判断。行为信号不改写固定答案键的客观判分，只能降低稳定证据等级并提前复测；只有答对且明确选择 `sure` 的无风险证据才能累计过线状态，`unsure/guess` 永远不会被用时升级。刷新时只读恢复档案和派生进度，不持久化 active question、原始 response、题干、选项、答案或解析。案例与论文在 Web MVP 中保持未测量。

直接打开 GitHub Pages 时默认不运行 Agent Host，也不要求 API Key。浏览器不会自动探测 localhost；只有用户点击“连接本机 Agent”后，才会打开固定 loopback 确认页并请求浏览器的本地网络访问许可。Runtime 不存在、浏览器不支持、用户拒绝许可、连接断开或模型失败时，基础私教仍可完整出题、判分和保存进度。

### Local Agent Runtime

Runtime 只绑定 `127.0.0.1`。受支持的产品路径把它用作确认页和受保护 API：启动包的 `--open` 只打开精确的正式 Pages URL；用户从 Pages 发起配对，本机 `pair.html` 再显式确认授权。公开页面不能直接调用 bootstrap，也不能提交命令、路径、环境变量、模型密钥或用户身份。

配对采用 capability grant，而不是 cookie session：

1. Pages 在用户手势中生成随机 state，并打开固定的 loopback 确认页；
2. 确认页由 Runtime 同源调用 `/v1/bootstrap`，请求一个绑定到精确 Pages Origin 的短期 Bearer；
3. 确认页用精确目标 Origin 的 `postMessage` 将 grant 发回 opener；
4. Pages 校验消息来源、窗口引用、state、协议版本、token 格式和 Runtime instance，再把 Bearer 放入 JavaScript 私有字段；
5. 后续 `/v1/adapters`、preflight 和 `/v1/coach` 只接受精确 Pages Origin、匹配协议头和该 Origin 的 Bearer。CORS 不使用 `*` 或 cookie credentials。

该流程避免页面加载即扫描本机服务，也不把授权写进 URL、DOM、浏览器存储、导出或日志。Runtime 重启或 Pages 刷新后必须重新配对。桌面 Chrome/Edge 是当前主路径；Safari、Firefox、受管浏览器和移动端不满足 loopback 访问条件时降级到 `content-only`，Runtime 不监听 LAN 地址绕过浏览器边界。

Adapter preflight 会分别展示缺少凭证、安装状态和真正可选状态，不能把“安装了 CLI”冒充成“可以运行”。Claude Code、Qwen Code 和 CodeBuddy 只有在员工包级检查通过时才可选；Qoder 因缺少 `structured_output` 不可选；Codex 在 Digital Employee `0.3.0` 中仍是 probe-only；Hermes Agent 指 Nous Research 的 Hermes Agent，当前也仅以 `hermes --version` 探测，执行 Adapter 尚未实现。

为了让本案例现在可以验证 Codex 体验，Runtime 另有一个不注册进 Digital Employee Host Registry 的 `codex-personal-experimental` 分支。它只有在本机版本与登录探测成功、且当前 Bearer 得到二次明确同意后才可选。提交轮的模型输入不含题干、选项、作答、参考答案或解析，只含科目、考点、掌握结果和去身份化进度；一次性 `codex exec` 也只能返回枚举化 `{coaching_plan}`，再由本地模板生成 summary。无题面复习轮才允许 `{coaching_text}`。判分、反馈与 proposal-only 事件始终由本地受信输入构造，并经过员工包 Schema、动作门和可信事实一致性校验。它持续对外报告 `framework_adapter_status: probe_only`，未来框架具备合格 Codex Adapter 后可直接删去这条案例级分支。

Agent 增强采用 Hybrid Harness，而不是建立第二份学习档案：

1. Browser Harness 仍是档案、选题、可信判分、attempt 和派生进度的唯一写入者；
2. 出题不调用模型，提交前不向 Agent 请求答案；
3. 提交后先在一个 IndexedDB 事务中保存可信判分和进度；
4. 再把当前公开题面、可信判定与去标识化学习摘要发给 Runtime；
5. Runtime 通常通过 Digital Employee 的 one-shot Host 执行员工包；Codex 个人实验模式会在 Runtime 内再次缩减为科目、考点、掌握结果和去身份化进度，只接收枚举化 plan，再由受信本地模板组装同一输出契约；两条路径都完整验证后只返回有界 summary；
6. 模型失败只会缺少本轮生成式讲解，不会回滚、重复或改写已经提交的进度。

Adapter 是可替换的“讲解引擎”，员工身份和记忆仍属于 Pages Harness。切换 Claude、Qwen、CodeBuddy 或退回 `content-only` 只改变下一轮 execution preference，不改变当前题目、session revision、attempt 或进度。自然语言追问同样只读取有界上下文，不具有进度写权限。

GitHub Pages 与 `127.0.0.1` 是不同 Origin，但 loopback 页面只负责授权，不拥有学习 IndexedDB。所有 Agent 在同一个 Pages 页面复用同一档案，正常使用不存在 Pages → Runtime 档案迁移。导出、导入仍可用于用户主动备份或换浏览器，不用于 Agent 配对。

### `progress_engine/`

无网络、确定性的 Python 状态机。它保存三科证据、稳定考点、复习到期时间和过线优先级；相同事件 ID 可安全重试。公开资料通过 `--content-dir` 只读接入，私人状态通过 `--data-dir` 独立存放。

公开资料由用户自行 clone；本仓库只保存最小课程索引，不复制外部题库内容。来源和许可证边界见 [PROVENANCE](PROVENANCE.md)。

### `employee/senior-architect-pass-coach/`

符合 Digital Employee `employee-package.v1alpha1` 的只读员工包。它定义教师角色、输入输出 Schema 和离线 eval。员工包不能直接写文件或调用进度引擎；输出中的事件始终是 proposal-only。

### `service/`

本地可信外层。它负责：

1. 建立并校验本地授权上下文；
2. 读取进度引擎 JSON，并只选择非身份字段；
3. 把最多 3 项推荐组成去标识化快照；
4. 从用户提供的题库 clone 中按稳定考点选取客观题，并把答案密封在进程内；
5. 用 Conversation Harness 保存 active item、控制答案门并重新注入 one-shot Host；
6. 用本地 Trusted Grader 判分，校验员工包返回的反馈与提议；
7. 将提议与模型不可见的授权逐项匹配；
8. 全部校验通过后，才调用进度引擎写入；
9. 用 `0600` 不可变 revision 文件和原子 hard-link CAS 保存恢复点；同一 revision 只有一个发布者能成功。

## CLI 会话与渠道

CLI REPL 和 `session turn --json` 都调用同一个 `LearningConversationHarness`。机器入口额外要求 session revision、active item 和渠道 delivery turn ID，并持久化有界请求摘要/结果收据；未来钉钉、飞书 Adapter 只负责认证、标准化消息和渲染，不拥有学习流程。静态 Web 使用浏览器存储 Adapter，不冒充具备服务端认证语义的渠道入口。Local Agent Bridge 是只读 coaching 执行层，不接管或复制浏览器档案。

Digital Employee `0.3.0` 的 Agent-native Host 是 one-shot。Harness 因此不依赖 Host session，而在每轮显式重新注入：

- 当前题目的完整公开题面；
- 本轮提交；
- 有界的 `approved_materials`；
- 去标识化进度快照。

作答前的 Host 输出必须原样回显受信 active item。任何改写、答案标记、提前反馈或进度提议都会在发送给渠道前被拒绝。

## 判题与中断

作答前，客观题正确答案只存在于 Content Provider 的进程内密封 bundle。提交后，Trusted Grader 会把参考答案与解析作为本轮受信材料交给显式选择的 runner，并把已经展示的反馈写入 owner-only 私人会话；模型输出与受信判定任一关键字段不一致时不写进度。

提交事务的最小阶段为：

```text
evaluation_started → commit_started → feedback
                     ↘ indeterminate
```

一旦进度 commit 已开始，异常或崩溃会恢复为 `indeterminate`，禁止自动重答。对应机器收据会终结为 `TURN_RESULT_INDETERMINATE`；所有者核对本地进度后可以显式关闭并归档会话，但不能继续该轮。当前版本选择 fail-closed；以后只有进度引擎提供按 attempt ID 查询的确定性收据后，才可自动消解该状态。

## 三道门

本项目采用通用推荐、授权、结果三态思想：

- 推荐：确定性引擎决定“下一步最值得学什么”；可信反馈来自受信题库解析，Agent 只补充不改变排课的个性化 coaching text；
- 授权：匿名只能通用诊断，个人状态需要本地授权；
- 结果：智能体只能返回完成、需要补充或拒绝，不能声称已经改变状态。

这三道门分别防止推荐漂移、跨用户读取和模型越权写入。

## 提议提交协议

Harness 与 Workbench 在调用员工包前生成两份对象：

- `input`：允许交给员工包的去标识化输入；
- `trustedAuthorizations`：只留在本地外层、由 Trusted Grader 产生的允许执行命令。渠道和调用者不能提供它。

员工包返回后，外层先完整验证所有提议，再开始第一笔写入。若进程在多笔写入之间中断，稳定的 attempt/mock ID 保证重试不会制造重复证据。

模型输出中的 `user_id`、数据目录、分数参数或“已写状态”声明不会被采信；真正的写入参数只来自 `trustedAuthorizations`。

## 当前没有的能力

- 多用户注册、登录、租户隔离和服务端数据库；
- 云同步、服务端 API 与运营后台；
- 钉钉、飞书的正式 Adapter；
- 托管 Agent Host 和线上模型凭证管理；
- 无安装的浏览器内模型执行；Local Agent 必须运行用户明确启动的本机 Runtime；
- Safari、Firefox 或移动端到电脑 Runtime 的兼容桥；不支持时保留 `content-only`；
- 已签名、notarized 与自动更新的正式桌面安装器（当前 Release 是无需编译的预览包）；
- 案例与论文的可信 Rubric 收据闭环（首期只写入客观题证据）；
- Digital Employee 合格 Codex Adapter（当前框架仅 probe-only；案例级个人实验 Runner 不等同于该能力）；
- Hermes Agent（Nous Research）可运行 Adapter（当前仅探测可执行文件）。

这些能力未来若实现，必须保留相同的默认拒绝和数据最小化边界。
