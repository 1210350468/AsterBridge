# AsterBridge · 星桥：10 分钟快速开始

这份指南面向第一次从 GitHub 安装 AsterBridge（内部兼容名仍为 `codex-chatgpt-web`）的用户。目标是先跑通一个 ChatGPT Web 模型回合，再按需启用 MCP 原生 Codex 工具。遇到异常时不要反复重装，先执行 **设置 → 运行诊断**，再对照 [故障排查](troubleshooting.zh-CN.md)。

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
5. 若开启自动启动，在 RoxyBrowser 中启用 Local API，并把 Local API Key 填入 Launcher。Key 只会写入 owner-only 的私密 secrets 文件，不进入普通配置和日志。
6. 保存后先运行一次 **设置 → 运行诊断**。看到 `RoxyBrowser profile is open and reachable`，或“Profile 当前关闭但 Local API 健康、下一轮会自动打开”即可继续。

> 不要把 Roxy 的 Profile 目录直接作为 Electron/Chrome 的 `user-data-dir` 使用，也不要手工复制 Cookie。项目只连接 Roxy 自己暴露的 Chromium CDP endpoint。

## 4. 安装 ChatGPT Web 模型

进入 **配置 / Setup**：

1. 完成浏览器登录或 Roxy Profile 配置。
2. 点击 **安装模型**。
3. 完成后完全退出并重新启动一次 Codex。
4. 在 Codex 模型选择器中选择 `ChatGPT Web — ...` 模型。

先发送一个最简单的测试：

```text
Reply with exactly: WEB_OK
```

收到 `WEB_OK` 后再继续 MCP。这样可以把“浏览器问题”和“MCP/Tunnel 问题”分开排查。

## 5. 可选：启用 MCP 原生 Codex 工具

只有需要 ChatGPT Web 模型调用当前 Codex Harness 的 shell、文件、补丁等工具时才需要这一步。

1. 打开 Launcher → **MCP**。
2. 创建 OpenAI Tunnel 和用于 Tunnel 的 Runtime Key。
3. Launcher 会默认使用当前版本要求的全新 App/Connector 身份 **`Codex Native3`**。不要复用旧的 `Codex Native` 或 `Codex Native2` App；ChatGPT 会按 App 身份缓存 MCP schema。
4. 在 ChatGPT 设置中启用开发者模式，新建 App：
   - 类型：Tunnel
   - Tunnel：选择刚创建的 Tunnel
   - Authentication：None
   - Name：与 Launcher 完全一致（默认 `Codex Native3`）
   - Permissions：允许所有操作；低风险模式可能会在工具请求到达 Codex 之前拦截命令/补丁。
5. 返回 Launcher 点击 **连接 Harness / Verify runtime**。
6. 在 Codex 中测试一个无副作用工具调用，例如让 `Codex Native3` 执行 `Write-Output MCP_OK`。

## 6. 首次成功后的建议设置

- Roxy 用户：开启自动启动；平时使用 Launcher 的 Live Preview，只有需要验证码/重新登录时点击 **人工接管**。
- 开启 **关闭 Launcher 后保持后台运行**，避免每次使用都重新启动 Bridge/Tunnel。
- 遇到问题先运行 **设置 → 运行诊断**，不要先删除配置或重装。
- 需要提交 GitHub Issue 时，只粘贴脱敏后的 Doctor/Activity 信息；不要上传 Cookie、API Key、Tunnel token、完整 turn token 或浏览器 Profile。

## 7. 你应该看到的健康状态

一个可用的 Roxy + Full Harness 安装通常满足：

```text
Configuration       OK
Launcher ownership  OK
RoxyBrowser         OK / auto-open ready
Codex route         OK
Responses proxy     OK (127.0.0.1:17841)
ChatGPT upstream    OK
OpenAI upstream     OK (Full Harness)
Tunnel runtime      OK
Connector           verified from Launcher
```

`/v1/responses` WebSocket 出现 `426 Upgrade Required` 后自动回退到 HTTP/SSE，在当前实现中不是故障；只有最终 turn 失败时才需要继续排查。

下一步：查看 [故障排查](troubleshooting.zh-CN.md)。
