# Changelog

All notable AsterBridge changes are documented here.

## 3.0.10 - 2026-08-31

### Conversation and Full Harness usability

- Reduced Full Harness tool bias for context-only tasks. When a request can be answered entirely from the supplied Codex conversation context, AsterBridge now tells the Web model not to call native tools merely to echo/format text, perform trivial arithmetic, or recall prior messages; explicit user `no tools` requests are honored unless the requested operation genuinely requires a tool.
- Kept the five-physical-page account safety limit while removing an avoidable sixth-thread failure. When all five slots include completed retained external-browser conversations, a new conversation now evicts the least-recently-used idle retained page and reconstructs that thread from Codex context if it is resumed later. Five genuinely active turns still fail closed rather than exceeding the safety limit.
- Retained external pages now refresh their recency when reused, so idle eviction follows actual recent use instead of original creation order.

### Validation notes

- Live Windows context continuity passed on `chatgpt-web/high`: the same fresh Codex thread recalled exact prior facts across ordinary turns, after every Roxy Temporary Chat page was forcibly closed, and after a complete AsterBridge Launcher/daemon restart.
- Live vision continuity passed with a real 1254×1254 PNG: the Web model correctly read the attached blue-robot image, then after every Temporary Chat page was closed it recovered the historical image from Codex context and matched independent native-vision details (two eyes, rounded rectangular head, circular blue chest feature) without a new attachment.
- Browser/prompt/retained focused regression after the usability changes: **100 pass, 0 fail / 511 assertions**.
- Full 3.0.10 local release gate passed: **41/41 core files**, Launcher **202 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/renderer build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Installed Windows 3.0.10 live validation passed with route active and `errors=[]`, Responses proxy healthy on `127.0.0.1:17841`, Doctor ready, RoxyBrowser reachable, and `Codex Native3` verified in the configured external browser.
- Installed 3.0.10 `NO_TOOL_E2E_OK` produced only the assistant reply and no `command_execution`/native tool item. A multi-thread Roxy run then held the Temporary Chat surface count at five while logging `released idle retained conversation ... to free a browser slot`; no `at most 5 simultaneous` failure occurred.
- The no-tool bias fix did not suppress required tools: a fresh installed-3.0.10 `chatgpt-web/high` turn explicitly queued and delivered `image_gen__imagegen` and produced a real **1254×1254 RGB PNG (~1.1 MB)** under Codex `generated_images`.

## 3.0.9 - 2026-08-31

### Reconnect and Windows runtime handoff

- Expanded native Codex long-thread reconnect support for requests that preserve trusted top-level `thread_id`, `turn_id`, workspace, and sandbox metadata while omitting the redundant per-item turn id on the current server-owned user message. Sparse resume accepts that canonical server-owned shape without weakening workspace, sandbox, provenance, or conflicting-turn checks. A previously created legacy thread that reconnects with no recoverable trusted environment authority can still fail closed with `trusted environment unavailable`; fresh threads are unaffected and this legacy-only case remains intentionally parked rather than guessing `cwd` from user text.
- Fixed v7 Codex route verification treating loss of the non-semantic AsterBridge management comment as route corruption even when the owned `openai_base_url` still exactly matches the journal. Actual route URL changes remain fail-closed.
- Moves the post-3.0.6 fixes to a new patch version instead of refreshing the same Windows runtime directory in place. This avoids `EPERM` startup failures when an older same-version MCP/Bun process still holds `versions/<version>-win32-x64` open.
- Fixed Temporary Chat falsely refusing image-generation requests when the current outer Codex turn already advertises native `image_gen__imagegen`. Full-mode prompt compilation now binds that exact advertised wire name and schema to the existing `codex_tool_call` bridge, so the Web model must use the outer Codex image tool instead of telling the user to switch to a normal ChatGPT conversation. The connector ABI is unchanged, avoiding a `Codex Native3` tools-list migration solely for this fix.

### Validation notes

- Reconnect/environment/route focused regression: **96 pass, 0 fail / 431 assertions**.
- Image-generation / Full Harness focused regression after parameter normalization: **100 pass, 0 fail / 515 assertions**. Pure text generation drops impossible `num_last_images_to_include` values when the Codex thread has no prior images and bounds valid history-image requests to the images actually available.
- Live Windows 11 E2E on installed 3.0.9 passed through RoxyBrowser + `Codex Native3`: a fresh `chatgpt-web/high` Codex thread invoked outer `image_gen__imagegen` and produced a real **1254×1254 PNG (about 920 KB)** under Codex `generated_images`, rather than returning the previous Temporary Chat refusal or a false-success tool error.
- Full release gate after both fixes: **41 core files PASS**, Launcher **202 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript and renderer production build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.

## 3.0.6 - 2026-08-30

### External-browser doctor fix

- Fixed Doctor treating the embedded Launcher browser as a hard requirement even when `turnBrowserHost` is RoxyBrowser or the system browser. External turn hosts now own the runtime readiness gate, so Doctor no longer waits 30 seconds on an unused embedded ChatGPT surface.
- A closed RoxyBrowser profile with healthy Local API + auto-open is now reported as ready instead of requiring user action; the next real turn remains responsible for opening the configured profile.
- MCP verification can now proceed past local Doctor and perform the actual external-browser connector check. The reported production issue was reproduced on 3.0.5 and `Codex Native3` was successfully verified through the configured RoxyBrowser/tunnel after the policy fix.

## 3.0.5 - 2026-08-30

### Release reliability

- Keeps the cross-platform LF/CRLF contract fix from 3.0.4 and narrows the remaining Windows CI exception to Bun 1.4.0's named-pipe test runtime. The eight short-lived pipe lifecycle cases in `turn-broker-lifecycle.test.ts` are skipped only on Windows + Bun 1.4.0; macOS/Linux still execute them unchanged.
- Windows broker coverage remains active through server lifecycle, Full Harness, retained-compaction, DEV-driver, launcher, and packaged-runtime tests, so the skip does not disable product-level broker validation.
- Supersedes `v3.0.4` for binary distribution because its GitHub Release matrix reached successful Linux/macOS verification but the Windows runner exhausted the bounded Bun runtime-crash retries on `turn-broker-lifecycle.test.ts` (exit code 3), preventing the publish job from running.

### Validation notes

- `v3.0.4` proved the original Unix checkout failure was fixed: Linux completed its build successfully and macOS passed `bun run verify`; the remaining release blocker was isolated to Windows Bun 1.4.0 named-pipe test execution rather than an application assertion.
- Final local 3.0.5 gate: full `bun run verify` passed through `RELOCATABLE_RUNTIME_SMOKE_OK`; Windows produced `asterbridge-3.0.5-win-x64.exe` (**151,433,995 bytes**) and the real installed-package smoke passed with `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`.

## 3.0.4 - 2026-08-30

### Release reliability

- Fixed the release gate that ran all core tests inside one Bun 1.4.0 process. The full 40-file core suite now runs through `scripts/test-core.ts` with one deterministic child process per test file while preserving complete test coverage. Explicit Bun runtime-crash exit codes receive at most two retries; ordinary assertion/test failures are never retried.
- Added a Launcher packaging contract that requires the release verification path to keep using the deterministic batched core-test runner, preventing the single-process Bun crash from returning unnoticed.
- Supersedes the `v3.0.3` tag for binary distribution: its GitHub Release workflow failed at `bun run verify` before packaging any assets, so no `v3.0.3` GitHub Release was published.

### Validation notes

- Reproduced the original `v3.0.3` failure from the exact tag state as a Bun 1.4.0 segmentation fault during the oversized single-process core suite.
- New isolated core runner: **40 test files / 40 short-lived Bun processes / 0 assertion failures**, with bounded retries only for verified Bun runtime crash exits.
- Launcher: **202 pass, 0 fail, 1 Windows-inapplicable skip**.
- Full `bun run verify`: PASS, including version/docs/audit, core tests, Launcher tests, root/Launcher TypeScript, renderer production build, runtime bundle, third-party notices, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Final Windows `3.0.4` package produced `asterbridge-3.0.4-win-x64.exe` (**151,433,885 bytes**) and passed the real installed-package gate with `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`, proving packaged runtime/version verification and Windows tray readiness.

## 3.0.3 - 2026-08-30

### Upstream v4 integration

- Added retained Roxy task conversations with native compaction epoch recovery, reversible Subagent Compatibility V1 / Native behavior, bounded deferred `wait_agent` polling, and opt-in transactional Bigger Context transport.
- Preserved the public `Codex Native3` MCP ABI while carrying deferred Multi-agent calls through the generic tool contract and keeping native image-generation passthrough on the official image endpoints.
- Added Launcher Bigger Context controls and retained the existing prompt-verification, bounded insertion, UTF-16, proxy, Roxy, and route-ownership guarantees.

### Windows packaging reliability

- Unified Launcher branding on one canonical AsterBridge SVG. Windows packaging now regenerates a multi-resolution ICO from that SVG before each package, embeds it in the executable, ships it as `resources/icon.ico`, uses it directly for packaged tray/window branding, and the renderer sidebar/onboarding mark now uses the same SVG instead of the old hard-coded orbit icon.
- Added NSIS recovery for a half-uninstalled AsterBridge registration when the recorded current/legacy launcher and uninstaller files are all gone, avoiding upgrade failure on a stale missing uninstaller.
- Fixed packaged smoke incorrectly killing a valid but slow Windows NSIS install after 120 seconds. Windows smoke now allows up to 10 minutes, verifies the packaged Bun/runtime files before launch, and requires the readiness marker to report tray availability.
- Final **3.0.3** Windows package smoke passed with `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`; the installed `AsterBridge.exe` reports **3.0.3.0** and contains the packaged runtime, `runtime/bun.exe`, a ready tray, and the generated **67,863-byte / 7-frame** `resources/icon.ico`.
- Root TypeScript validation now invokes the project-local `tsc` binary directly instead of depending on a separate `bunx` shim, keeping local and CI release gates portable.

### Validation notes

- Release-candidate regression after the 3.0.3 version freeze: root suite **390 pass, 0 fail / 1,658 assertions**; Launcher **201 pass, 0 fail, 1 Windows-inapplicable skip**; root/Launcher TypeScript and production renderer build passed.
- Focused Subagent/Bigger Context/Browser Worker/Full Harness regression: **180 pass, 0 fail / 888 assertions**.
- Native compaction completed through one Codex app-server owner across retained → compact → new epoch with a native `contextCompaction` item. Final Full runtime reported Tunnel healthy/ready; text, Native3 MCP, retained sessions, Subagent, Nested, and Bigger Context live chains passed.
- Final `image_gen` routing reached the official image backend. A 2026-08-30 revalidation through `Codex Native3 -> image_gen__imagegen -> /v1/images/generations` succeeded and wrote a valid 668,296-byte PNG (`1254x1254`); the earlier `429 usage_limit_reached` was transient rather than a current bridge or account blocker.

## 3.0.2 - 2026-08-28

### Compatibility fixes

- Updated ChatGPT model/effort capability detection for the current composer control and header model-switcher layouts, preventing Sol-capable accounts from being incorrectly downgraded to the Luna-only catalog after a capability refresh.
- Launcher now refreshes the active network-proxy environment immediately before Core and MCP setup, so a Windows system proxy that starts after AsterBridge is inherited by `tunnel-client` instead of falling back to a blocked direct OpenAI connection and timing out.

### Validation notes

- Current RoxyBrowser account probing reports `sol=true, pro=false`, and the exact `Codex Native3` connector remains available in normal Chat Temporary Chat without forcing the Work surface.
- Full-mode Doctor reports the Tunnel runtime healthy and ready, and a real Full Harness validation completed successfully through `Codex Native3`.
- Core regression passed in three deterministic Windows batches (**352 pass, 0 fail**); Launcher regression passed **195 pass, 0 fail, 1 Windows-inapplicable skip**. TypeScript checks, production renderer build, and relocatable runtime smoke also passed. The known Bun 1.4.0 Windows single-process segmentation-fault flake still reproduces only when the entire core suite is forced into one very large process.

## 3.0.1 - 2026-08-24

### Reliability and onboarding fixes

- Fixed Browser-only model reinstall forgetting previously managed MCP Tunnel credentials. Launcher now rediscovers the private managed runtime key and Tunnel profile without exposing secret material or forcing users to paste credentials again.
- Fixed Launcher snapshot drift after Setup/MCP operations so derived state such as saved MCP credentials and connector identity refreshes together with persisted state.
- Updated Connector verification to prove the exact `Codex Native3` entry in ChatGPT's connector catalog instead of depending on the old selected-chip DOM, eliminating a false red Verify result after ChatGPT UI changes.
- Added an optional **RoxyBrowser executable path**. When profile auto-open is enabled and Local API is unavailable after reboot, AsterBridge can start the RoxyBrowser application first, wait for Local API, and then open the configured Profile.
- Improved dark-mode native select readability with a dark color scheme and explicit option foreground/background colors.
- Renamed the ambiguous Chinese navigation labels to **模型设置** and **启动器设置**.
- Removed X/Twitter from onboarding and the Launcher sidebar, including the obsolete onboarding completion gate that could otherwise block fresh installs after the X action disappeared; GitHub remains the project link.
- Added copy-paste AI-agent installation prompts to both READMEs so beginners can ask a terminal-capable AI to install the latest Release, run Doctor, prove `WEB_OK`, and then prove Native3 with `ASTERBRIDGE_FULL_OK` without sharing secrets in chat.

### Validation notes

- Launcher regression: **194 pass, 0 fail, 1 Linux-only skip**; TypeScript and production renderer builds passed.
- Final Windows packaged smoke proved `version=3.0.1`, `packaged=true`, and `runtimeVerified=true` with the durable `3.0.1 / Bun 1.4.0 / win32-x64` runtime.
- Real Windows cold-start E2E proved AsterBridge can start RoxyBrowser after Local API is down, recover the configured Profile/CDP endpoint, complete a ChatGPT Web turn, verify `Codex Native3`, and execute a real Full Harness `exec_command` returning `ASTERBRIDGE_FULL_OK`.
- Bun 1.4.0 on Windows can still intermittently crash during very large single-process core test runs; release validation therefore keeps deterministic shorter batches plus packaged/runtime E2E rather than treating a Bun process crash as an application assertion failure.

## 3.0.0 - 2026-08-24

### AsterBridge rebrand

- Renamed the desktop product to **AsterBridge · 星桥** with a new violet / icy-cyan visual system and original bridge-orbit icon.
- Moved the primary repository, issue links, installers, updater, and release assets to `1210350468/AsterBridge`.
- Preserved compatibility identifiers such as `chatgpt-web/*`, `CODEX_WEB_GPT_*`, the existing runtime home, updater GUID, and legacy user-data migration so existing installs keep their state.
- Kept the original `miuuyy/codex-chatgpt-web` repository as `upstream` and retained MIT attribution.

### Browser runtime

- Added **RoxyBrowser** as the recommended stable external browser backend.
- Added Roxy Local API auto-open, private API-key storage, CDP endpoint discovery, structured `browser_unavailable` errors, and profile lifecycle checks.
- Added **Live Preview** in Launcher for active Roxy turns and **Take control** for one-click manual takeover without creating a second CDP controller.
- Kept Embedded Browser as the simplest fallback and Chrome / Edge system-browser mode as experimental.

### Native tool bridge

- Promoted the current ChatGPT App / Connector identity to **Codex Native3** and added migration guidance for retired `Codex Native` / `Codex Native2` identities.
- Hardened turn-broker ownership, token validation, launcher-control routing, cancellation, and retained-tab lifecycle handling.
- Added native upstream fallback handling so Codex can transparently use HTTP/SSE when local WebSocket upgrade is unavailable.

### Network and proxy

- Added Launcher **Network proxy** modes: Automatic, Direct, and Custom.
- Automatic mode prefers proxy environment variables and, on Windows, imports the active system proxy when needed.
- Managed daemon, tunnel-client, and GitHub updater share the same proxy environment.
- `127.0.0.1`, `localhost`, and `::1` are automatically added to `NO_PROXY` so Bridge and Roxy loopback services never traverse the external proxy.
- Custom proxy settings accept HTTP(S) endpoints without embedded credentials; authenticated enterprise proxies remain supported through environment variables.
- Doctor now checks public ChatGPT/Codex and OpenAI reachability through the same proxy path used by the runtime.

### Onboarding and diagnostics

- Added English and Chinese 10-minute Quick Start guides.
- Added English and Chinese troubleshooting guides with symptom-to-action guidance for Roxy/CDP, proxy, Tunnel, Native3, `17841` conflicts, WebSocket `426`, Skill YAML errors, and Git ownership warnings.
- Added a redacted diagnostic-summary copy action and GitHub issue templates that explicitly exclude API keys, cookies, bearer tokens, and full turn tokens.
- Added documentation-contract validation to CI / verification workflows so the product name, connector identity, repository URLs, and user guides stay aligned.

### Packaging and release

- Windows package now installs as `AsterBridge.exe` and release artifacts use the `asterbridge-*` naming scheme.
- Packaged runtime smoke validates the embedded Bun runtime, launcher readiness marker, version, platform, and architecture.
- Release workflows and installers target the AsterBridge repository while preserving upgrade compatibility for existing users.

### Validation notes

- Launcher full regression: **192 pass, 0 fail, 1 platform-specific skip** after the proxy/onboarding work.
- Core proxy/Roxy/CLI short batch: **26 pass, 0 fail**.
- Packaging / updater / state short batch: **23 pass, 0 fail, 1 Windows-inapplicable Linux skip**.
- Latest Windows installer packaged smoke: `SMOKE_EXIT=0`, `PACKAGED=True`, `RUNTIME_VERIFIED=True`, version `3.0.0`, `win32/x64`.
- Bun 1.4.0 on Windows has shown intermittent long-run test-runner instability (segmentation fault / hang) during very large single-process test runs. Release validation therefore uses smaller deterministic batches; this has not reproduced as a launcher/runtime execution failure.
