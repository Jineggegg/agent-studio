# 看看 Cloud Harness 能做什么

**把 Agent、项目和日常工具放在一起，换个屏幕也能继续。**

[English](showcase.md) · [安装 Cloud Harness](../../README.zh-CN.md#快速开始) · [所有指南](README.md)

![Cloud Harness 在电脑、平板和手机上的界面](../assets/screenshots/devices.zh-CN.png)

这些截图来自实际运行的应用，使用虚构项目、笔记和邮件。Agent 回复由演示脚本生成，
没有调用真实 Claude、Codex 或模型 API。设备外框用于展示浏览器布局，
不代表真机测试。新安装不会预置演示账号、凭据或外部集成。

## 项目就在手边

![Cloud Harness 主界面，包含项目与各项功能入口](../assets/screenshots/launcher.png)

从主界面进入项目、记忆、收件箱和常用工具。打开项目即可开始对话或回到近期工作。
同一个应用适应手机、平板和电脑窗口的宽度。

![项目工作空间，展示对话与会话侧栏](../assets/screenshots/workspace.png)

**试一试：** 添加项目、选择 Agent，让它解释一个文件或规划一次修改。
跟随流式回答，展开工具调用，在对话里处理审批；需要查看实际工作时，打开文件、Git 或终端。
任务在服务器上运行，浏览器断开后可以重新连接并补齐记录；服务器和 Agent 进程仍需保持运行。

用分组整理相关会话，用**从这里分支**或**编辑后重发**尝试另一个方向。
对话分支不会还原项目文件；符合条件的文本文件检查点提供单独的预览和恢复流程。

[项目操作指南](working-on-projects.md) · [会话、分支与账户](conversations.md)

## 多个模型在一起工作

![模型设置，展示 Anthropic 原生、OpenAI 兼容与本地服务示例](../assets/screenshots/models.png)

通过官方 CLI 使用 Claude Code 和 Codex，也可以接入 Anthropic 原生 Messages API
或 OpenAI 兼容 API。可选模型取决于你的配置和服务商支持；账号和订阅由你自行提供。

![Agent 选择器，展示 CLI 测试配置与脚本演示 Agent](../assets/screenshots/agent-picker.png)

**试一试：** 登录检测到的 CLI，或者在**设置 → 模型**里添加服务商。
新建对话时选择 Agent 和模型。需要隔离不同 CLI 登录时，使用**设置 → 智能体账户**。
希望已有对话交给另一位 Agent 继续，可以使用交接。

[模型配置](providers.md) · [Agent 权限与审批](agents-and-approvals.md)

## 看得见，也能修改的记忆

![共享记忆界面，展示项目决定与全局笔记](../assets/screenshots/memory.png)

一个项目决定只需记下来，下一段对话就能找到。记忆以 Markdown 笔记保存，
你可以查看和编辑。Claude Code、Codex 与支持工具调用的 API 模型使用同一套记忆工具。

**试一试：** 打开**记忆**，在项目文件夹里写一条长期有效的决定，例如约定的测试命令。
开始下一段对话时，请 Agent 先查找这条决定，再规划工作。

每次运行只能在用户权限内访问当前项目和**全局**，不能浏览其他项目的记忆。
Agent 可以阅读其他作者的笔记，但只能修改自己创建的笔记；写入也受当前权限模式约束。
所有者可以关闭 Agent 的记忆访问。

[记忆范围、权限与编辑](memory-automation-notifications.md#shared-memory)

## 让 Agent 接得上彼此的工作

![Agent 交接后的关联会话，继续前一段工作](../assets/screenshots/collaboration.png)

让一位 Agent 先调查，再把发现和下一步交给另一位。交接会在同一个项目里创建关联的新对话，
带上已有工作的简报，并让你填写**给新智能体的留言**。交接两边都会保留可查看的记录。

**试一试：** 等当前回复结束，打开**对话操作（⋯）→ 交给另一个智能体继续…**。
选择接收者和简报方式，留下“请从无障碍使用的角度检查这个方案”等要求，
再选择**我先写**或**立即开始**。交接由你发起，应用不会让 Agent 自行无限来回对话。

![多 Agent 任务，集中展示两位演示 Agent 的各自回答](../assets/screenshots/tasks.png)

需要不同视角时，选择**同时问几个智能体…**，把一个问题交给两到六个 Agent。
答案集中展示，还可以选另一位 Agent 比较结果。共享目录模式只允许规划与读取；
需要修改文件时，所有者可为每位 Agent 分配独立 Git worktree。结果不会自动合并。

[交接与多 Agent 任务](memory-automation-notifications.md#several-agents)

## 把常用工具带进工作流

![工具与技能界面，展示可复用条目和连接管理](../assets/screenshots/tools.png)

把重复提示词保存成斜杠命令，把较长的做事方式保存成技能，或连接一个 MCP 服务。
条目属于你的账号，可用于你的全部项目或某个有权限的项目。

**试一试：** 打开**工具与技能**，创建名为 `review` 的命令，再在对话中输入 `/review`。
较长的流程可以保存为技能。配置 MCP 后，主动选择连接并列出工具；
远程工具调用仍遵循 Agent 的审批流程。

项目中的**应用**提供需确认的静态构建和隔离预览。
图片批注、语音听写、隔离的 Agent 浏览器也可在满足前置条件后使用。

[工具与技能](tools-and-skills.md) · [项目小应用](project-apps.md) · [浏览器、图片与语音](browser-and-media.md)

## 发信前再确认一步

![虚构邮箱，包含演示邮件与本地草稿](../assets/screenshots/mail.png)

浏览文件夹、搜索邮件，在安全的文本视图里阅读内容。先保存本地草稿，
再检查发件账号、收件人和主题，确认后发送。

![虚构邮件在安全文本视图中的阅读界面](../assets/screenshots/mail-reading.png)

**试一试：** 从**邮箱 → 添加账户**进入，按说明配置 Gmail 或 Outlook 的委托 OAuth 凭据。
当前版本需要你提供访问令牌和可选的刷新凭据，没有托管登录服务。
凭据与本地草稿在服务器上加密保存，发送需要单独的检查与确认。

可选邮件摘要需要你的同意，以及所有者配置的本地模型。
图中的邮箱使用虚构邮件和测试传输，没有为截图读取或发送真实邮件。

[邮箱设置与通知渠道](mail-and-channels.md)

## 需要你时，一眼看见

![运行中界面，列出多个演示会话的进度](../assets/screenshots/activity.png)

**运行中**集中展示会话任务，打开一项即可查看记录或停止运行。
**收件箱**汇总待审批、需要处理与已完成的结果。审批仍回到对应对话中进行，方便看到前后文。

**试一试：** 在两个会话里分别开始任务，再从**运行中**进入各自对话。
通过**自动化**配置提醒或定时任务，按需开启通知渠道。无人值守的任务不能替自己批准操作。

[收件箱、计划与通知](memory-automation-notifications.md)

## 用自己的域名，有清楚的操作入口

![域名与访问设置，包含域名输入与部署指引](../assets/screenshots/domain.png)

所有者可从**设置 → 域名与访问**进入，准备 HTTPS 地址、查看当前访问配置，
生成 **Caddy** 或 **Cloudflare Tunnel** 设置片段。
界面负责引导；域名解析、反向代理或隧道配置，以及服务重启仍由你在自己的基础设施上完成。

**试一试：** 输入自己控制的域名，选择支持的接入方式，按照生成的步骤操作。
先设置匹配的公开来源地址与可信代理；让服务保留本机监听，由代理或隧道提供 HTTPS。
最后使用新地址验证登录和实时对话。向导不会自动修改 DNS 或替你部署。

![示例域名对应的 Caddy 与服务器环境配置，可直接复制后按说明应用](../assets/screenshots/domain-setup.png)

[域名与远程访问操作指南](../deployment/remote-access.md) · [配置参考](../configuration.md)

## 换一块屏幕，接着做

![Cloud Harness 的电脑、平板和手机布局组合展示](../assets/screenshots/devices.zh-CN.png)

电脑上展开工作空间，平板上集中查看，手机上随手继续对话。
支持的浏览器可安装 PWA，获得类似应用的入口；界面提供中英文与深浅主题。
可选桌面外壳连接已有的服务器安装。

[安装 Cloud Harness](../../README.zh-CN.md#快速开始) · [桌面外壳](../../desktop/README.md) · [当前状态与局限](../STATUS.md)

<details>
<summary>查看深色主题</summary>

![同一虚构项目在实际深色主题中的工作界面](../assets/screenshots/workspace-dark.png)

</details>
