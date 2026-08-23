# AsterBridge: 10-minute quick start

This guide is for first-time GitHub users installing AsterBridge; `codex-chatgpt-web` remains the internal compatibility name. The goal is to prove one ChatGPT Web model turn first, then enable MCP/native Codex tools only if you need them. If anything fails, do not keep reinstalling: run **Settings → Run diagnostics** and then use [Troubleshooting](troubleshooting.md).

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
5. For auto-start, enable RoxyBrowser Local API and enter the Local API key in Launcher. The key is stored only in an owner-only private secrets file, never in ordinary config or logs.
6. Run **Settings → Run diagnostics** once. Continue when the doctor reports that the profile is reachable, or that it is closed but Local API is healthy and ready to auto-open it.

Do not point Electron/Chrome directly at the Roxy profile directory and do not copy cookies manually. The project connects to the Chromium CDP endpoint exposed by Roxy itself.

## 4. Install the ChatGPT Web models

Open **Setup**:

1. Complete embedded-browser login or Roxy profile configuration.
2. Click **Install models**.
3. Fully quit and reopen Codex once.
4. Select a `ChatGPT Web — ...` model in Codex.

First prove the browser path with a trivial prompt:

```text
Reply with exactly: WEB_OK
```

Do not configure MCP until this succeeds. That keeps browser failures separate from Tunnel/Connector failures.

## 5. Optional: enable native Codex tools through MCP

You need this only if ChatGPT Web models should call the current Codex Harness for shell, files, patches, and other native tools.

1. Open Launcher → **MCP**.
2. Create an OpenAI Tunnel and a Runtime Key for that Tunnel.
3. The current release defaults to a fresh App/Connector identity: **`Codex Native3`**. Do not reuse the retired `Codex Native` or `Codex Native2` App identities because ChatGPT caches MCP schemas by App identity.
4. In ChatGPT Developer Mode, create a new App:
   - Type: Tunnel
   - Tunnel: the one you created
   - Authentication: None
   - Name: exactly the name shown by Launcher (default `Codex Native3`)
   - Permissions: Allow all operations when you expect commands/patches; low-risk mode may block them before they reach Codex.
5. Return to Launcher and run **Connect Harness / Verify runtime**.
6. Test a harmless native tool call, for example `Write-Output MCP_OK` through `Codex Native3`.

## 6. Recommended daily settings

- Roxy users: enable auto-start; use Launcher Live Preview and click **Take control** only for login/CAPTCHA/manual intervention.
- Enable **Keep running after Launcher closes** if you want the Bridge/Tunnel to stay warm.
- Run **Settings → Run diagnostics** before deleting configuration or reinstalling.
- For GitHub issues, share only redacted Doctor/Activity output. Never post cookies, API keys, tunnel tokens, full turn tokens, or browser profiles.

## 7. Healthy installation checklist

A healthy Roxy + Full Harness setup normally has:

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

A `/v1/responses` WebSocket `426 Upgrade Required` followed by HTTP/SSE fallback is expected in the current implementation and is not a failure by itself.

Next: [Troubleshooting](troubleshooting.md).
