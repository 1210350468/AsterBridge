# AsterBridge · 星桥：10 分钟快速开始

这份指南面向第一次从 GitHub 安装 AsterBridge（内部兼容名仍为 `codex-chatgpt-web`）的用户。目标是先跑通一个 ChatGPT Web 模型回合，再通过主路径 MCP Full Harness 启用原生 Codex 工具。Responses direct bridge 只保留为显式实验兜底，不会自动启用。遇到异常时不要反复重装，先执行 **设置 → 运行诊断**，再对照 [故障排查](troubleshooting.zh-CN.md)。

## 1. 安装 Launcher

### Windows PowerShell

```powershell
irm https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.sh | sh
```

更新或修复安装时请先退出 Launcher，再重新执行同一条安装命令。安装器会替换应用和内置运行时，但保留 Launcher 设置、私密密钥和已保存的浏览器配置。

## 2. 网络代理（Windows / Clash 用户建议先看）

AsterBridge 默认使用 **设置 → 网络代理 → 自动（推荐）**。自动模式会：

1. 优先继承 `HTTPS_PROXY` / `HTTP_PROXY`；
2. Windows 没有这些环境变量时读取系统代理；
3. 把 `127.0.0.1`、`localhost`、`::1` 自动加入 `NO_PROXY`，避免把本地 Bridge/Roxy API 送进代理。

如果浏览器能打开 ChatGPT，但 Doctor 报 `ChatGPT/Codex upstream is not reachable`，不要先重装：这通常说明浏览器走了系统代理，而 Bun/tunnel 子进程没有走同一条网络链路。直接在 Launcher 里选择 **自定义代理**，填常见的 HTTP/Mixed 端口，例如：

```text
http://127.0.0.1:7890
```

保存后 Launcher 会尽量自动重启受管 daemon/tunnel。详细优先级和排查方法见[网络与代理](troubleshooting.zh-CN.md#网络与代理)。

## 3. 选择浏览器运行方式

Launcher 支持三种 ChatGPT Web 浏览器后端：

| 模式 | 推荐程度 | 适合场景 |
| --- | --- | --- |
| **RoxyBrowser** | 推荐用于需要稳定外部 Profile 的用户 | 固定登录环境、自动启动、Live Preview、人工接管 |
| **内置浏览器** | 默认、最省事 | 不想安装额外浏览器；首次体验 |
| **Chrome / Edge** | 实验性 | 已开启主浏览器远程调试的开发者 |

### 使用 RoxyBrowser

1. 在 RoxyBrowser 中创建并登录一个专用于 ChatGPT 的 Profile。
2. 打开 Launcher → **设置 → 使用 RoxyBrowser 运行 ChatGPT 对话**。
3. 填写 Profile/窗口 ID 和 Profile 数据根目录。
4. 推荐开启 **需要时自动打开 RoxyBrowser Profile**。
5. 若希望电脑重启后也完全自动恢复，再填写 **RoxyBrowser 程序路径**（例如 Windows 上的 `RoxyBrowser.exe` 绝对路径）。AsterBridge 会在 Local API 不可用时先启动 RoxyBrowser 主程序，再等待 Profile 自动打开。
6. 若开启自动启动，在 RoxyBrowser 中启用 Local API，并把 Local API Key 填入 Launcher。Key 只会写入 owner-only 的私密 secrets 文件，不进入普通配置和日志。
7. 保存后先运行一次 **启动器设置 → 运行诊断**。看到 `RoxyBrowser profile is open and reachable`，或“Profile 当前关闭但 Local API 健康、下一轮会自动打开”即可继续。

> 不要把 Roxy 的 Profile 目录直接作为 Electron/Chrome 的 `user-data-dir` 使用，也不要手工复制 Cookie。项目只连接 Roxy 自己暴露的 Chromium CDP endpoint。

## 4. 安装 ChatGPT Web 模型

进入 **模型设置**：

1. 完成浏览器登录或 Roxy Profile 配置。
2. 点击 **安装模型**。
3. 完成后完全退出并重新启动一次 Codex。
4. 在 Codex 模型选择器中选择 `ChatGPT Web — ...` 模型。

先发送一个最简单的测试：

```text
Reply with exactly: WEB_OK
```

先把这条 Browser-only 证明与工具传输问题分开，再继续启用原生工具。

## 5. 启用 MCP Full Harness（主工具路径）

1. 回到 Launcher → **MCP**。
2. 创建或复用 OpenAI Tunnel 与 Runtime Key。密钥只放在 Launcher，本地聊天和 Issue 中都不要粘贴。
3. 创建匹配的 ChatGPT 自定义 App：选择 **Tunnel**、**Authentication: None**，名称与 Launcher 完全一致（默认 `Codex Native3`）。
4. 返回 Launcher 点击 **连接 Harness / Verify runtime**。
5. 测试一个无副作用的真实工具调用，例如：

```text
Use Codex Native3 to run exactly: Write-Output MCP_OK
```

只有真实 outer Codex 工具结果返回 `MCP_OK` 才算通过。MCP 作为主路径的原因是 ChatGPT 可以留在同一次 response 中连续请求多个工具；AsterBridge 负责传输，真正的审批、沙箱和执行仍归外层 Codex。

### 实验兜底：Responses direct tool bridge

如果当前 ChatGPT 账户根本没有自定义 MCP App 能力，这是账户侧 MCP 限制；Browser-only 仍可正常使用。AsterBridge 也保留 connectorless Responses 工具桥，但不会自动切换过去。依赖工具链可能需要更多 Web generation，私有文本 envelope 也比 MCP 更脆弱，因此只有明确接受这个权衡时才通过高级/CLI 显式启用。

## 6. 首次成功后的建议设置

- Roxy 用户：开启自动启动；平时使用 Launcher 的 Live Preview，只有需要验证码/重新登录时点击 **人工接管**。
- 开启 **关闭 Launcher 后保持后台运行**，让本地 Responses 路由和主路径 MCP Tunnel 都保持就绪。
- 遇到问题先运行 **设置 → 运行诊断**，不要先删除配置或重装。
- 需要提交 GitHub Issue 时，只粘贴脱敏后的 Doctor/Activity 信息；不要上传 Cookie、API Key、Tunnel token、完整 turn token 或浏览器 Profile。

## 7. 你应该看到的健康状态

一个可用的 Roxy + MCP Full Harness 安装通常满足：

```text
Configuration       OK
Launcher ownership  OK
RoxyBrowser         OK / auto-open ready
Codex route         OK
Responses proxy     OK (127.0.0.1:17841)
ChatGPT upstream    OK
OpenAI/Tunnel       OK
Connector           Codex Native3 verified
Tools               MCP Full Harness；outer Codex owns execution
```

如果你显式选择实验性的 Responses transport，Doctor 会改为报告该 transport，并且不再要求 Tunnel/Connector。

`/v1/responses` WebSocket 出现 `426 Upgrade Required` 后自动回退到 HTTP/SSE，在当前实现中不是故障；只有最终 turn 失败时才需要继续排查。

下一步：查看 [故障排查](troubleshooting.zh-CN.md)。
