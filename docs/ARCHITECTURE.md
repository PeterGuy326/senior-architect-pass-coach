# 架构与信任边界

产品有三个入口：无需安装的静态 Web Chatbot、同源托管同一页面的 Local Agent Runtime，以及面向开发者和连接器的本地 Node CLI Conversation Harness。它们共享 45/52、每日最多 3 项、三态判分和答案门规则；当前不是多用户在线平台。

## 组件

### `docs/`

可直接由 GitHub Pages 托管的零构建静态应用。浏览器端 `content-only` Harness 负责聊天状态、每日任务和确定性进度；Dedicated Worker 从白名单中的固定题库 commit 读取题目，作答前只向主线程返回题干与选项，提交后才返回参考答案与解析。

个人档案、派生进度、无题文作答证据和最小会话状态以一个 IndexedDB 事务原子提交。刷新时只读恢复档案和派生进度，不持久化 active question、原始 response、题干、选项、答案或解析。案例与论文在 Web MVP 中保持未测量。

直接从 GitHub Pages 打开时不运行 Agent Host，也不要求 API Key。浏览器不会自动探测 localhost；基础私教在 Runtime 不存在、断开或模型失败时仍可完整出题、判分和保存进度。

### Local Agent Runtime

Runtime 只绑定 `127.0.0.1`，并同源托管 `docs/` 页面。页面在用户显式点击后获得仅存于内存的短期 Bearer，再读取员工包级 Adapter preflight；浏览器不能提交命令、路径、环境变量、模型密钥或用户身份。Codex 的 probe-only、Qoder 的结构化输出不兼容、缺少凭证与真正可选状态分别展示，不能把“安装了 CLI”冒充成“可以运行”。

Agent 增强采用 Hybrid Harness，而不是建立第二份学习档案：

1. Browser Harness 仍是档案、选题、可信判分、attempt 和派生进度的唯一写入者；
2. 出题不调用模型，提交前不向 Agent 请求答案；
3. 提交后先在一个 IndexedDB 事务中保存可信判分和进度；
4. 再把当前公开题面、可信判定与去标识化学习摘要发给 Runtime；
5. Runtime 通过 Digital Employee 的 one-shot Host 执行员工包，完整验证输出后只返回有界的 `teaching_result.summary`；
6. 模型失败只会缺少本轮生成式讲解，不会回滚、重复或改写已经提交的进度。

Adapter 是可替换的“讲解引擎”，员工身份和记忆仍属于 Harness。切换 Claude、Qwen、CodeBuddy 或退回 `content-only` 只改变下一轮 execution preference，不改变当前题目、session revision、attempt 或进度。自然语言追问同样只读取有界上下文，不具有进度写权限。

GitHub Pages 与 `127.0.0.1` 是不同 Origin，因此各自拥有独立 IndexedDB。首次从 Pages 迁移到 Runtime 必须由用户主动导出、导入无题文档案；系统不会尝试跨 Origin 偷读或声称已经同步。迁移后，各 Agent 都在同一个 Runtime Origin 上复用同一档案。

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

CLI REPL 和 `session turn --json` 都调用同一个 `LearningConversationHarness`。机器入口额外要求 session revision、active item 和渠道 delivery turn ID，并持久化有界请求摘要/结果收据；未来钉钉、飞书 Adapter 只负责认证、标准化消息和渲染，不拥有学习流程。静态 Web 和 Local Agent UI 使用同一个浏览器存储 Adapter，不冒充具备服务端认证语义的渠道入口。Local Agent Bridge 是只读 coaching 执行层，不接管或复制浏览器档案。

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
- 已签名、notarized 与自动更新的正式桌面安装器（当前 Release 是无需编译的预览包）；
- 案例与论文的可信 Rubric 收据闭环（首期只写入客观题证据）；
- Codex 可运行 Adapter（当前仅 probe-only）。

这些能力未来若实现，必须保留相同的默认拒绝和数据最小化边界。
