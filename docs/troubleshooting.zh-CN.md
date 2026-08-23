# AsterBridge · 星桥故障排查

先运行 **Launcher → 设置 → 运行诊断**。除非文档明确要求，不要先删除 `%APPDATA%`、浏览器 Profile、Codex 配置或 Tunnel 凭据。

## 快速故障矩阵

| 现象 / 错误 | 含义 | 处理 |
| --- | --- | --- |
| `browser_unavailable` / `RoxyBrowser profile ... is not open` | 选定的 Roxy Profile 没有可用 CDP endpoint | 手动打开该 Profile，或启用 Launcher 的自动启动并配置 Local API + Key |
| `is not exposing a reachable Chromium CDP endpoint` | `DevToolsActivePort` 不存在、已过期或端口不可达 | 完全关闭该 Profile 后重新打开；确认 Launcher 中 Profile ID/DataDir 正确 |
| `stream disconnected before completion` 且前面有浏览器错误 | 上游浏览器任务中断 | 先解决最早出现的浏览器错误；不要把最后的 stream 错误当根因 |
| `HTTP 426 Upgrade Required` on `/v1/responses` | WebSocket 不可用，客户端会回退 HTTP/SSE | 如果最终 turn 正常完成则忽略；只有回退也失败才需要排查 |
| `127.0.0.1:17841` / `EADDRINUSE` | Bridge 端口被另一个进程或旧 Launcher 占用 | 退出所有旧 Launcher，确认只有一个实例；再重启 Launcher。不要随意改 Codex route 指向未知端口 |
| 模型存在但 MCP 工具不可用 | Browser-only 模式，或 Full Harness/Tunnel/Connector 未完成 | 先确认普通 `WEB_OK` 成功，再进入 MCP 页面验证 runtime |
| ChatGPT 找不到 App / Connector | App 名称不一致或旧 App 缓存了旧 MCP schema | 新建精确名为 `Codex Native3` 的 App；不要复用 `Codex Native` / `Codex Native2` |
| 工具调用被安全检查拒绝 | ChatGPT App 权限或外层 Codex sandbox/approval 拒绝 | 确认 App 权限；外层 Codex 仍然保留自己的审批与沙箱规则 |
| `turn token is invalid, expired, or revoked` | ChatGPT 返回了不属于当前外层 Codex turn 的 token，或旧 App/旧会话残留 | 使用当前 `Codex Native3`，新开 Codex turn；不要手工复用 turn token |
| `missing YAML frontmatter delimited by ---` | 某个本地 Codex Skill 文件格式无效 | 与 Roxy/Bridge 无关；修复或禁用对应 Skill。只在该 Skill 本身需要使用时处理 |
| `fatal: detected dubious ownership` | Git 仓库所有者 SID 与当前执行用户不同 | 与 Roxy/Native3 无关；根据自己的安全策略处理 Git safe.directory，不要为了测试全局放宽所有仓库 |
| Tunnel health 一直失败 | tunnel-client、Runtime Key、Tunnel ID、网络或 ownership 有问题 | 在 Launcher MCP 页面重新验证；先看 Doctor 的 `tunnel-*` checks，不要先重建 ChatGPT App |
| `ChatGPT/Codex upstream is not reachable` | Responses daemon 无法访问 ChatGPT/Codex 上游，常见原因是代理没有被 Bun 子进程继承 | 打开 **设置 → 网络代理**，优先选“自动”；仍失败时改成自定义 HTTP 代理并重新运行 Doctor |
| `OpenAI API/tunnel control plane is not reachable` | Full Harness 的 tunnel-client 无法访问 OpenAI 控制面 | 检查代理是否对 tunnel-client 生效；确认代理允许 HTTPS CONNECT，并重新运行 Doctor |
| GitHub 更新检查失败但 Web 模型正常 | GitHub Release 请求被网络/代理阻断 | AsterBridge Updater 会跟随同一套 HTTP/HTTPS 代理；确认代理可访问 `github.com`，再重试更新 |

## 网络与代理

### 推荐配置

进入 **Launcher → 设置 → 网络代理**：

- **自动（推荐）**：先读取 `HTTPS_PROXY` / `HTTP_PROXY`；Windows 没有这些环境变量时，再读取系统代理。适合 Clash、Clash Verge、V2RayN 等已经打开“系统代理”的场景。
- **直连**：明确清除 AsterBridge 派生进程的代理变量。只在你确定当前网络可直接访问 ChatGPT/OpenAI/GitHub 时使用。
- **自定义代理**：直接填写 `127.0.0.1:7890` 或 `http://127.0.0.1:7890`。保存后 AsterBridge 会把它同时提供给 Responses daemon、tunnel-client 和内置 Updater。

AsterBridge 会自动把 `127.0.0.1`、`localhost` 和 `::1` 加进 `NO_PROXY`，因此本地 Bridge `17841`、Roxy Local API `50000` 等 loopback 服务不会被错误转发进代理。

> 这个设置控制 AsterBridge 的 daemon、tunnel-client 和内置 Updater，不会修改 RoxyBrowser Profile 自己的代理/指纹网络配置。Roxy 的浏览器出口仍应在对应 Profile 中配置；内置浏览器则继续遵循 Electron/系统网络栈。

### 为什么“Windows 系统代理已经开了”仍可能超时？

这是我们实际遇到过的问题。浏览器通常会自动使用 WinINET/系统代理，但 Bun、CLI 子进程或 tunnel-client 不一定使用同一套网络栈。如果只看到 Edge/Chrome 能访问 ChatGPT，并不能证明 Responses daemon 也能访问上游。

因此新版 AsterBridge 的“自动”模式会把检测到的 Windows 系统代理显式转换成 `HTTPS_PROXY` / `HTTP_PROXY`，再传给受管子进程。修改代理后，Launcher 会尝试自动重启 daemon 和 tunnel；如果当时有活动 Codex turn，设置会先保存，并提示任务结束后重启 AsterBridge。

### Clash / V2Ray 端口怎么填？

优先填写客户端提供的 **HTTP/Mixed HTTP 代理端口**，例如：

```text
http://127.0.0.1:7890
```

不要把 SOCKS5 端口直接当 HTTP 代理填入。当前 AsterBridge 的统一代理设置只接受 `http://` 和 `https://`，这是为了让 Bun、Node Updater 和 tunnel-client 使用一致的代理语义。

### 环境变量和系统代理谁优先？

“自动”模式的顺序是：

```text
HTTPS_PROXY / https_proxy
→ HTTP_PROXY / http_proxy
→ ALL_PROXY / all_proxy
→ Windows 系统代理
→ 直连
```

如果你怀疑旧环境变量覆盖了当前 Clash 配置，可以直接选择“自定义代理”覆盖它，或选择“直连”明确禁用代理。

### 如何确认代理真的生效？

保存后运行 **设置 → 运行诊断**。重点看：

- `network-chatgpt`：验证 Responses daemon 到 ChatGPT/Codex 上游的真实 HTTPS 连通性；
- `network-openai`：Full Harness 下验证 OpenAI API / tunnel control plane 连通性；
- `tunnel-runtime`：验证 tunnel-client 自身是否已经 ready；
- `proxy`：这里只表示本地 `127.0.0.1:17841` Bridge 是否健康，不代表公网网络一定正常。

因此“`proxy` 绿色、`network-chatgpt` 红色”通常就是外网/代理问题，而不是 Bridge 本身坏了。

### 代理认证与隐私

Launcher 的“自定义代理”会明确拒绝 `user:password@host` 形式，避免把代理账号密码写进普通 `launcher-state.json`。如果企业代理需要认证，请通过环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 提供，并保持“自动”模式。AsterBridge 的诊断摘要和日志只显示协议、主机和端口；不要把带凭据的环境变量值贴到 GitHub Issue。

## RoxyBrowser

### Profile 关闭后能否自动恢复？

可以。需要同时满足：

1. Launcher 中开启自动启动；
2. RoxyBrowser Local API 在 loopback 上启用；
3. API Key 已保存；
4. Profile ID 和数据根目录正确。

Doctor 在 Profile 关闭时会主动探测 Local API：如果 Local API 健康，会报告“下一轮可自动打开”，而不是把关闭状态误判为不可恢复故障。

### Live Preview 有画面，但我想手动操作

点击 Launcher 浏览器页的 **人工接管 / Take control**。动作会投递给当前 turn 的 Browser Worker，由它恢复并激活对应的 Roxy task window；Launcher 不会建立第二个 CDP 控制器。

### 不要做的事情

- 不要让 Electron、Chrome 或 Edge 直接共用 Roxy 的 Profile 目录。
- 不要把 Cookie/localStorage 导出后复制到其他浏览器来“迁移指纹”。
- 不要把 API Key、Profile 压缩包或完整 `DevToolsActivePort` websocket 路径上传到 Issue。

## MCP / Codex Native3

### 推荐排查顺序

1. Browser-only 模式先验证 `WEB_OK`。
2. Doctor 确认 `Responses proxy`、Codex route 正常。
3. MCP 页面确认 Tunnel runtime healthy。
4. ChatGPT 中确认新 App 名称与 Launcher 完全一致：默认 `Codex Native3`。
5. Launcher **Verify runtime**。
6. 最后再测试 `Write-Output MCP_OK` 这类无副作用工具。

不要把这六步一次性混在一起，否则无法判断是浏览器、Tunnel、Connector 还是 Codex Harness 出错。

## Launcher / Runtime

### Launcher 看起来启动了，但 Bridge 暂时没起来

源码或升级后的 Launcher 可能先执行 stale-owner recovery，再启动 17841 daemon。查看 **活动** 页面；只要最终出现 `runtime.daemon_started` 和 `listening on http://127.0.0.1:17841/v1` 即可。不要同时双击多个 Launcher 实例。

### 需要恢复 Codex 原来的路由

使用 **设置 → 移除 Codex 集成**。该流程会尝试恢复安装前记录的 Codex route。不要直接删除 config 文件，因为那会丢失可验证的恢复状态。

## 提交 GitHub Issue 前

请提供：

- OS / 架构；
- Launcher 版本；
- Codex 版本；
- 浏览器模式（Embedded / Roxy / System Browser）；
- Browser-only 还是 Full Harness；
- Doctor 中失败的 check 名称和脱敏 detail；
- Activity 中从“第一个 error/warning”开始的相关几行。

请删除：API Key、Tunnel token、Cookie、Bearer token、完整 turn token、个人 Profile、提示词正文和私人文件路径中不必要的身份信息。
