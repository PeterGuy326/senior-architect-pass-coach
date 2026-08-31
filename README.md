# 系统架构设计师过线私教

> Agent 就是入口。网页最多负责考试，不再在远端或本地 Runtime 中包装另一层 Agent。

## 现在怎么用

真正可用的题库、进度协议、Agent 指令和本地考试终端统一放在：

**[PeterGuy326/senior-software-architect-review](https://github.com/PeterGuy326/senior-software-architect-review)**

1. Clone 或在 Codex、Claude Code、Qwen Code 等支持本地仓库的 Agent 中打开该仓库。
2. 直接说：`开始私教，我只求考过。`
3. Agent 会检查本机 `.study/`；没有进度就先建档和诊断，有进度就继续到期错题和当前瓶颈。
4. 需要整卷时说：`启动综合模拟考试。`

也可以在复习仓库根目录手动启动考试页：

```bash
python3 scripts/serve.py
```

然后打开 <http://localhost:8420>。考试页提供 75 题、150 分钟的高频综合模拟卷；交卷后的逐题答案、用时和错因只写入本机 `.study/`，当前 Agent 可直接读取并继续教学。

## 产品边界

```text
Codex / Claude Code / Qwen Code / 其他本地 Agent
                         │
                         ▼
       senior-software-architect-review
       题库 + 教师规范 + 进度引擎
                         │
                  可选启动考试页
                         ▼
              127.0.0.1:8420
                         │
                         ▼
               .study/ 私人证据
                         │
                         └──── 回到同一个 Agent
```

- 不要求下载 Local Agent Runtime。
- 网页不接收 API Key，不代理或调用模型。
- 私人档案、作答、错题和论文素材不上传 GitHub。
- Agent 只根据真实作答和跨日复测更新掌握度，不靠聊天印象宣布“已掌握”。
- 目标是综合、案例、论文分别达到 45 分；日常以 52 分为安全目标。

## 本仓库的状态

[GitHub Pages](https://peterguy326.github.io/senior-architect-pass-coach/) 现在只是 Agent-first 使用说明，不再作为聊天、建档、判分或进度存储入口。

此前的 Browser Conversation Harness、Digital Employee 员工包、Node 进度引擎和 Local Agent Runtime 源码暂时保留，供历史审计与方案复盘；它们不再是推荐产品路径，也不再自动构建新的 Runtime Release。历史设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/LOCAL_RUNTIME.md`](docs/LOCAL_RUNTIME.md)。

## 为什么调整

原方案为不同 Agent 再包了一层 Runtime 和浏览器 Harness，带来了安装、配对、跨 Origin、档案双份和模型兼容成本。新的边界更直接：

- 用户已经在 Codex、Claude Code 或 Qwen Code 中，不需要再次选择“大脑”；
- 复习仓库本身就是可移植的教师上下文；
- 本地考试页擅长稳定作答和确定性判分；
- `.study/` 是所有本地 Agent 都能读取的统一私人事实来源。

## 开发与历史代码验证

历史实现仍可执行完整检查：

```bash
npm ci
npm run check
```

本仓库采用 [Apache License 2.0](LICENSE)。公开复习资料仓库的授权状态以其自身声明为准。
