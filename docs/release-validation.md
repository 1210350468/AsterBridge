# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account. Treat it as a first-user journey, not just an internal feature checklist:

1. Install the packaged launcher on a clean Windows profile by following only `README.md` and `docs/quick-start.md`. Prove that no undocumented terminal step is required and that the embedded Bun runtime starts.
2. Prove network onboarding before model setup: with no explicit proxy, confirm **Automatic** reports the expected source; then test **Direct** and a valid **Custom** HTTP proxy. Verify local `127.0.0.1:17841` and Roxy `127.0.0.1:50000` stay bypassed through `NO_PROXY`, the managed daemon/tunnel restarts safely, and Doctor distinguishes `network-chatgpt` / `network-openai` failures from local Bridge health.
3. Prove the simplest embedded-browser path: sign in, reach a usable Temporary Chat composer, run **Doctor**, install the model route, restart Codex once, and complete the documented `WEB_OK` Browser-only turn.
4. Prove the recommended Roxy path from a clean Launcher state: save a Profile ID/data root, run Doctor, and complete one Browser-only turn through that exact Profile without copying cookies or browser state. Confirm AsterBridge proxy settings do not silently rewrite the Roxy profile's own proxy configuration.
5. Close the configured Roxy Profile completely, enable auto-open, and prove that Doctor reports either a reachable Profile or a healthy Local API ready to auto-open it. Start a turn and prove the Profile opens automatically instead of producing an unclassified stream disconnect.
6. During a live Roxy turn, prove Launcher **Live Preview** shows a real task frame/stage and **Take control** activates the matching Roxy task window without creating a second CDP owner. Let the same turn finish successfully afterward.
7. Prove every account-available ChatGPT Web effort appears exactly once in Codex without removing native models. A WebSocket `426` followed by successful HTTP/SSE fallback must not be reported to the user as a setup failure.
8. Configure a fresh `Codex Native3` connector, run **Verify runtime**, and complete one Full-mode harmless local tool turn. Confirm that retired `Codex Native` / `Codex Native2` identities produce an explicit migration error rather than being silently reused. Repeat with Pro when the account exposes Pro.
9. Drive a chat past the compaction threshold and prove that it continues after compaction without a duplicate/orphaned browser turn. Verify terminal browser pages are released so later turns do not consume the five-turn safety limit.
10. Cancel a running turn from Launcher and cancel another from Codex; prove neither recreates a browser page nor leaves HTTP/browser activity counters busy.
11. Quit/reopen the launcher around an idle runtime and around an active-turn cancellation. Prove stale-owner recovery is bounded, the saved browser/Roxy/proxy configuration survives, and the Responses daemon returns to `127.0.0.1:17841` without launching duplicate owners.
12. Disconnect the bridge and prove that the exact previous Codex route is restored. Reconnect it and prove existing private MCP/Roxy credentials are reused rather than exposed or replaced.
13. Upgrade from the previous public release. Prove Launcher state, Roxy/proxy settings, browser state, Codex settings, and private MCP configuration survive; prove old `Codex Native2` local configuration is migrated to the required `Codex Native3` identity with a clear user action.
14. Run **Settings → Run diagnostics** in at least four failure states (bad proxy/public upstream unreachable, closed Roxy without auto-open, invalid/unreachable Local API, stopped Tunnel). Confirm each failure points to the correct recovery action. Use **Copy diagnostic summary** and verify the clipboard text contains no API credentials, proxy credentials, token, cookie, full turn token, prompt body, or Doctor `detail` field.
15. Open the GitHub bug form from a clean browser and verify its Quick Start/Troubleshooting links resolve, the required fields match the support workflow, and the security checklist prevents accidental credential sharing.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

## macOS gate

Repeat items 2 through 10 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
