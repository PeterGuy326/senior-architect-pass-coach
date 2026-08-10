# 来源与许可证边界

## 本仓库原创部分

本仓库的 Workbench、确定性进度引擎、员工包契约、课程调度索引和原创文档以 Apache-2.0 发布。

## Digital Employee

`@fullstack-ai-infra/digital-employee` `0.3.0` 是 Apache-2.0 的独立 npm 依赖。本仓库通过其公开 API 做员工包校验、离线评测与显式选择的 Agent Host 执行，没有复制框架源代码，也不改变其作者归属。详见根目录 `NOTICE`。

## 公开复习资料

[senior-software-architect-review](https://github.com/PeterGuy326/senior-software-architect-review) 是用户可自行获取的外部复习资料源。截至本项目建立时，该仓库没有声明 LICENSE；“公开可访问”不等于获得再分发许可。

因此本仓库：

- 不复制或再分发其题库、答案解析、论文范文和其他正文；
- 不把外部内容打进 npm 包、员工包 assets 或测试 fixture；
- 只允许用户通过 `--content-dir` 指向自己取得的本地 clone；
- 运行时把材料标记为 `user-supplied-local-review-material`，题块摘要绑定本次会话；该标记不声称 CLI 已验证 Git origin 或 HEAD；
- 作答前只抽取当前一道题的公开题面；提交后参考答案和解析会作为已展示反馈写入 owner-only 私人会话，显式 `agent-host` 模式也会把它们交给所选 Host，但它们不会写入本仓库或员工包；
- 只维护独立创作的稳定考点索引和资源相对路径；
- 不以本仓库 Apache-2.0 声明覆盖外部资料。

若外部仓库未来增加许可证，应在重新核对其条款后再决定是否改变集成方式。
