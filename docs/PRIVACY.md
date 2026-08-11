# 隐私边界

## 默认不收集

当前版本没有遥测、云端账号或项目自建的云端学习接口。网页 `content-only` 不上传用户问题、答案、错题或学习状态；任务安排、判分与进度写入都在浏览器内完成。浏览器会从 `raw.githubusercontent.com` 读取固定 commit 的公开题库文件，因此 GitHub 作为内容托管方会看到普通网络请求元数据（例如 IP、User-Agent）；请求不携带私人档案、作答或学习进度，也不使用 GitHub API。

网页的个人档案、派生进度、无题文作答证据和最小会话状态只存于当前站点的 IndexedDB。网页不持久化题干、选项、原始 response、参考答案或解析；Service Worker 只缓存本项目同源静态文件，不缓存外部题库正文。用户可以主动导出/导入无题文 JSON 档案，或在页面中一键清除当前浏览器数据。

纯静态网页只能提供教学体验上的答案门：作答前不把答案放进页面 DOM 或主线程状态。它无法阻止设备所有者用开发者工具查看网络响应或修改 IndexedDB，因此不把客户端存储宣称为防篡改、认证或真正的答案保密边界；若未来需要这些能力，必须引入明确披露的服务端。

用户显式连接 Local Agent Runtime 并选择兼容引擎时，本轮去标识化进度摘要、自然语言追问和必要的公开题面会交给所选 Agent Host 及其配置的模型服务；提交后，本地判题产生的作答、参考答案和解析也会作为受信材料进入该轮。是否离开本机取决于该 Host 的模型服务和账号配置。系统不会静默从 `content-only` 切换到模型模式，Agent 失败也不会改写或回滚浏览器进度。

Runtime API 只监听 `127.0.0.1`。Pages 加载时不会扫描本机端口；只有用户点击“连接本机 Agent”后，才会打开 Runtime 自己的确认页。bootstrap 只允许该 loopback 同源确认页调用，签发的 Bearer 绑定到精确的正式 Pages Origin；确认页通过带随机 state、精确目标 Origin 的 `postMessage` 发回授权，Pages 还会校验消息来源、窗口引用、协议版本、token 格式和 Runtime instance。后续 CORS 不使用 `*` 或 cookie credentials。

明文 Bearer 在浏览器侧只短暂经过确认页的 JavaScript 对象，之后只留在 Pages 的 JavaScript 私有字段；Runtime 只保留其摘要与绑定 Origin。它不进入 URL、DOM、IndexedDB、`localStorage`、`sessionStorage`、导出档案或日志，刷新页面或 Runtime 重启后失效。网页不能读取或提交模型 API Key，首个预览版只从 Runtime 启动环境读取 Adapter 所需服务凭证。Runtime 不持久化模型回复或建立第二份学习档案。

GitHub Pages 与 Runtime 确认页是不同 Origin，浏览器会隔离两边的 IndexedDB。确认页不读取、复制或保存学习档案；所有题目、作答和进度继续保存在原 Pages Origin，因此 Agent 配对不需要档案导出、导入或合并。导出仍只用于用户主动备份或换浏览器。

桌面 Chrome/Edge 是当前 Agent 配对主路径。Safari、Firefox、受管浏览器或移动端如果阻止公开 HTTPS 页面访问本机 HTTP loopback，会保留 `content-only`，不改写已有状态。移动设备的 `127.0.0.1` 指向设备自身，Runtime 也不会监听 LAN 地址来绕过浏览器和网络边界。

`npm install` 会连接用户配置的 npm registry；这属于依赖安装，不是学习数据上传。`validate-package` 和 `eval-package` 本身离线运行，不调用模型。

## CLI 私人数据位置

私人档案默认位于操作系统用户数据目录。CLI 会拒绝任何位于本代码仓库内的 `--data-dir`，避免个人数据被误提交、打包或发布。

本地授权和不可变会话 revision 文件权限在 POSIX 系统上必须为 `0600`，目录为 `0700`，且不能是符号链接。它们只用来证明当前本地上下文获得了私人状态访问权；其中的本地 ID 永远不会进入员工包输入。

会话快照保存公开题面、只含摘要的内容引用、状态和提交后已经展示的反馈（其中可含参考答案与解析），用于恢复；禁止持久化原始 `response`、密封答案 bundle 和 `trustedAuthorization`。中断判题只保存 attempt key 与阶段，不保存作答正文。所有会话文件均为 owner-only，且不会写入 Git 仓库。

## 去标识化快照

允许进入员工包的快照采用字段白名单，只包含：

- 三科的证据级别、状态和分数统计；
- 当前优先科、考前三天模式等调度信号；
- 最多 3 个稳定考点 ID、能力维度和数值优先级。

禁止字段包括用户 ID、姓名、邮箱、背景自由文本、本地目录、资料路径和原始状态文档。资料标题和自由文本推荐理由也不进入快照。

## 匿名边界

没有本地授权上下文时，只能做不读取个人状态的通用诊断。匿名结果必须是 general scope，且 `proposed_progress_events` 必须为空。

## 删除数据

当前没有云端副本。网页用户可点击“清除本机数据”，也可通过浏览器的网站数据设置删除；CLI 用户可以在停止 CLI 后删除自己的用户数据目录。删除前如需保留网页进度，应先主动导出档案。代码仓库不包含可用于恢复私人状态的副本。
