<h1 align="center">AsterBridge</h1>

<p align="center">
  <strong>A local bridge from Codex to ChatGPT Web and native tools.</strong><br>
  RoxyBrowser runtime · Live Preview · Native3 MCP · local-first desktop control.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="docs/quick-start.md">10-minute quick start</a> · <a href="docs/troubleshooting.md">Troubleshooting</a>
</p>

<p align="center">
  <a href="https://github.com/1210350468/AsterBridge/actions/workflows/ci.yml"><img src="https://github.com/1210350468/AsterBridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free and Go accounts get **ChatGPT Web — Luna** in Codex's native model picker. Accounts that
expose the reasoning selector keep **Instant**, **Medium**, **High**, **Extra High**, and **Pro** as
their subscription allows. The bridge sends the current compiled Codex task context to a fresh
ChatGPT Temporary Chat, attaches images, and streams visible reasoning, tool activity, and Markdown
back into the same Codex task.

> **About the name.** AsterBridge is an independent community evolution of
> [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web), with the original MIT attribution
> preserved. Some internal paths, CLI names, model slugs, and release asset names intentionally retain
> `codex-chatgpt-web` compatibility so upgrades do not discard existing sessions or runtime state.

<p align="center">
  <img src="assets/demo.gif" alt="A live ChatGPT Web turn using the native Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──browser runtime──▶ ChatGPT
     ▲                                │                                     │
     └──────── native UI, context, images, tracing, and tool lifecycle ─────┘
```

Codex keeps the native task, context lifecycle, UI, and tool harness. The local Responses bridge
opens a ChatGPT Temporary Chat for the selected task and retains that task-bound surface across
compatible follow-up turns; in full mode, MCP connects ChatGPT back to the tools of that same Codex
task.

## Highlights

- **A polished cross-platform launcher.** One command installs the native macOS, Windows, or Linux
  app. It keeps sign-in orchestration, setup, smoke testing, MCP guidance, runtime health, and local
  logs in one place. The embedded browser is the simplest default; RoxyBrowser can act as a stable
  external runtime with automatic profile startup, Live Preview, and one-click manual takeover. Up
  to five task-bound browser turns can run in parallel; the cap avoids excessive parallel account
  traffic.
- **ChatGPT is the selected model.** It runs as a native Codex model, not as a tool called by
  another host model. The original model picker, task lifecycle, streaming, tracing, and tool UI
  remain intact.
- **Local-first retained task sessions.** Codex remains the source of truth for task history on your
  computer. The first browser turn opens a fresh ChatGPT Temporary Chat; compatible follow-up turns
  in the same Codex task reuse that retained surface without re-mentioning the connector. Native
  compaction closes the old epoch only after a checkpoint is proven and starts a fresh epoch when
  needed. Browser chats are never reused across different tasks or added to normal ChatGPT history.
- **The full Codex harness over MCP.** In Full mode, every effort available to the signed-in account—
  Luna, Instant, Medium, High, Extra High, and Pro—can use the active Codex task's filesystem,
  shell, images, approvals, and configured tools/apps through the same turn-bound MCP capability.
  Calls and real results stay inside the same browser response; nothing is simulated as text.
- **Subagents stay native to Codex.** Full mode carries deferred Multi-agent tools through the
  existing `Codex Native3` contract. Compatibility V1 remains the safe default, while Native mode
  can preserve current Codex agent-version metadata; parent waits use bounded polling so one child
  cannot monopolize the MCP channel.
- **Optional Bigger Context.** Settings can enable a reversible transactional 2/3-part context
  transport for large non-Luna tasks. Earlier parts are inert and SHA-256 acknowledged; only the
  final commit starts execution. Standard single-message transport remains the default.
- **No Pro exception.** Pro follows exactly the same MCP, context, image, tracing, tool-round,
  browser-ceiling, and compaction contracts as every other effort. There are no effort-specific MCP
  exclusions. Browser-only mode remains read-only for every route.
- **Fail-closed with an explicit release gate.** UI drift and missing capabilities produce explicit
  errors rather than silent fallbacks. Account-bound model selection, long context, images,
  streaming, compaction, native tool rounds, cancellation, and Pro are covered by the documented
  [release validation](docs/release-validation.md), separately from package smoke.

Temporary Chat is a ChatGPT privacy mode, not anonymity or local-only inference: prompts are still
processed by OpenAI and are subject to the account's settings and OpenAI's
[Temporary Chat policy](https://help.openai.com/en/articles/8914046-temporary-chat-faq). This project
is unofficial; users remain responsible for complying with applicable OpenAI terms and workspace
policies.

## Quick start

Install or update the desktop launcher. To update or repair an existing installation, quit the
launcher and run the same command again; it replaces the application and embedded runtime while
preserving the ChatGPT profile and launcher configuration.

**macOS or Linux**

```bash
curl -fsSL https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/1210350468/AsterBridge/releases/latest/download/install-launcher.ps1 | iex
```

Then follow the [10-minute quick start](docs/quick-start.md). In short:

1. Check **Settings → Network proxy**. Automatic mode inherits environment proxies and, on Windows,
   imports the system proxy; use Custom if Clash/V2Ray uses a dedicated HTTP/mixed port.
2. Choose the browser backend. The embedded browser is simplest; RoxyBrowser is recommended when you
   want a fixed external profile with automatic startup and Live Preview.
3. Run **Settings → Run diagnostics** once before installing models.
4. Press **Install models**, restart Codex once, and prove a simple `WEB_OK` turn.
5. Configure **MCP Full Harness**. MCP is AsterBridge's primary native-tool transport because one ChatGPT Web response can remain in a continuous tool loop while outer Codex performs the real approvals, sandboxing, and execution. The Responses direct-tool bridge remains an explicit experimental fallback for accounts that cannot use a custom MCP App; it is not enabled automatically. Enable **Bigger Context** only when you need larger task transport.

### Copy this into an AI agent: install and prove AsterBridge end to end

If you prefer not to work through the terminal yourself, paste the prompt below into an AI agent that can operate your local terminal/desktop (for example Codex, Claude Code, or Cursor Agent). It tells the agent to prefer the signed Release path and to keep secrets out of chat.

```text
Install and prove AsterBridge end to end on this computer. Repository: https://github.com/1210350468/AsterBridge

Requirements:
1. Detect the OS plus any existing AsterBridge/Codex installation. Prefer the latest GitHub Release installer/script. Build from source only if a Release is unavailable. Before repair/update, quit AsterBridge safely and preserve user configuration.
2. Never ask me to paste API keys, Tunnel runtime keys, cookies, bearer tokens, a RoxyBrowser API key, or a complete turn token into chat. When credentials are needed, tell me to enter them only in the local AsterBridge UI or the appropriate official account page.
3. Start AsterBridge and run Doctor first. For network failures, check AsterBridge > Launcher settings > Network proxy. On Windows, prefer Automatic so it can inherit the system proxy. Do not randomly modify the global proxy or wipe configuration.
4. If RoxyBrowser is selected, verify that the RoxyBrowser application is running, Local API is enabled, and AsterBridge can reach 127.0.0.1:50000. A closed Profile should be opened by AsterBridge. Do not copy browser cookies.
5. Install models from Model setup, restart Codex, then run an actual chatgpt-web/high turn (or another available ChatGPT Web model) that must reply exactly WEB_OK. Do not continue until WEB_OK succeeds.
6. Configure MCP only after Browser-only works. Reuse safely stored Tunnel/profile/key material when present. If first-time credentials are needed, have me enter them only in the local AsterBridge UI; never paste them into chat. Confirm the ChatGPT App name exactly matches Launcher (default `Codex Native3`).
7. Use chatgpt-web/high through MCP to execute the harmless command `Write-Output ASTERBRIDGE_FULL_OK`. Full Harness is proven only when the real outer-Codex tool result returns `ASTERBRIDGE_FULL_OK`; do not accept a model claim as proof.
8. If the current ChatGPT account cannot expose a custom MCP App, report that account-side limitation. Do not silently switch the installation to the experimental Responses direct-tool bridge. Use that fallback only when I explicitly request it.
9. If any step fails, inspect AsterBridge Doctor, Activity logs, and docs/troubleshooting.md. Diagnose the earliest relevant warning/error instead of repeatedly reinstalling, deleting ~/.codex-chatgpt-web, or resetting Codex.
10. Finish with a concise status report: AsterBridge version, Codex version, browser backend, proxy source, Browser-only WEB_OK result, MCP/Native3 FULL_OK result, and any remaining manual action.
```

The launcher detects the current account's ChatGPT controls during setup: Free/Go accounts expose
only Luna, while Pro appears only when the signed-in account exposes it. The packaged launcher needs
no model API key, system Node/Bun, or project-managed browser download. RoxyBrowser is optional and
uses its own signed-in profile rather than copying browser cookies.

**Run from source**

```bash
git clone https://github.com/1210350468/AsterBridge.git && \
cd AsterBridge && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

## Modes

| Mode | Models | Local Codex tools | Extra setup |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna; Plus: Instant–High; Pro: adds Extra High and Pro | No | None |
| **Full · MCP (primary)** | Same account-available Web models | Yes | OpenAI Tunnel + custom ChatGPT App |
| **Full · Responses (experimental fallback)** | Same account-available Web models | Yes | Explicit CLI opt-in; no Tunnel/custom App, but tool-dependent work may require additional Web generations |

Every picker entry has one fixed ChatGPT mode. Codex still displays its built-in Effort and Speed rows, but changing them cannot silently change the selected browser model. In either Full transport, ChatGPT only proposes tool calls; outer Codex remains the execution, approval, and sandbox authority. AsterBridge never migrates an MCP installation to Responses without explicit opt-in.

## Full Harness: MCP / Codex Native3

MCP is the primary Full Harness transport. It uses the official [OpenAI tunnel-client](https://github.com/openai/tunnel-client); the tunnel is outbound and does not require router port forwarding. The main reason to prefer MCP is lifecycle efficiency: ChatGPT can stay inside one response while requesting multiple tool calls, rather than completing one Web generation for every dependent local-tool step.

> [!WARNING]
> The default connector/App name is **Codex Native3**. The retired **Codex Native** and **Codex Native2** identities are intentionally not reused because ChatGPT can cache MCP schemas by App identity. Leave old Apps untouched and create the fresh identity instead.

1. Finish Browser-only setup first.
2. Open **MCP** in the launcher and create/reuse a Tunnel plus its runtime key.
3. Create the matching custom ChatGPT App/connector; use **Tunnel**, **Authentication: None**, and the exact name shown by Launcher.
4. Run **Verify runtime**. A differently named or stale connector is not accepted as a substitute.
5. Prove a harmless real outer-Codex tool call before treating Full Harness as ready.

MCP availability and permissions are controlled by the ChatGPT account/workspace and can change independently of AsterBridge. If the account cannot expose a custom MCP App, Browser-only remains supported and the connectorless Responses bridge can be enabled explicitly as an experimental fallback. It is never selected silently because dependent tool chains can require extra Web generations and its text-envelope transport is less robust than native MCP. See [developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Outer Codex still enforces its sandbox and approvals.

## Operations

Use **Activity** for structured local logs and **Settings → Run doctor** for end-to-end health
checks. Doctor understands the selected Roxy profile/Local API as well as Bridge, Codex route, and
Tunnel state. After running it, **Copy diagnostic summary** produces a deliberately bounded support
report without secret values or Doctor detail fields. Use **Cancel active Codex turn** for a stuck
turn, and **Remove Codex integration** before deleting the launcher so the previous Codex route is
restored.

If setup stops at any step, use the [Troubleshooting guide](docs/troubleshooting.md) before deleting
configuration or reinstalling. GitHub bug reports have a structured template that asks for the
Doctor result and the first relevant warning/error while explicitly excluding keys, cookies, bearer
tokens, full turn tokens, and browser profiles.

Browser turn diagnostics save bounded JSON state at each checkpoint. Screenshots are captured for
stalled and failed turns, where the visible UI is needed to diagnose DOM drift without slowing every
successful step. Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` before starting the runtime to also
capture a screenshot at every checkpoint during an investigation.

## Limitations and security

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- ChatGPT's account-specific composer ceilings are smaller than some underlying model windows.
  The measured boundaries and requirements for a larger deterministic transport are tracked in
  [#76](https://github.com/miuuyy/codex-chatgpt-web/issues/76).
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and native packaging are gated on all three operating systems in CI. Account-bound browser
  and MCP flows require the separate [release validation](docs/release-validation.md); package smoke
  is not treated as end-to-end proof.
- Until platform signing credentials are configured for a release, macOS Gatekeeper or Windows
  SmartScreen may show an unknown-publisher warning. The one-command installers verify the
  published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Development

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run app:package
```

For release packaging, use the package scripts above (or `bun run --cwd launcher package:win` on Windows) rather than invoking `launcher/scripts/package.cjs` directly. The package scripts build the renderer and embedded runtime before electron-builder runs. `bun run app:smoke` then installs the real package, verifies the packaged Bun/runtime bundle and durable runtime, and on Windows also requires tray readiness. A Windows NSIS install can legitimately take several minutes on slower disks, so the smoke waits for installer completion instead of treating a 120-second partial extraction as a package failure.

### Use your main Chrome / Edge session for Web turns

The source launcher can keep ownership of the local bridge and MCP runtime while running actual ChatGPT Web turns in your normal signed-in Chrome or Edge session:

1. Open `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging`, enable remote debugging for the current browser instance, and approve the browser prompt.
2. Start `bun run app`, open **Settings**, and enable **Use my main browser for ChatGPT turns**.
3. Return to **Setup** and click **Install/Reinstall models**. Account capability detection, Temporary Chat preparation, model/effort selection, attachments, connector selection, tool confirmations, sending, and response parsing all use the same Browser Worker against the authorized main-browser page.
4. Restart Codex once. Each `chatgpt-web/*` turn opens a fresh task tab in the main browser and closes only that tab after completion; browser cookies are not copied and existing tabs are left alone.

The CLI equivalent is `setup ... --system-browser --system-browser-channel auto`. Auto mode considers only Chrome/Edge sessions whose debugging port is actually alive and selects the most recently enabled one.

### Use a RoxyBrowser fingerprint profile for Web turns

RoxyBrowser is the preferred external-browser host when ordinary Chrome/Edge remote debugging is unreliable. Open **Settings → Use RoxyBrowser for ChatGPT turns**, enter the RoxyBrowser profile/window ID and the absolute profile-data root (for example `E:\\roxybrowserdata`), save, then reinstall the models from **Setup**. The runtime reads that profile's Chromium `DevToolsActivePort` and connects only to that profile; it does not copy cookies or export the browser session.

If the selected profile is closed, the runtime now returns a structured `browser_unavailable` error with an actionable message instead of terminating the Responses stream as an unclassified CDP failure. Optionally enable **Automatically open the RoxyBrowser profile**. This uses RoxyBrowser's loopback Local API (normally `http://127.0.0.1:50000`) to open the configured profile before the turn. The Local API key is stored in the launcher's owner-only secrets directory; ordinary runtime configuration stores only the key-file path and never the key itself.

CLI equivalent:

```bash
codex-chatgpt-web setup --browser-only \
  --browser-host-descriptor <launcher-browser.json> \
  --roxy-browser-profile <dirId> \
  --roxy-browser-data-dir <absolute-profile-root>
```

Add `--roxy-browser-auto-open --roxy-browser-api-host http://127.0.0.1:50000 --roxy-browser-api-key-file <private-key-file>` only when RoxyBrowser Local API is enabled.

`dev:launcher` starts a second launcher profile under `~/.codex-chatgpt-web-dev`: separate Electron
state, browser cookies/login, ChatGPT account, configuration, sandboxed `CODEX_HOME`, chats,
diagnostics, broker, and tunnel profile. It can run beside the normal launcher and never starts a
Responses daemon or changes Codex. Optional Full setup starts and supervises only its isolated MCP
tunnel, using the distinct ChatGPT connector name `Codex Native3 DEV`.

`dev:chat` is a named, persistent synthetic outer-Codex harness. It executes the current working
tree through that isolated launcher browser, Temporary Chat, prompt compiler, Responses parser, and
compaction handlers. Optional Full setup also exercises the MCP connector and broker; tool effects
are explicit simulation receipts. Browser-only chats expose no outer tools. It does
not open a Responses listener, change `openai_base_url`, stop the live daemon, or claim port 17841.
Run it without a message for `/status`, `/fill 30000`, `/compact`, `/model`, and `/reset` commands.
Sign in and initialize the profile once inside the window labelled **DEV**. Configure optional Full
harness only for simulated tool rounds; its launcher keeps the DEV tunnel ready while named chats
attach their broker on demand. Production credentials and the `Codex Native3` connector are never
reused implicitly. See
[DEV chat harness](docs/dev-chat.md).

- [Architecture](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [Security model](docs/security-model.md)
- [Contributing](CONTRIBUTING.md)

## Project home

- Repository: https://github.com/1210350468/AsterBridge
- Issues: https://github.com/1210350468/AsterBridge/issues
- Releases: https://github.com/1210350468/AsterBridge/releases

## Disclaimer

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.
