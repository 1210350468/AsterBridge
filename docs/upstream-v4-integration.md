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
  - Reworked the generated star/bridge/code concept into a small-size-safe AsterBridge vector icon.
  - Windows tray now prefers the native icon embedded in the packaged `AsterBridge.exe`, with `.ico` fallback in development, instead of rasterizing the SVG directly at tray size.
  - Validation: Launcher **196 pass, 0 fail, 1 Windows-inapplicable skip**; TypeScript and renderer production build passed; unpacked packaged smoke exited 0 with runtime `3.0.2`; `launcher.tray_ready` reported a non-empty **16×16** Windows native icon; extracted EXE icon was **32×32** with 880 non-transparent pixels and 544 colors.

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

- [ ] **P0-3 Live Full Harness E2E**
  - `browser check` -> Sol capability correct.
  - exact `Codex Native3` connector verification.
  - Full-mode Doctor -> Tunnel healthy/ready.
  - Real native tool round -> `ASTERBRIDGE_FULL_OK`.

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

- [ ] **P0.5-3 `IMAGE_GEN_OK` validation**
  - Live `chatgpt-web/high` inventory confirms `image_gen__imagegen` exists.
  - Real isolated native E2E through the new 17842 worktree route succeeded: Codex returned `succeeded: true`, wrote a valid PNG, and exposed a real `saved_path` (verified file size and dimensions).
  - Final checkbox waits for the packaged Full runtime so `Codex Native3 -> codex_tool_call -> image_gen__imagegen -> /v1/images/generations` is exercised end-to-end without changing the connector ABI.

## P1 — Upstream v4 architecture adaptation

- [x] **P1-1 Continuous Web Tasks / retained Roxy sessions**
  - Reuse one ChatGPT Temporary Chat surface across sequential messages in the same Codex thread/model/effort/compaction epoch.
  - Implemented with Roxy/system-browser CDP semantics rather than copying upstream Electron-only lifecycle code.
  - Continuations send only the canonical suffix after the last assistant reply and do not rerun Temporary Chat preparation or re-mention `Codex Native3`.
  - Added conversation-head ownership so retiring an older native turn cannot close the current retained page; epoch retirement releases the retained page exactly once.
  - Physical surface accounting deduplicates retained+active conversation keys and preserves the five-tab safety cap.
  - Live Roxy validation caught and fixed two lifecycle bugs: a retained page was initially closed by `finally`, and the transient composer plugin pill was incorrectly treated as the durable conversation binding.
  - Validation: retained/browser/harness regression **124 pass, 0 fail** plus focused **76 pass, 0 fail** after the lifecycle fixes; TypeScript passed. Live Roxy two-message E2E showed first turn `retained=false`, second turn `browser-page-retained` / `retained=true`, returned `RETAIN_SECOND_OK`, skipped Temporary Chat preparation and connector re-mention, then released the test page successfully.

- [ ] **P1-2 Native compaction and retained-page recovery**
  - One-shot compaction control capability bound to the retained source task.
  - Close the old retained surface only after checkpoint and helper/broker cleanup are complete.
  - If the retained page is gone, rebuild the checkpoint from canonical Codex history in a fresh read-only turn.

- [ ] **P1-3 Subagent protocol compatibility**
  - Add explicit Compatibility V1 / Native selection only if it remains reversible.
  - Preserve user Codex settings on uninstall/disconnect.
  - Support nested agent depth where required.
  - Use bounded `wait_agent` polling so a parent wait does not monopolize the MCP channel.

## P2 — Bigger context transport

- [ ] Port the upstream larger-context staging/transaction improvements only after retained-task and
  compaction lifecycles are stable.
- [ ] Retain AsterBridge's existing exact prompt verification, caret recovery, bounded insertion, and
  UTF-16 safety tests.

## Promotion gate

Do not merge this integration branch into `main` until all P0 and P0.5 items selected for the release
are checked, live Full Harness E2E succeeds, and the working tree contains no debug probes or local
runtime secrets.
