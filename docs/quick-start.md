# AsterBridge: 10-minute quick start

This guide is for first-time GitHub users installing AsterBridge; `codex-chatgpt-web` remains the internal compatibility name. The goal is to prove one ChatGPT Web model turn first, then enable native Codex tools through the primary MCP Full Harness. The connectorless Responses bridge remains an explicit experimental fallback and is never selected automatically. If anything fails, do not keep reinstalling: run **Settings → Run diagnostics** and then use [Troubleshooting](troubleshooting.md).

## 1. Install the launcher

### Windows PowerShell

```powershell
irm https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.sh | sh
```

For an update or repair, quit the launcher first and run the same installer again. The app/runtime is replaced while launcher settings, private secrets, and saved browser configuration are preserved.

## 2. Network proxy (recommended check on Windows / Clash)

AsterBridge defaults to **Settings → Network proxy → Automatic (recommended)**. Automatic mode:

1. prefers `HTTPS_PROXY` / `HTTP_PROXY` when they are already present;
2. on Windows, imports the system proxy when those environment variables are absent;
3. always adds `127.0.0.1`, `localhost`, and `::1` to `NO_PROXY` so local Bridge/Roxy services never go through the external proxy.

If a browser can open ChatGPT but Doctor reports `ChatGPT/Codex upstream is not reachable`, do not reinstall first. This commonly means the browser is using the Windows system proxy while Bun/tunnel child processes are not. Open **Settings → Network proxy**, choose **Custom**, and enter the HTTP/mixed proxy port, for example:

```text
http://127.0.0.1:7890
```

After saving, Launcher attempts to restart the managed daemon/tunnel automatically. See [Network and proxy](troubleshooting.md#network-and-proxy) for precedence, Clash/V2Ray port guidance, and Doctor checks.

## 3. Choose the browser backend

| Mode | Recommendation | Best for |
| --- | --- | --- |
| **RoxyBrowser** | Recommended when a stable external profile is important | Fixed login environment, auto-start, Live Preview, manual takeover |
| **Embedded browser** | Simplest default | First use without extra software |
| **Chrome / Edge** | Experimental | Developers who already enabled main-browser remote debugging |

### RoxyBrowser setup

1. Create a dedicated RoxyBrowser profile and sign in to ChatGPT there.
2. Open Launcher → **Settings → Use RoxyBrowser for ChatGPT turns**.
3. Enter the profile/window ID and the profile-data root.
4. Enable **Automatically open the RoxyBrowser profile** if you want zero-touch startup.
5. If you also want reboot recovery, set **RoxyBrowser executable** to the absolute application/executable path. When Local API is unavailable, AsterBridge starts RoxyBrowser first, waits for Local API, then lets the existing profile auto-open flow continue.
6. For auto-start, enable RoxyBrowser Local API and enter the Local API key in Launcher. The key is stored only in an owner-only private secrets file, never in ordinary config or logs.
7. Run **Launcher settings → Run diagnostics** once. Continue when the doctor reports that the profile is reachable, or that it is closed but Local API is healthy and ready to auto-open it.

Do not point Electron/Chrome directly at the Roxy profile directory and do not copy cookies manually. The project connects to the Chromium CDP endpoint exposed by Roxy itself.

## 4. Install the ChatGPT Web models

Open **Model setup**:

1. Complete embedded-browser login or Roxy profile configuration.
2. Click **Install models**.
3. Fully quit and reopen Codex once.
4. Select a `ChatGPT Web — ...` model in Codex.

First prove the browser path with a trivial prompt:

```text
Reply with exactly: WEB_OK
```

Keep this first Browser-only proof separate from tool-transport debugging.

## 5. Enable MCP Full Harness (primary tool path)

1. Return to Launcher → **MCP**.
2. Create or reuse the OpenAI Tunnel and Runtime Key. Keep credentials in Launcher; never paste them into chat or issue logs.
3. Create the matching ChatGPT custom App with **Tunnel**, **Authentication: None**, and the exact Launcher name (default `Codex Native3`).
4. Run **Connect Harness / Verify runtime**.
5. Test a harmless native tool call, for example:

```text
Use Codex Native3 to run exactly: Write-Output MCP_OK
```

Treat the test as passed only when the real outer Codex tool result returns `MCP_OK`. MCP is preferred because ChatGPT can remain in one response while requesting multiple tools; AsterBridge transports the requests, while outer Codex owns approval, sandboxing, and execution.

### Experimental fallback: Responses direct tool bridge

If the current ChatGPT account cannot expose a custom MCP App, that is an account-side MCP limitation. Browser-only remains supported. A connectorless Responses tool bridge also exists for explicit testing, but AsterBridge does not switch to it automatically. Dependent tool chains may require additional Web generations, and the private text-envelope transport is less robust than MCP. Enable it only through the explicit advanced/CLI opt-in when you intentionally want that trade-off.

## 6. Recommended daily settings

- Roxy users: enable auto-start; use Launcher Live Preview and click **Take control** only for login/CAPTCHA/manual intervention.
- Enable **Keep running after Launcher closes** if you want the local Responses route and primary MCP tunnel to stay warm.
- Run **Settings → Run diagnostics** before deleting configuration or reinstalling.
- For GitHub issues, share only redacted Doctor/Activity output. Never post cookies, API keys, tunnel tokens, full turn tokens, or browser profiles.

## 7. Healthy installation checklist

A healthy Roxy + MCP Full Harness setup normally has:

```text
Configuration       OK
Launcher ownership  OK
RoxyBrowser         OK / auto-open ready
Codex route         OK
Responses proxy     OK (127.0.0.1:17841)
ChatGPT upstream    OK
OpenAI/Tunnel       OK
Connector           Codex Native3 verified
Tools               MCP Full Harness; outer Codex owns execution
```

If you explicitly select the experimental Responses transport, Doctor reports that transport instead and does not require Tunnel/Connector state.

A `/v1/responses` WebSocket `426 Upgrade Required` followed by HTTP/SSE fallback is expected in the current implementation and is not a failure by itself.

Next: [Troubleshooting](troubleshooting.md).
