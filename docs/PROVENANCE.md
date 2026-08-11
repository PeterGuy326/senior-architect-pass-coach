# 来源与许可证边界

## 本仓库原创部分

本仓库的 Workbench、确定性进度引擎、员工包契约、课程调度索引和原创文档以 Apache-2.0 发布。

## Digital Employee

`@fullstack-ai-infra/digital-employee` `0.3.0` 是 Apache-2.0 的独立 npm 依赖。本仓库通过其公开 API 做员工包校验、离线评测与显式选择的 Agent Host 执行，没有复制框架源代码，也不改变其作者归属。预编译 Local Runtime 预览包会包含锁定后的 npm 依赖和 Node 运行时，仍保留各自许可证与 `NOTICE`。Claude Code、Qwen Code、CodeBuddy、Qoder、Codex 与 Hermes Agent（Nous Research）等外部 CLI 均由用户系统提供，不会被本项目未经许可打进安装包；其中 Hermes 当前只探测可执行文件，尚无执行 Adapter。详见根目录 `NOTICE`。

## 公开复习资料

[senior-software-architect-review](https://github.com/PeterGuy326/senior-software-architect-review) 是用户可自行获取的外部复习资料源。截至本项目建立时，该仓库没有声明 LICENSE；“公开可访问”不等于获得再分发许可。

因此本仓库：

- 不复制或再分发其题库、答案解析、论文范文和其他正文；
- 不把外部内容打进 npm 包、员工包 assets 或测试 fixture；
- Web 入口只允许浏览器从 `docs/data/content-source.json` 白名单中的固定 commit 和七份综合卷读取，不使用可漂移分支或 GitHub API，也不把外部题库写进 Cache Storage；
- GitHub Pages 是唯一学习主入口；Local Agent Runtime 只提供 loopback 配对确认与 Agent API，仍由 Pages 浏览器从固定来源按需读取；Runtime 预览包不含外部题库、答案或解析；
- Web 入口把外部材料明确标记为 `NOASSERTION`，本项目许可证不覆盖它；题块只在 Worker 内存中解析，作答前主线程只得到当前题干与选项；
- CLI 入口只允许用户通过 `--content-dir` 指向自己取得的本地 clone；
- 运行时把材料标记为 `user-supplied-local-review-material`，题块摘要绑定本次会话；该标记不声称 CLI 已验证 Git origin 或 HEAD；
- 作答前只抽取当前一道题的公开题面；提交后参考答案和解析会作为已展示反馈写入 owner-only 私人会话，显式 `agent-host` 模式也会把它们交给所选 Host，但它们不会写入本仓库或员工包；
- 只维护独立创作的稳定考点索引和资源相对路径；
- 不以本仓库 Apache-2.0 声明覆盖外部资料。

若外部仓库未来增加许可证，应在重新核对其条款后再决定是否改变集成方式。
