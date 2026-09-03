# AsterBridge troubleshooting

Start with **Launcher → Settings → Run diagnostics**. Do not delete app data, browser profiles, Codex configuration, or Tunnel credentials unless a recovery step explicitly requires it.

## Fast failure matrix

| Symptom / error | What it means | What to do |
| --- | --- | --- |
| `browser_unavailable` / `RoxyBrowser profile ... is not open` | The selected Roxy profile has no usable CDP endpoint | Enable profile auto-open; after reboot, also set the RoxyBrowser executable path so AsterBridge can start the main app before opening the profile |
| `is not exposing a reachable Chromium CDP endpoint` | `DevToolsActivePort` is missing/stale or its port is unreachable | Fully close/reopen the profile; verify Profile ID and data root in Launcher |
| `stream disconnected before completion` after a browser error | The browser task failed upstream | Fix the earliest browser error first; do not treat the final stream message as the root cause |
| `HTTP 426 Upgrade Required` on `/v1/responses` | WebSocket is unavailable and Codex falls back to HTTP/SSE | Ignore it if the turn completes; investigate only if the fallback also fails |
| `127.0.0.1:17841` / `EADDRINUSE` | A stale/second Launcher or another process owns the Bridge port | Quit old Launcher instances and restart one Launcher; do not repoint Codex to an unknown port |
| Models work but native tools do not | Browser-only mode or MCP Full Harness is not configured/verified | Prove `WEB_OK`, then configure **MCP Full Harness** and run Doctor. Use the Responses bridge only when you explicitly selected that experimental fallback |
| ChatGPT cannot find the App / Connector | Name mismatch or stale cached MCP schema | Create a fresh App named exactly `Codex Native3`; do not reuse `Codex Native` / `Codex Native2` |
| Tool call is blocked by safety checks | ChatGPT App permissions blocked it or outer Codex sandbox/approval rejected it | Check the MCP App permissions first, then Codex sandbox/approval. Outer Codex remains the final execution authority |
| `turn token is invalid, expired, or revoked` | The MCP capability does not belong to the live outer Codex turn, or an old App/session was reused | Use the current `Codex Native3`, start a fresh Codex turn, and never reuse turn tokens manually |
| `ChatGPT is signed out in the configured browser profile` / `chatgpt_session_expired` | The external Roxy/system-browser profile can open ChatGPT but new pages are no longer authenticated; older retained pages may still look usable because their SPA state was already loaded | Sign in to `chatgpt.com` again inside that exact browser/Profile, then rerun Browser check/Doctor. AsterBridge cannot recreate account credentials itself. |
| `missing YAML frontmatter delimited by ---` | A local Codex Skill file is invalid | Unrelated to Roxy/Bridge; ensure the file begins with `---` at byte 0 (no leading blank line/BOM), or disable that Skill if unused |
| Image generation returns `502` / `503` / `504` | The native Codex image request hit an upstream gateway or the local proxy transport failed; on older builds Temporary Chat could also choose ChatGPT's separate first-party image tool and bypass AsterBridge entirely | On 3.0.11+, inspect `[asterbridge:image]`: `origin=upstream` means the Codex image endpoint returned the status; `origin=transport` means local proxy/network fetch failed. If an older build reports image 502 but emits no broker `image_gen__imagegen` call and no image telemetry, it used the wrong first-party path. 3.0.13+ forces outer Codex image routing whenever that tool is advertised. |
| Sending many images repeatedly times out after attachment | ChatGPT accepted the image tiles, but the fixed submission-acknowledgement deadline was too short for image-heavy turns | 3.0.13+ sizes both upload and send acknowledgement budgets from image count and aggregate bytes (bounded to 300 s upload / 120 s send). Keep the existing 10-image, 20 MB/image, 50 MB/turn bounds. |
| RoxyBrowser accumulates Temporary Chat windows | Completed conversations are retained briefly for fast continuation; maintenance probes on older builds could also leave a separate cached page | Retained conversation pages are bounded to five, LRU-evicted, and expire with the session registry. 3.0.13+ makes Browser check / Doctor-style session probes / connector verification / smoke pages ephemeral and closes them on both success and failure. |
| `fatal: detected dubious ownership` | Git repository ownership differs from the execution user | Unrelated to Roxy/Native3; handle Git `safe.directory` according to your security policy rather than globally weakening every repo |
| Tunnel health never becomes ready | tunnel-client, Runtime Key, Tunnel ID, network, or ownership problem | Use Launcher MCP + Doctor `tunnel-*` checks before recreating the ChatGPT App |
| `ChatGPT/Codex upstream is not reachable` | The Responses daemon cannot reach the ChatGPT/Codex upstream; a common cause is proxy settings not reaching the Bun child process | Open **Settings → Network proxy**, try Automatic first, then a custom HTTP proxy if needed, and rerun Doctor |
| `OpenAI API/tunnel control plane is not reachable` | MCP tunnel-client cannot reach the OpenAI control plane | Verify the configured proxy allows HTTPS CONNECT and rerun Doctor. Ignore this only if you explicitly chose the experimental Responses fallback |
| GitHub update checks fail while Web models still work | GitHub Releases are blocked by the current network path | AsterBridge Updater follows the same HTTP/HTTPS proxy environment; verify access to `github.com` and retry |

## Image generation reliability and upload bounds

AsterBridge deliberately keeps image transport bounded. One Web turn can attach at most **10 images**, each image can be at most **20 MB**, and the combined image payload can be at most **50 MB**. When a replayed Codex thread contains more than ten real images, only the newest ten are re-attached; older image positions remain as text placeholders so the model knows older visual context was omitted. The outer Codex image-generation tool independently caps `num_last_images_to_include` at **5** and never invents historical images that are not present.

A retained Temporary Chat page is cheaper: continuation sends only the new canonical suffix and does not re-upload unchanged historical images. If that page is closed, evicted, or Launcher restarts, AsterBridge rebuilds from canonical Codex history under the same ten-image / 50 MB bounds. Retained conversation surfaces use a 30-minute session TTL and a hard five-surface account-safety ceiling; LRU eviction can release an older idle surface earlier. Compaction retirement releases the old retained surface after its canonical handoff, while failed/aborted turns close their non-retained page in `finally`.

On 3.0.13+, external-browser maintenance work is separate from retained conversations: Browser check, session/capability inspection, connector verification, and smoke probes close their temporary page after both success and failure. If five retained pages already exist, maintenance first evicts the oldest idle retained page rather than opening a sixth physical ChatGPT surface.

Generated PNG/JPEG assets are user files under `~/.codex/generated_images`. AsterBridge does **not** delete them automatically. Doctor reports the current file count and storage usage so long-running image workflows can be cleaned deliberately rather than silently losing assets.

For native image requests, 3.0.11+ emits a privacy-safe diagnostic such as `endpoint=images/generations durationMs=59240 status=502 origin=upstream retryable=true`. It never logs prompts, image bytes, bearer tokens, or proxy credentials. `origin=upstream` distinguishes a real Codex image endpoint status from `origin=transport`, which identifies a local fetch/proxy failure. A real 2026-08-31 investigation also recorded successful image-edit requests lasting about 54.5 s and 150.2 s through the same Windows proxy, disproving a fixed 60-second local proxy cutoff. Another reproduced "consecutive HTTP 502" turn produced no broker image call and no AsterBridge image telemetry at all: Temporary Chat had selected ChatGPT's first-party image generator. 3.0.13+ explicitly forbids that split path whenever outer `image_gen__imagegen` is available.

For multi-image input, 3.0.13+ decodes each image once, then derives bounded stage budgets from file count and aggregate bytes. Text-only submission keeps the short 20-second acknowledgement budget; image turns receive 45–120 seconds for submission acknowledgement and 120–300 seconds for attachment processing. This specifically addresses the observed eight-image case where file tiles completed in roughly 13–17 seconds but submission acknowledgement repeatedly crossed the previous fixed 20-second deadline.

## Network and proxy

### Recommended configuration

Open **Launcher → Settings → Network proxy**:

- **Automatic (recommended)**: use `HTTPS_PROXY` / `HTTP_PROXY` when present; on Windows, fall back to the system proxy. This is the right default for Clash, Clash Verge, V2RayN, and similar clients that enable the Windows system proxy.
- **Direct**: explicitly clear proxy variables for AsterBridge-managed child processes. Use this only when your network can reach ChatGPT/OpenAI/GitHub directly.
- **Custom proxy**: enter `127.0.0.1:7890` or `http://127.0.0.1:7890`. AsterBridge supplies it to the Responses daemon, tunnel-client, and built-in updater.

AsterBridge automatically adds `127.0.0.1`, `localhost`, and `::1` to `NO_PROXY`, so local services such as Bridge `17841` and Roxy Local API `50000` are never sent through the external proxy.

> This setting controls the AsterBridge daemon, tunnel-client, and built-in updater. It does not rewrite the proxy/fingerprint network settings of a RoxyBrowser profile. Configure Roxy browser egress inside that profile; the embedded browser continues to follow Electron/system networking.

### Why can Windows system proxy be enabled while Bun still times out?

This was a real failure encountered during development. Browsers commonly use WinINET/system proxy settings automatically, while Bun, CLI child processes, or tunnel-client may use a different networking stack. A working Chrome/Edge session therefore does not prove that the Responses daemon can reach its upstream.

Automatic mode explicitly imports the Windows system proxy into `HTTPS_PROXY` / `HTTP_PROXY` for managed child processes. After changing proxy mode, Launcher attempts to restart the managed daemon and tunnel. If a Codex turn is active, the settings are saved and Launcher tells you to restart AsterBridge after the turn finishes.

### Which Clash/V2Ray port should I use?

Prefer the client's **HTTP or mixed HTTP proxy port**, for example:

```text
http://127.0.0.1:7890
```

Do not paste a SOCKS5-only port into the HTTP proxy field. AsterBridge intentionally accepts only `http://` and `https://` in this unified setting so Bun, the Node updater, and tunnel-client share one proxy contract.

### Precedence in Automatic mode

```text
HTTPS_PROXY / https_proxy
→ HTTP_PROXY / http_proxy
→ ALL_PROXY / all_proxy
→ Windows system proxy
→ direct connection
```

If a stale environment variable is overriding your current Clash configuration, choose Custom to override it explicitly, or Direct to disable proxies for AsterBridge.

### How do I prove the proxy is actually working?

Save the setting, then run **Settings → Run diagnostics**. Check:

- `network-chatgpt`: real HTTPS reachability from the managed runtime to the ChatGPT/Codex upstream;
- `network-openai`: MCP reachability to OpenAI API / tunnel control plane;
- `tunnel-runtime`: whether the MCP tunnel-client itself is ready;
- `proxy`: only the health of the local `127.0.0.1:17841` Bridge. It does not prove public-network connectivity.

So a green `proxy` check with a red `network-chatgpt` check is usually a network/proxy problem, not a broken local Bridge.

### Proxy credentials and issue privacy

The Launcher Custom field intentionally rejects `user:password@host` URLs so proxy credentials are never written to ordinary `launcher-state.json`. If an enterprise proxy requires authentication, provide it through `HTTPS_PROXY` / `HTTP_PROXY` in the environment and keep **Automatic** mode enabled. AsterBridge diagnostic summaries and logs show only protocol, host, and port; never paste credential-bearing environment values into a GitHub issue.

## RoxyBrowser

### Can a closed profile recover automatically?

Yes, when all of the following are true:

1. Profile auto-open is enabled in Launcher.
2. RoxyBrowser Local API is enabled on loopback.
3. The API key is saved in Launcher.
4. Profile ID and profile-data root are correct.
5. For full reboot recovery, **Launcher settings → RoxyBrowser executable** points to the real application/executable.

When the profile is closed, Doctor probes the Local API. A healthy API is reported as "closed but ready to auto-open" instead of a hard failure. If Local API is completely unavailable and an executable path is configured, AsterBridge starts the RoxyBrowser application first and waits for Local API to become ready.

### Live Preview works but I need manual control

Click **Take control** on the Browser page. The action is delivered to the Browser Worker that owns the live turn, which restores/activates the matching Roxy task window. Launcher does not create a second CDP controller.

### Do not do this

- Do not share the Roxy profile directory with Electron, Chrome, or Edge.
- Do not export/copy cookies or localStorage to imitate a fingerprint migration.
- Do not post API keys, profile archives, or full `DevToolsActivePort` websocket paths in issues.

## Native tools / MCP Full Harness

Primary MCP / `Codex Native3` path:

1. Prove Browser-only `WEB_OK`.
2. MCP page: Tunnel runtime healthy.
3. ChatGPT: fresh App name exactly matches Launcher (`Codex Native3` by default).
4. Launcher: **Verify runtime**.
5. Test a harmless native command such as `Write-Output MCP_OK` and require the real outer-Codex tool result.

Experimental Responses fallback:

1. Use only after Browser-only is healthy and only through explicit opt-in.
2. Doctor must report that the Responses tool bridge is active; Tunnel/Connector checks are intentionally absent.
3. If you see `ChatGPT direct tool bridge returned invalid JSON`, stop using that fallback and return to Browser-only/MCP instead of repeatedly retrying malformed Web generations.

Keeping the two transports separate makes it obvious whether a failure is browser/MCP, or specific to the experimental connectorless bridge.

## Launcher / Runtime

### Launcher is visible but Bridge is not ready yet

Source/upgraded Launcher may perform stale-owner recovery before it starts the 17841 daemon. Check **Activity**. A healthy recovery eventually logs `runtime.daemon_started` and `listening on http://127.0.0.1:17841/v1`. Do not start multiple Launcher instances while recovery is in progress.

### Restore the previous Codex route

Use **Settings → Remove Codex integration**. This path restores the recorded pre-install route when possible. Do not delete config files first, because doing so removes the evidence needed for safe restoration.

## Before filing a GitHub issue

Include:

- OS / architecture;
- Launcher version;
- Codex version;
- Browser mode (Embedded / Roxy / System Browser);
- Browser-only vs Full Harness;
- failed Doctor check names and redacted detail;
- relevant Activity lines beginning with the first warning/error.

Remove API keys, Tunnel tokens, cookies, bearer tokens, full turn tokens, browser profiles, prompt contents, and unnecessary personal path details.
