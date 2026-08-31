# Upstream v4 Integration Plan

This document tracks selective upstream `miuuyy/codex-chatgpt-web` v4 integration into AsterBridge.
The stable `main` branch remains untouched until a phase is validated. AsterBridge-specific behavior
must remain intact: `Codex Native3`, RoxyBrowser, Launcher proxy refresh, AsterBridge branding, and
current Windows-first release behavior.

## Rules

- Do not merge `upstream/main` wholesale.
- Prefer isolated cherry-picks only when they do not overwrite AsterBridge-specific behavior.
- Otherwise port the behavior manually and keep the patch minimal.
- Every completed item must have an automated test result recorded here.
- Browser-facing changes also require a live RoxyBrowser check before promotion to `main`.
- Capability compatibility is tested independently from ordinary text-model success.

## Desktop shell side-fixes

- [x] **AsterBridge application/tray icon refresh**
  - Reworked the star/bridge/code concept into the canonical `launcher/assets/icon.svg` AsterBridge icon and removed the renderer's separate hard-coded legacy orbit mark.
  - Windows packaging now converts that canonical SVG into a fresh multi-resolution ICO before every Windows package, embeds the ICO into `AsterBridge.exe`, and ships the same ICO as `resources/icon.ico`. Packaged tray/window branding reads that file directly instead of asking the Windows shell for a potentially stale cached EXE icon or rasterizing SVG in the notification area.
  - Validation after the correction: icon/packaging contracts **28 pass, 0 fail**; TypeScript and renderer production build passed; final Windows package smoke returned `PACKAGED_LAUNCHER_SMOKE_OK win32/x64` with `trayReady=true`. The installed `resources/icon.ico` is **67,863 bytes** with **7 ICO frames**.

- [x] **Windows installer stale-registration recovery and packaged smoke completion gate**
  - Added an NSIS `customInit` recovery hook for the specific half-uninstalled state where electron-builder registry ownership remains but neither the current/legacy launcher nor uninstaller exists. Live installs are checked first and are never deleted by the recovery hook.
  - Diagnosed the apparent missing-runtime package failure as the old package smoke killing a still-running NSIS installer at its fixed **120 s** timeout. The installer archive itself contained `resources/runtime/runtime/bun.exe`; the truncated installation stopped after 5,644 of 5,986 runtime files because the smoke terminated the installer mid-extraction.
  - Raised the Windows installer smoke budget to **10 minutes**, then explicitly require packaged `runtime/bun.exe`, `bin/codex-chatgpt-web.cmd`, and `manifest.json` before launching the app. The smoke readiness marker now also carries `trayReady`, which is mandatory on Windows.
  - Final Windows `package:win` + installed package smoke passed with `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`; installed resources contain **5,986 files / 171,102,104 bytes**, including Bun **88,825,944 bytes**, and the smoke proved `runtimeVerified=true` plus tray readiness.

## P0 — Reliability sync

- [x] **P0-0 Tunnel client 0.0.12**
  - Ported upstream tunnel-client `0.0.12` support.
  - Allows transactional upgrade only from the previously shipped `0.0.10` or reuse of `0.0.12`.
  - Failed replacement restores the prior trusted binary and manifest.
  - Validation: tunnel tests **11 pass, 0 fail**; TypeScript check passed.

- [x] **P0-0 Session and localized rate-limit detection**
  - Added expired ChatGPT session detection.
  - Added localized cooldown/rate-limit handling for English, Simplified Chinese, Traditional Chinese,
    and Japanese UI.
  - Preserved AsterBridge's current Sol selector compatibility instead of restoring the upstream legacy selector.
  - Validation: browser/session tests **74 pass, 0 fail**; TypeScript check passed; live RoxyBrowser
    reported `sol=true, pro=false`; exact `Codex Native3` verification passed.

- [x] **P0-0 Defer irreversible final answer across MCP tool rounds**
  - Tool-capable Web turns no longer stream final-answer Markdown before the MCP tool loop is terminal.
  - Reasoning/commentary/tool activity remains live.
  - Browser-only turns keep their existing streaming behavior.
  - Validation: browser/session/harness tests **122 pass, 0 fail**; TypeScript check passed.

- [x] **P0-1 Broker retirement transport race**
  - Buffer the response frame but do not resolve until the broker server ends its response transport.
  - On Bun/Windows named pipes, remote EOF is the authoritative write-settled boundary; `close` remains a fallback.
  - Prevent runtime retirement while a Windows named-pipe response write is still in flight.
  - Validation: dedicated delayed-close + closed-without-response tests **2 pass, 0 fail**. The delayed server closes after 75 ms and the client remains pending until that boundary. A later large single-process broker run again hit the already-known Bun 1.4.0 Windows segmentation-fault flake after the new assertions had passed.

- [x] **P0-2 P0 combined regression**
  - Tunnel group: **11 pass, 0 fail**.
  - Browser/session/harness group: **122 pass, 0 fail**.
  - Broker lifecycle: all **12 cases pass** when split into deterministic Windows processes; the dedicated transport-settle test remains pending until remote EOF. A single large broker process can still hit Bun 1.4.0's cumulative Windows named-pipe segmentation-fault flake.
  - TypeScript check passed.
  - Live Roxy checks from this branch still report `sol=true, pro=false` and exact `Codex Native3` availability.

- [x] **P0-3 Live Full Harness E2E**
  - Direct Roxy preflight reported `sol=true, pro=false`; browser smoke returned `CODEX WEB GPT READY`.
  - Isolated integration runtime bound 17841 with the existing managed Tunnel reporting `ok=true`, `healthy=true`, `ready=true`.
  - Real Full-mode Codex round traversed `ChatGPT Web -> Codex Native3 -> outer Codex command_execution` and returned `ASTERBRIDGE_FULL_OK` from PowerShell.
  - The test runtime uses an in-memory direct-Roxy config and never rewrites the production AsterBridge config.

- [x] **P0-4 Codex 0.150.x Responses SSE compatibility**
  - Removed the legacy Chat-Completions-style `data: [DONE]` sentinel after terminal `response.completed` / `response.incomplete` events.
  - Codex 0.150.x treated the six-byte `[DONE]` payload as JSON and failed with an SSE syntax error that its CLI misleadingly surfaced as model capacity.
  - Responses streams now terminate by closing after their typed terminal event; the existing 426 WebSocket negotiation followed by HTTP/SSE fallback remains expected.
  - Validation: bridge/harness/server regression **68 pass, 0 fail** plus live Codex SSE trace reaching `response.completed` with no parser error.

## P0.5 — Codex native capability compatibility

Text-model success is not sufficient. Every capability must be audited independently for native
passthrough and `chatgpt-web/*` routed models.

- [x] **P0.5-1 Capability audit matrix**
  - Codex local `image_gen / imagegen` is distinct from Responses hosted `image_generation`; the local namespace survives routed parsing while the hosted tool remains server-owned.
  - `image_gen`: live `chatgpt-web/high` Full inventory exposes exact `image_gen__imagegen` with complete schema.
  - `tool_search`: live Full inventory exposes it as the deferred-tool discovery surface for MCP, Plugins, Multi-agent, and computer-use capabilities.
  - `web_search`: not a client tool in the outer inventory; native standalone search stays on authenticated `/v1/alpha/search` passthrough.
  - namespace/MCP tools: preserved by parser namespace flattening plus the Native3 broker/inventory/tool-call contract.
  - computer use: currently deferred behind `tool_search`, rather than preloaded as an ordinary direct function.
  - image input: existing harness coverage preserves native image attachments outside the context JSON.
  - skills/subagent surfaces: Codex supplies skill context normally and advertises deferred Multi-agent tools through `tool_search`.
  - Validation: real Codex `0.150.1` capability inventory plus parser/harness tests.

- [x] **P0.5-2 Native Codex `image_gen` compatibility and image endpoints**
  - Preserved the existing public `Codex Native3` MCP ABI and its generic `codex_tool_inventory` / `codex_tool_call` path; no connector identity migration is required.
  - Confirmed that outer Codex advertises exact namespace tool `image_gen__imagegen`; the bridge does not fake hosted Responses `image_generation` as a function.
  - Added authenticated byte-preserving native passthrough for `/v1/images/generations` and `/v1/images/edits` to the official Codex backend.
  - Preserved native Responses passthrough semantics and kept hosted `image_generation` parsing separate.
  - A proposed dedicated `codex_image_gen` MCP method was deliberately removed after its ABI-hash test proved it would mutate ChatGPT's cached `Codex Native3` contract.
  - Validation: native passthrough/server/parser group **29 pass, 0 fail**; TypeScript check passed; public Native3 ABI remains unchanged.

- [x] **P0.5-3 `IMAGE_GEN_OK` validation**
  - Live `chatgpt-web/high` inventory confirms `image_gen__imagegen` exists.
  - Real isolated native E2E through the 17842 integration route succeeded: Codex returned `succeeded: true`, wrote a valid PNG, and exposed a real `saved_path` (verified file size and dimensions).
  - Final Full Harness validation exercised `Codex Native3 -> codex_tool_call -> image_gen__imagegen -> /v1/images/generations` through the official image backend. A later revalidation on 2026-08-30 succeeded end to end and wrote a valid 668,296-byte PNG (`1254x1254`) to the Codex generated-images directory. The earlier `429 usage_limit_reached` was therefore transient and is not a current release blocker.

## P1 — Upstream v4 architecture adaptation

- [x] **P1-1 Continuous Web Tasks / retained Roxy sessions**
  - Reuse one ChatGPT Temporary Chat surface across sequential messages in the same Codex thread/model/effort/compaction epoch.
  - Implemented with Roxy/system-browser CDP semantics rather than copying upstream Electron-only lifecycle code.
  - Continuations send only the canonical suffix after the last assistant reply and do not rerun Temporary Chat preparation or re-mention `Codex Native3`.
  - Added conversation-head ownership so retiring an older native turn cannot close the current retained page; epoch retirement releases the retained page exactly once.
  - Physical surface accounting deduplicates retained+active conversation keys and preserves the five-tab safety cap.
  - Live Roxy validation caught and fixed two lifecycle bugs: a retained page was initially closed by `finally`, and the transient composer plugin pill was incorrectly treated as the durable conversation binding.
  - Validation: retained/browser/harness regression **124 pass, 0 fail** plus focused **76 pass, 0 fail** after the lifecycle fixes; TypeScript passed. Live Roxy two-message E2E showed first turn `retained=false`, second turn `browser-page-retained` / `retained=true`, returned `RETAIN_SECOND_OK`, skipped Temporary Chat preparation and connector re-mention, then released the test page successfully.

- [x] **P1-2 Native compaction and retained-page recovery**
  - One-shot compaction control capability is bound to the retained source task and cannot execute ordinary Codex tools.
  - Active MCP-boundary compaction converts the current response into the checkpoint instead of opening a competing visible message.
  - Close the old retained surface only after structured checkpoint submission and helper/broker cleanup are complete.
  - If the retained page is gone, rebuild exactly one checkpoint from canonical Codex history in a fresh read-only turn.
  - Automated affected-area regression: **164 pass, 0 fail / 807 assertions**, plus focused compaction-control and recovery coverage.
  - Live Codex app-server E2E used the native `thread/compact/start` method on a fixed `chatgpt-web/light` thread. The second pre-compaction turn produced `01-browser-page-retained.json`; compaction completed as a native `contextCompaction` item and its own browser diagnostic again began with `01-browser-page-retained.json` (no `_fallback`). The next post-compaction turn returned `POST_COMPACTION_OK` and began with `01-browser-page-acquired.json`, proving old-epoch release and fresh-epoch creation.

- [x] **P1-3 Subagent protocol compatibility**
  - Added reversible `compatibility-v1` / `native` protocol selection with Compatibility V1 remaining the default routed behavior.
  - Compatibility mode keeps Web subagents on the V1 contract while native mode preserves Codex-native agent-version metadata; setup/uninstall route ownership remains transactional and does not overwrite unrelated Codex settings.
  - Deferred Multi-agent calls are allowed through the existing Native3 generic tool ABI without changing the connector schema. `multi_agent_v1__wait_agent` is clamped to **10 s** polling so a parent wait cannot monopolize the MCP turn channel.
  - Final live Subagent and Nested chains passed; local compatibility/harness regression is included in the **180 pass, 0 fail / 888 assertions** P1-3/P2 focused batch.

## P2 — Bigger context transport

- [x] **Transactional Bigger Context transport**
  - Bigger Context is explicit and reversible, exposed through setup/CLI and Launcher Settings rather than silently changing every route.
  - Normal larger contexts stage complete semantic JSON records across two parts; larger thresholds and compaction use three parts. Earlier stages are inert and require exact SHA-256 acknowledgements; only the final commit contains the task-bearing execution contract.
  - Luna remains excluded because its accumulated browser transcript shares the same 28k transport budget.
  - Existing exact prompt verification, caret recovery, bounded insertion, image handling, and UTF-16 safety remain in force for every stage.
  - Final live Bigger Context chain passed. Focused P1-3/P2 regression: **180 pass, 0 fail / 888 assertions** across subagent, prompt, Browser Worker, Full Harness, model-catalog, and environment tests.

## Promotion gate

Current status: **AsterBridge 3.0.14 passed its local Windows promotion gate on 2026-09-01; GitHub publication is still pending**.
All selected P0/P0.5, retained-session, native-compaction, Subagent/Nested, Bigger Context, Native3,
image generation, and Windows packaged-launcher gates passed before the 3.0.5 release. The 3.0.6
work fixed the external-browser Doctor readiness policy; 3.0.9 additionally expands native Codex
thread reconnect compatibility when the current server-owned user item omits a redundant per-item turn id, while
preserving the top-level thread/turn, workspace, sandbox, and provenance trust boundaries. One previously created
legacy thread that reconnects without any recoverable trusted environment authority still fails closed rather than
inventing a cwd; fresh threads are unaffected and that legacy-only case is parked. It also
makes v7 route ownership depend on the owned `openai_base_url` rather than a non-semantic comment,
so Codex formatting rewrites do not suppress the Responses daemon. The latest fixes were moved to a
new patch version instead of refreshing the same Windows runtime directory while an MCP/Bun process
still had it open, avoiding the observed same-version `EPERM` handoff failure. 3.0.9 also fixes a
Temporary Chat capability-routing regression: when the outer turn advertises `image_gen__imagegen`,
the prompt now binds that exact wire name and schema to the existing `codex_tool_call` bridge and
forbids falling back to the misleading "switch to a normal ChatGPT conversation" refusal. This does
not change the `Codex Native3` MCP tools-list ABI. Focused reconnect/environment/route regression is
**96 pass, 0 fail / 431 assertions**; focused image-generation / Full Harness regression after parameter normalization is
**100 pass, 0 fail / 515 assertions**. The full source release gate passed with **41/41 core files**, Launcher
**202 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
Installed Windows 3.0.9 runtime validation also passed: route active with `errors=[]`, Responses proxy healthy on
`127.0.0.1:17841`, Doctor ready, RoxyBrowser reachable, `Codex Native3` verified in the configured external browser,
and a fresh `chatgpt-web/high` Codex thread generated a real 1254×1254 PNG through outer `image_gen__imagegen`.
A subsequent user-journey audit proved fresh-thread context continuity across normal turns, forced closure of every
Roxy Temporary Chat page, and a full Launcher/daemon restart. Vision replay also survived forced Temporary Chat
closure and recovered image details that had not been stated in prior assistant text. The 3.0.10 patch reduces
unnecessary native-tool calls for context-only replies and converts the five-page retained-surface ceiling into safe
LRU eviction of completed idle conversations while preserving the hard limit for genuinely active turns. Focused
browser/prompt/retained regression is **100 pass, 0 fail / 511 assertions**. The complete 3.0.10 local gate also passed with **41/41 core files**, Launcher **202 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/renderer build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`. The packaged Windows 3.0.10 runtime is installed locally; route inspection reports active with `errors=[]`, `127.0.0.1:17841` is healthy, Doctor is ready, RoxyBrowser is reachable, and `Codex Native3` verifies through the configured external browser. Live `NO_TOOL_E2E_OK` emitted no command/tool item, while a multi-thread retained-surface run stayed at five Temporary Chat pages and logged idle LRU releases instead of the previous sixth-thread failure.
A final installed-3.0.10 image-generation regression also passed after the no-tool bias fix: a fresh `chatgpt-web/high` turn still queued `image_gen__imagegen` and produced a real 1254×1254 PNG, confirming context-only requests avoid unnecessary tools without suppressing genuinely required native capabilities.

The 3.0.11 patch targets intermittent long-running native image failures without weakening POST idempotency. `/v1/images/generations` and `/v1/images/edits` now emit privacy-safe endpoint/duration/status/origin telemetry so an upstream HTTP 502/503/504 is distinguishable from a local proxy/fetch exception. AsterBridge still forwards each native image POST exactly once; transient retry semantics are added only to the `image_gen__imagegen` MCP result and capped at two semantic retries. Doctor also probes the Codex image route and reports generated-image disk usage. Browser image replay remains bounded to the newest 10 images, 20 MB each / 50 MB aggregate per Web turn, while image-generation history references remain capped at five. Focused 3.0.11 regression is **49 pass, 0 fail / 274 assertions** and the full source/package gate passed, but installed promotion was blocked when the configured RoxyBrowser session had expired.

The failed 3.0.11 startup exposed an independent rollback defect: after restoring the 3.0.10 checkpoint, the 3.0.11 Launcher tried to start the older runtime under the new Launcher version contract and produced `Previous runtime recovery returned needs-setup`. AsterBridge 3.0.12 fixes that cross-version recovery boundary and stops managed upgrades from unnecessarily hard-gating on a fresh Roxy/system-browser capability probe when the same external browser identity already has verified capability flags. First setup, browser/Profile changes, missing capability evidence, and explicit refresh still probe live. A real Roxy reproduction confirmed that retained pages could still show an already-loaded composer while every newly navigated Temporary Chat page rendered ChatGPT's logged-out surface; 3.0.12 now reports that structurally as `chatgpt_session_expired` instead of the previous ambiguous composer failure. Focused browser/setup/rollback regression is **118 pass, 0 fail / 356 assertions**. The full 3.0.12 source gate passed with **41/41 core files**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/renderer build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`. After the same RoxyBrowser profile was re-authenticated, a live browser probe returned `sol=true, pro=false`; the installed 3.0.12 Launcher then upgraded the managed runtime from 3.0.10 to 3.0.12 without another browser capability probe, without the prior authentication failure, and without the secondary `needs-setup` recovery error while preserving the deliberately disconnected route. Reconnecting the bridge produced a healthy 3.0.12 daemon on `127.0.0.1:17841`, Doctor `ok=true`, and a successful real `Codex Native3` external-browser verification. A fresh `chatgpt-web/high` text turn completed without native-tool use, and a real image turn produced a 959,359-byte PNG while logging `[asterbridge:image] endpoint=images/generations durationMs=20182 status=200 origin=upstream retryable=false`.

The 3.0.13 reliability pass closes three pre-open-source usability gaps found through installed user-journey testing. External-browser maintenance probes are now ephemeral and share the five-surface LRU safety ceiling instead of caching a sixth long-lived page. Multi-image upload/send deadlines are bounded but adaptive to image count and aggregate bytes after an observed eight-image turn uploaded successfully in 13–17 seconds yet repeatedly missed the old fixed 20-second submission acknowledgement deadline. Finally, a deliberately reproduced image request that reported consecutive HTTP 502s emitted neither a broker `image_gen__imagegen` call nor `[asterbridge:image]` telemetry, proving Temporary Chat had selected ChatGPT's separate first-party image generator; when outer Codex advertises image generation, 3.0.13 now explicitly forbids that split path and requires `Codex Native3 -> codex_tool_call -> image_gen__imagegen`. The same configured Windows proxy has separately completed native image-edit requests lasting about 54.5 seconds and 150.2 seconds, so a fixed local 60-second proxy cutoff is not the root cause. Focused browser/prompt regression is **98 pass, 0 fail / 510 assertions**.

Installed 3.0.13 then exposed one final Lexical transport edge: a Full Harness prompt could retain identical semantics while ChatGPT canonicalized Unicode representation, shortening the observed composer text by two UTF-16 code units and tripping exact insertion verification before the image tool ran. AsterBridge 3.0.14 accepts only NFC canonical equivalence and U+FE0E/U+FE0F presentation-selector normalization while keeping ordinary mutations fail-closed. Focused Browser Worker regression is **77 pass, 0 fail / 360 assertions**; full core remained **41/41 deterministic batches PASS**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, and `RELOCATABLE_RUNTIME_SMOKE_OK`. The packaged Windows 3.0.14 runtime is installed locally with route active and `errors=[]`, Doctor `ready`, and `Codex Native3` verified. A fresh image turn queued `image_gen__imagegen`, wrote an 835,896-byte PNG, and logged `[asterbridge:image] endpoint=images/generations durationMs=15793 status=200 origin=upstream retryable=false`. A real eight-image turn used `uploadTimeoutMs=220000` / `sendTimeoutMs=104000`, accepted submission after 18.098 seconds, returned `MULTI8_OK`, and final `/healthz` reported zero active HTTP/browser turns. Version 3.0.5 remains the current public binary until a newer GitHub release is explicitly published.

Do not merge future integration work into `main` until its selected gates are checked, live Full
Harness E2E succeeds, and the working tree contains no debug probes or local runtime secrets.
