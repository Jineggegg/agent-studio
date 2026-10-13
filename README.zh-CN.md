# Agent Cloud Studio

**自托管的 AI 编程 Agent 工作台，手机上就能用。**

Agent Cloud Studio 跑在你自己的机器上（工作站、家用服务器或 VPS），和你已经在用的 Agent 命令行工具放在一起，提供一个为触摸设计的 Web 应用：在 iPhone、iPad 或电脑浏览器里指挥它们干活。Agent 操作的是**你的**文件、用的是**你的**登录；手机只和你自己的服务器通信。

```
手机 / 平板 / 电脑 ──HTTPS──▶ 你的服务器（Agent Cloud Studio）──▶ Claude Code CLI · Codex CLI · 模型 API
```

[English](README.md) · [架构](docs/architecture/ARCHITECTURE.md) · [安全](SECURITY.md) · [进度](docs/STATUS.md)

> **状态：beta。** 服务器、安全模型和测试是最成熟的部分。客户端已在桌面浏览器和模拟的手机/平板尺寸下验证，尚未在真机上验证。正式依赖之前请先看[哪些已完成、哪些没有](docs/STATUS.md)。

## 能做什么

**和 Agent 一起工作**
- 通过官方 CLI 使用 **Claude Code** 和 **Codex**（沿用你已有的登录），也可以接入**任何 OpenAI 兼容的 API 模型**（DeepSeek、OpenAI、你自己机器上的模型服务），密钥加密保存在服务器上。
- 文字、思考过程、工具调用和代码差异实时流式显示。运行属于服务器：锁屏、断网、换设备都不影响，回来时对话从断点补齐。
- **决定权在你手里。** Agent 想做的每个有副作用的操作都要经过服务器上的同一个权限引擎；有风险的操作会等你批准——在对话里、收件箱里或推送通知里，任何一台设备都能处理。
- Agent 忙的时候可以排队发消息、中途插话、停止，也可以接着跑被重启打断的任务。
- 同一个项目可以用多个 Agent，带着摘要把对话交接给另一个模型，并查看每个会话的 Token 用量和费用。

**管理项目**
- 项目就是服务器上的文件夹：浏览和编辑文件、看差异、暂存、提交、建分支、推送拉取、使用 Git worktree。
- 通过服务器上已登录的 GitHub CLI 查看 PR 和 CI 状态，并在有保护的前提下合并。
- 项目目录里的真实终端，放下手机后继续运行；也可以打开你通过 SSH 配置好的其他机器上的终端。

**记忆与自动化**
- **共享记忆**：Markdown 笔记，分项目级和全局级，所有 Agent 用同一套工具搜索和写入，你也可以查看、修改、删除。Agent 只能看到自己项目的笔记和全局笔记。
- **自动化**：定时提醒，或定时无人值守地启动一次 Agent 运行（需要审批的操作会被拒绝并上报，绝不悄悄执行）。
- **收件箱与 Web Push**：哪些在等你、哪些失败了、哪些完成了。

**为触摸而做**
- 可安装的 PWA，手机、平板、桌面三种布局，深色与浅色，中英文界面。

**可扩展**
- 插件系统：插件运行在沙箱进程里，只拥有你授予的权限，界面与你的登录会话隔离。可以用它接入不属于开源版的私人工具。
- 新的 Agent 通过统一的适配器接口接入。

## 快速开始

需要 Node.js **22.13 或更高**和 git，不需要编译器。支持 Linux 和 macOS；Linux 上安装 `bubblewrap` 才有 Agent 沙箱。

```bash
git clone https://github.com/Jineggegg/agent-studio.git
cd agent-studio
npm ci
npm run build
npm start
```

服务器会打印访问地址（`http://127.0.0.1:7420`）和**一次性安装令牌**。在同一台机器上打开该地址，输入令牌并创建所有者账号。然后：

1. **接入 Agent。** 安装并登录你要用的 CLI——应用会显示检测到了哪些，并提供终端让你完成它们的登录：
   - Claude Code：<https://docs.claude.com/en/docs/claude-code>
   - Codex：<https://developers.openai.com/codex/cli>
   - 或者在「设置 → 模型」里添加 API 服务商和密钥。
2. **添加项目**——主目录下的任意文件夹。
3. **开始对话。**

要在手机上访问，请看[从手机访问你的 Studio](docs/deployment/remote-access.md)（Tailscale、Cloudflare Tunnel、反向代理，或直接用 SSH 端口转发），然后选择「添加到主屏幕」。

全部配置通过 `AGENT_STUDIO_*` 环境变量完成，都不是必填。见[配置说明](docs/configuration.md)。

## 一分钟了解安全

一个能让 Agent 执行命令、又能从手机访问的应用，必须把安全讲清楚：

- 默认只监听本机；一次性安装令牌；scrypt 密码加锁定；Passkey；服务器端会话放在 `HttpOnly` Cookie 里，并做同源和防伪造校验；每个 API 路由都声明了谁可以调用。
- 不信任 Agent：服务器端统一的权限引擎、危险操作人工审批、白名单环境变量；在装有 bubblewrap 的 Linux 上，沙箱让 Agent 进程看不到 Studio 自己的数据，并把 API 模型执行的命令限制在项目目录内。
- 密钥加密存储，API 从不返回。
- **你需要知道的局限：** 批准了的命令就真的会执行；没有 bubblewrap 就没有沙箱；终端就是你自己的 shell；本项目没有经过独立的专业安全审计。

完整的信任模型、局限和加固清单见 [SECURITY.md](SECURITY.md)。发现漏洞请按其中的方式私下报告。

## 技术构成

全部使用 TypeScript：Node.js 服务器（Fastify、Node 内置的 SQLite）、React 客户端（Vite），以及一个用 zod 定义的共享协议包。安全攸关的代码集中在一个很小的内核里（`apps/server/src/kernel`），功能以模块形式建在内核之上。细节和主要决策的理由见 [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) 和[决策记录](docs/adr)。

```bash
npm run dev                 # 服务器自动重载 + 客户端热更新
npm run typecheck && npm run lint
npm run test:unit
npm run test:integration
npm run test:acceptance     # 黑盒测试，针对构建后的服务器
npm run test:e2e            # 手机、平板、桌面三种尺寸的浏览器测试
```

参与贡献请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 它从哪里来，以及这里说的「独立」是什么意思

这个想法来自一个建立在 CloudCLI UI（AGPL 许可）之上的私人系统。本项目与它**不共享任何代码**：它根据行为需求文档（[docs/requirements](docs/requirements)）编写，架构、数据模型、协议和设计都是自己的，发布前还会对两个代码库做机械比对。

本项目大量借助了 AI：需求文档和代码由 AI Agent 在一个总控 Agent 和项目所有者的指挥下完成。「读过旧系统的人」和「写新系统的人」之间的隔离靠的是指令约束，而不是操作系统层面的隔离，因此**不**声称这是严格意义上的 Clean-Room 实现。[docs/clean-room/PROCESS.md](docs/clean-room/PROCESS.md) 如实记录了做了什么、哪里没有做到。

Agent Cloud Studio 与 Anthropic、OpenAI、DeepSeek、GitHub、CloudCLI 均无关联。Claude Code、Codex 等名称归各自所有者；你需要自己的账号，并遵守各服务商的条款。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [docs/licenses/THIRD_PARTY_LICENSES.md](docs/licenses/THIRD_PARTY_LICENSES.md)。
