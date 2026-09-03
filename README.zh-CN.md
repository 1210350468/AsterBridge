<h1 align="center">AsterBridge · 星桥</h1>

<p align="center">
  <strong>连接 Codex、ChatGPT Web 与原生工具的本地星桥。</strong><br>
  RoxyBrowser 运行时 · 实时预览 · Native3 MCP · 本地优先桌面控制。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="docs/quick-start.zh-CN.md">10 分钟快速开始</a> · <a href="docs/troubleshooting.zh-CN.md">故障排查</a>
</p>

<p align="center">
  <a href="https://github.com/1210350468/AsterBridge/actions/workflows/ci.yml"><img src="https://github.com/1210350468/AsterBridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free 和 Go 账户会在 Codex 原生模型选择器中看到 **ChatGPT Web — Luna**。具有推理选择器的
账户仍会按订阅权限看到 **Instant**、**Medium**、**High**、**Extra High** 和 **Pro**。
桥接程序会把当前编译后的 Codex 任务上下文发送到一个全新的 ChatGPT 临时聊天，附加图片，
并将可见的推理过程、工具活动和 Markdown 流式传回同一个 Codex 任务。

> **关于新名字。** AsterBridge · 星桥是在
> [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 基础上持续二次开发的独立社区版本，
> 保留原 MIT 许可与署名。部分内部目录、CLI 名、模型 slug 和 release 资产名会继续保留
> `codex-chatgpt-web` 兼容名称，避免升级时丢失现有登录会话或运行状态。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 实时轮次正在使用原生 Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──browser runtime──▶ ChatGPT
     ▲                                │                                     │
     └──────── native UI, context, images, tracing, and tool lifecycle ─────┘
```

Codex 会保留原生任务、上下文生命周期、界面和工具 harness。本地 Responses 桥接程序会为
所选任务打开一个 ChatGPT 临时聊天，并在兼容的后续轮次中保留这个与任务绑定的页面；在完整
模式下，MCP 会把 ChatGPT 连接回同一个 Codex 任务的工具。

## 亮点

- **精致的跨平台启动器。** 一条命令即可安装原生 macOS、Windows 或 Linux 应用。登录流程、设置、
  冒烟测试、MCP 指南、运行状态和本地日志都集中在同一处。内置浏览器是最省事的默认方案；
  RoxyBrowser 可作为稳定外部运行时，支持自动启动 Profile、Launcher Live Preview 和一键人工接管。
  最多可并行运行五个与 Codex 任务绑定的浏览器回合；此上限用于避免对 ChatGPT 账户产生过多并行流量。
- **ChatGPT 就是所选模型。** 它作为 Codex 原生模型运行，而不是由另一个宿主模型调用的工具。
  原有的模型选择器、任务生命周期、流式输出、追踪和工具界面保持不变。
- **本地优先的保留式任务会话。** Codex 仍然是电脑上任务历史的真实来源。首个浏览器轮次会
  新建 ChatGPT 临时聊天；同一 Codex 任务的兼容后续轮次会复用该保留页面，不再重复绑定 Connector。
  原生压缩只有在检查点被证明完成后才关闭旧 epoch，并在需要时创建新 epoch。浏览器聊天不会跨
  不同任务复用，也不会加入普通 ChatGPT 历史记录。
- **通过 MCP 使用完整 Codex harness。** 在完整模式下，登录账户可用的每一个 effort——Luna、
  Instant、Medium、High、Extra High 和 Pro——都会通过同一个与当前回合绑定的 MCP 能力，使用
  Codex 任务的文件系统、shell、图片、审批以及已配置的工具和应用。调用及其真实结果会留在
  同一个浏览器响应中，不会被模拟成文本。
- **Subagent 保持 Codex 原生语义。** 完整模式通过现有 `Codex Native3` 契约承载延迟发现的
  Multi-agent 工具。Compatibility V1 仍是安全默认值，也可切换 Native 模式保留当前 Codex agent
  版本元数据；父 Agent 的等待采用有界轮询，避免一个子 Agent 长时间独占 MCP 通道。
- **可选 Bigger Context。** 设置中可为大型非 Luna 任务启用可逆的 2/3 段事务式上下文传输。
  前置分段保持惰性并通过 SHA-256 确认，只有最后一次 commit 才真正开始执行任务；普通任务仍默认
  使用标准单消息传输。
- **Pro 没有例外。** Pro 与其他所有 effort 遵循完全相同的 MCP、上下文、图片、追踪、工具轮次、
  浏览器上限和压缩契约。不存在按 effort 区分的 MCP 限制。仅浏览器模式下，所有路由都保持只读。
- **故障时明确失败，并设有明确的发布门槛。** UI 变化或能力缺失会产生明确错误，而不是静默
  回退。依赖真实账户的模型选择、超长上下文、图片、流式输出、上下文压缩、原生工具轮次、
  取消操作和 Pro 必须按[发布验证清单](docs/release-validation.md)逐个候选版本验证，不能用打包
  smoke 代替。

临时聊天是 ChatGPT 的隐私模式，并不代表匿名或仅在本地推理：提示仍会由 OpenAI 处理，并受账户
设置及 OpenAI [临时聊天政策](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
约束。本项目为非官方项目；用户仍需自行遵守适用的 OpenAI 条款和工作区政策。

## 快速开始

安装或更新桌面启动器。若要更新或修复现有安装，请先退出启动器，然后再次运行同一条命令；它会
替换应用程序和内置运行时，同时保留 ChatGPT 配置文件和启动器配置。

**macOS 或 Linux**

```bash
curl -fsSL https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.ps1 | iex
```

然后按 [10 分钟快速开始](docs/quick-start.zh-CN.md) 操作。简化流程是：

1. 先看 **设置 → 网络代理**。自动模式会继承环境代理，并在 Windows 上读取系统代理；Clash/V2Ray 使用独立 HTTP/Mixed 端口时可直接选“自定义”。
2. 选择浏览器后端。内置浏览器最省事；如果希望固定外部 Profile、自动启动和 Live Preview，推荐 RoxyBrowser。
3. 安装模型前先运行一次 **设置 → 运行诊断**。
4. 点击 **安装模型**，重启一次 Codex，先用简单 `WEB_OK` 回合证明 Browser-only 链路。
5. 配置 **MCP Full Harness**。MCP 是 AsterBridge 的主工具通道，因为同一次 ChatGPT Web response 可以持续调用多个 Codex 工具；真正的审批、沙箱和执行仍由外层 Codex 掌控。Responses direct bridge 只保留为显式实验兜底，不会自动启用。只有确实需要更大任务上下文时再启用 **Bigger Context**。

### 复制给 AI：自动安装并跑通 AsterBridge

如果你不熟悉终端，可以把下面整段提示词复制给具备本机终端/桌面操作能力的 AI（例如 Codex、Claude Code、Cursor Agent 等）。它会优先安装正式 Release，而不是要求你从源码构建。

```text
请在我的电脑上安装并跑通 AsterBridge，仓库是：https://github.com/1210350468/AsterBridge

要求：
1. 先检测操作系统和现有 AsterBridge/Codex 状态。优先使用 GitHub latest Release 的官方安装脚本/安装包；只有 Release 不可用时才从源码构建。修复/更新前先安全退出已有 AsterBridge，不要删除用户配置。
2. 不要让我把 API Key、Tunnel runtime key、Cookie、Bearer Token、RoxyBrowser API Key 或完整 turn token 发到聊天里。需要密钥时，让我只在 AsterBridge 本地界面或对应官方页面中填写。
3. 安装后启动 AsterBridge，先运行 Doctor。网络异常时优先检查 AsterBridge → 启动器设置 → 网络代理；Windows 上优先使用“自动”，它会读取系统代理。不要随意修改全局代理或清空配置。
4. 如果选择 RoxyBrowser：确认 RoxyBrowser 主程序正在运行、Local API 已启用且 AsterBridge 能访问 127.0.0.1:50000；Profile 关闭时应由 AsterBridge 自动打开。不要复制浏览器 Cookie。
5. 在“模型设置”中安装模型，完成后重启 Codex。实际运行 chatgpt-web/high（若账户不支持则用可用的 ChatGPT Web 模型），要求只回复 WEB_OK。必须看到 WEB_OK 才继续。
6. Browser-only 成功后再配置 MCP。已有 Tunnel/profile/key 应优先安全复用；首次配置时也只能让我在 AsterBridge 本地界面填写密钥，不要把密钥发进聊天。确认 ChatGPT App 名称与 Launcher 完全一致（默认 `Codex Native3`）。
7. 通过 MCP 使用 chatgpt-web/high 执行无副作用命令 `Write-Output ASTERBRIDGE_FULL_OK`。只有真实 outer Codex 工具结果返回 `ASTERBRIDGE_FULL_OK` 才算 Full Harness 跑通，不能把模型口头声称成功当证据。
8. 如果当前 ChatGPT 账户根本没有自定义 MCP App 能力，明确报告这是账户侧限制，不要静默把安装切到实验性 Responses direct bridge；只有我明确要求时才启用该兜底。
9. 任一步失败时，先读取 AsterBridge Doctor、活动日志和仓库 docs/troubleshooting.zh-CN.md，定位最早的 warning/error；不要通过反复重装、删除 ~/.codex-chatgpt-web 或重置 Codex 来碰运气。
10. 最后向我报告：AsterBridge 版本、Codex 版本、Browser backend、代理来源、Browser-only WEB_OK 是否成功、MCP/Native3 FULL_OK 是否成功，以及仍需我手工完成的步骤。
```

启动器会在设置期间检测当前账户的 ChatGPT 控件：Free/Go 账户只会显示 Luna；只有已登录账户
支持 Pro 时，Pro 才会显示。打包后的启动器不需要模型 API 密钥、系统级 Node/Bun，也不会由本项目
另行下载浏览器。RoxyBrowser 是可选后端，直接复用它自己的登录 Profile，不复制浏览器 Cookie。

**从源码运行**

```bash
git clone https://github.com/1210350468/AsterBridge.git && \
cd AsterBridge && \
bun run app
```

源码方式需要 Bun 1.4.0。该命令会安装锁定版本的依赖并打开应用。

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Free/Go：Luna；Plus：Instant–High；Pro：增加 Extra High 和 Pro | 不可用 | 无 |
| **Full · MCP（主路径）** | 同一账户可用的 Web 模型 | 可用 | OpenAI Tunnel + 自定义 ChatGPT App |
| **Full · Responses（实验兜底）** | 同一账户可用的 Web 模型 | 可用 | 仅显式 CLI opt-in；无需 Tunnel/自定义 App，但依赖工具链可能增加 Web generation 次数 |

模型选择器中的每一项都对应固定的 ChatGPT 模式。无论使用哪一种 Full transport，ChatGPT 都只负责提出工具调用；真正的工具执行、审批与沙箱权始终属于外层 Codex。AsterBridge 不会在没有明确 opt-in 的情况下把 MCP 安装迁移成 Responses。

## Full Harness：MCP / Codex Native3

MCP 是 Full Harness 的主工具通道。它使用官方 [OpenAI tunnel-client](https://github.com/openai/tunnel-client)，Tunnel 为纯出站连接，不需要路由器端口转发。优先 MCP 的核心原因是工具循环效率：ChatGPT 可以留在同一次 response 中连续请求多个工具，而不是每一个依赖步骤都结束一次 Web generation。

> [!WARNING]
> 默认连接器/App 名称是 **Codex Native3**。旧的 **Codex Native** 和 **Codex Native2** 不会继续复用，以避免 ChatGPT 按 App 身份缓存旧 MCP schema。

1. 先完成 Browser-only。
2. 在启动器打开 **MCP**，创建或复用 Tunnel 与 runtime key。
3. 创建对应 ChatGPT App：选择 **Tunnel**、**Authentication: None**，并使用启动器显示的精确名称。
4. 运行 **验证运行时**；旧名称或其他名称不会被当作替代。
5. 用一个无副作用的真实 outer Codex 工具调用证明 Full Harness 后再正式使用。

MCP 是否可用以及具体权限由 ChatGPT 账户、工作区和管理员策略控制，可能独立于 AsterBridge 变化。如果当前账户确实没有自定义 MCP App 能力，Browser-only 仍然可用；Responses direct bridge 可以通过显式开关作为实验兜底，但绝不会自动替代 MCP，因为依赖工具链会增加 Web generation，文本 envelope 也比原生 MCP 更脆弱。请参阅 [开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。外层 Codex 仍会执行沙箱与审批规则。

## 日常操作

在 **活动** 页面查看结构化本地日志，在 **设置 → 运行诊断** 中执行端到端健康检查。Doctor 会同时
检查当前选中的 Roxy Profile/Local API、Bridge、Codex 路由和 Tunnel 状态。运行后可使用
**复制脱敏诊断摘要**，生成不含密钥和 Doctor detail 的支持信息。任务卡住时使用 **取消活动的 Codex 任务**；
删除启动器前使用 **移除 Codex 集成**，以恢复此前的 Codex 路由。

如果安装停在任何一步，先查看[故障排查指南](docs/troubleshooting.zh-CN.md)，不要先删除配置或反复重装。
GitHub Bug 模板会要求 Doctor 结果和最早相关 warning/error，并明确禁止上传 API Key、Cookie、Bearer Token、
完整 turn token 或浏览器 Profile。

## 限制和安全性

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- ChatGPT 针对不同账户设置的输入框上限小于某些底层模型的上下文窗口。实测边界以及实现更大且
  确定性传输的要求记录在
  [#76](https://github.com/miuuyy/codex-chatgpt-web/issues/76) 中。
- 浏览器状态是敏感的登录凭据，loopback 监听器也可被同一本地用户运行的进程访问。切勿共享
  启动器 profile，并仅在可信工作站上使用。
- 发布包目前支持 macOS 13+（arm64/x64）、Windows x64 和 Linux x64。核心运行时、测试和原生
  打包会在 CI 中对三种操作系统进行检查；依赖账户的浏览器与 MCP 流程必须另行完成
  [发布验证](docs/release-validation.md)，打包 smoke 不视为端到端证明。
- 在为发布配置平台签名证书之前，macOS Gatekeeper 或 Windows SmartScreen 可能会显示未知发布者
  警告。一键安装脚本会在安装前验证发布的 SHA-256 清单。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun run app
bun run verify
bun run app:package
```

正式打包请使用上面的 package 脚本；Windows 也可显式运行 `bun run --cwd launcher package:win`。不要直接调用 `launcher/scripts/package.cjs --win`，因为正式入口会先构建 Renderer 和内置 runtime，再交给 electron-builder。随后用 `bun run app:smoke` 安装真实安装包并验证 packaged Bun/runtime、durable runtime；Windows 还会验证 Tray 已就绪。较慢磁盘上的 NSIS 安装可能正常超过两分钟，因此 smoke 会等待安装器真正完成，不再把 120 秒时被中止的半解包目录误判成坏包。

### 使用主 Chrome / Edge 运行 Web 模型回合

源码桌面端可让 Launcher 继续监管本地 Bridge/MCP，但把真正的 ChatGPT Web 回合切换到你日常使用、已登录的 Chrome 或 Edge：

1. 在主浏览器打开 `chrome://inspect/#remote-debugging` 或 `edge://inspect/#remote-debugging`，启用当前浏览器实例的远程调试并接受浏览器授权提示。
2. 启动 `bun run app`，进入 **Settings**，开启 **使用我的主浏览器运行 ChatGPT 对话**。
3. 返回 **Setup**，点击 **安装模型/重新安装模型**。Launcher 会自动发现可连接的 Chrome/Edge，会话能力检测、Temporary Chat、模型/推理强度选择、附件、连接器、工具确认、发送和回复解析都复用同一套 Browser Worker 逻辑。
4. 重启一次 Codex 后使用 `chatgpt-web/*` 模型。每个回合会在主浏览器中新开任务标签页，回合结束后只关闭该任务标签页；不会复制浏览器 Cookie，也不会关闭其它已有标签页。

CLI 也支持 `setup ... --system-browser --system-browser-channel auto`；`auto` 会在已开启调试且端口实际存活的 Chrome/Edge 中选择最近的会话。

### 使用 RoxyBrowser 指纹 Profile 运行 Web 模型回合

当普通 Chrome/Edge 远程调试环境不稳定时，推荐使用 RoxyBrowser 外部浏览器模式。进入 **设置 → 使用 RoxyBrowser 运行 ChatGPT 对话**，填写 RoxyBrowser 的 Profile/窗口 ID 和 Profile 数据根目录绝对路径（例如 `E:\\roxybrowserdata`），保存后回到 **Setup** 重新安装模型。运行时只读取该 Profile 自己的 Chromium `DevToolsActivePort` 并精确连接这个 Profile，不复制 Cookie，也不导出登录会话。

如果选定的 Profile 没有打开，运行时现在会返回结构化的 `browser_unavailable` 错误和明确操作提示，不再让 Responses 流因为未分类 CDP 异常直接断开。也可以开启 **需要时自动打开 RoxyBrowser Profile**：运行时会通过 RoxyBrowser 的本机 Local API（通常是 `http://127.0.0.1:50000`）先打开 Profile，再开始 ChatGPT 回合。Local API Key 只保存在 Launcher 的 owner-only 私密 secrets 文件中；普通运行时配置只保存 key 文件路径，不保存 Key 原文。

CLI 等价配置：

```bash
codex-chatgpt-web setup --browser-only \
  --browser-host-descriptor <launcher-browser.json> \
  --roxy-browser-profile <dirId> \
  --roxy-browser-data-dir <Profile 数据根目录绝对路径>
```

只有在 RoxyBrowser 已开启 Local API 时，再增加 `--roxy-browser-auto-open --roxy-browser-api-host http://127.0.0.1:50000 --roxy-browser-api-key-file <私密 key 文件>`。

- [架构说明](docs/architecture.md)
- [安全模型](docs/security-model.md)
- [贡献指南](CONTRIBUTING.md)

## 项目主页

- 仓库：https://github.com/1210350468/AsterBridge
- Issues：https://github.com/1210350468/AsterBridge/issues
- Releases：https://github.com/1210350468/AsterBridge/releases

## 免责声明

本项目是独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。请仅使用自己的账户，并遵守适用的
[使用条款](https://openai.com/policies/terms-of-use/)和工作区政策；本项目不会绕过身份验证或
访问控制。
