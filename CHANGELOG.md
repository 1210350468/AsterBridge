# Changelog

All notable AsterBridge changes are documented here.

## 3.0.30 - 2026-09-04

### Retained compaction handoff compatibility

- Fixed a release-soak stall against the current ChatGPT MCP behavior: a retained compaction continuation could finish normally with a complete checkpoint in the Web response but skip the requested one-shot `codex_tool_call` control submission. AsterBridge then waited for the structured handoff until the compaction transaction timeout even though the dedicated browser turn had already completed.
- Structured MCP handoff remains authoritative when ChatGPT submits it. After the dedicated retained compaction browser turn completes, AsterBridge now allows a short grace period for that one-shot submission; if none arrives, it revokes the compaction control token and accepts only the completed checkpoint text from that exact retained compaction turn. Empty checkpoints, browser failures, early transaction failures, and canonical latest-user conflicts still fail closed.
- Added regression coverage proving the browser-text fallback cannot be overwritten by a late stale control submission: once fallback is selected, the one-shot token is consumed/revoked and a delayed handoff is rejected as invalid/expired. Focused retained/server-compaction/Harness coverage passes **73 / 73** with TypeScript PASS before promotion.

### 3.0.30 release-soak evidence

- Exact-source verification passed on Windows 11 x64: Core **42 / 42**, Launcher **210 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript PASS, renderer production build PASS, `RELOCATABLE_RUNTIME_SMOKE_OK`, and `bun audit` reported **0 vulnerabilities / 106 packages**.
- Exact Windows package `asterbridge-3.0.30-win-x64.exe` is **151,544,880 bytes** with a **158,030-byte** blockmap and SHA-256 `255FE4F4DC16F5D064E4792319501099C2235F6A63E5525A4ADDDC68B6AF33B4`; packaged smoke passed with `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`. Installed 3.0.30 returned Full/MCP health with `active_http_turns=0` and `active_browser_turns=0` after the soak.
- Native compaction E2E now completes end to end on Codex 0.150.1: two retained Web turns compact into a real `contextCompaction` on the same owner (`ASTERBRIDGE_CODEX_COMPACTION_OK`, `sameOwner=true`), and the compacted thread subsequently resumed through `Codex Native3` to execute `Write-Output POST_COMPACT_MCP_330_OK` with exit code 0.
- A mixed Full-Harness soak completed shell → outer `image_gen` → native subagent spawn/wait/close → final answer in one parent Codex task. The parent executed `Write-Output MIX330_SHELL_OK` once, emitted one `image_gen:imagegen` call followed by completed extension output, wrote a **1254×1254** PNG (**825,948 bytes**, SHA-256 `19561F12D2CA53AFCFA7724DADC15B2C19D07BA6EB4F0BD50BA92791FE9E4E96`) under that parent thread's `generated_images` directory, completed the child agent, and returned `MIX330_OK` before all AsterBridge activity returned to 0/0.
- Five simultaneous Web turns can occupy the configured five-page safety budget and a sixth fails closed. Under five-way MCP-tool pressure, ChatGPT Custom App/Tunnel produced intermittent upstream 502s before some calls reached the local TurnBroker; successful local calls remained isolated and all browser/HTTP ownership drained cleanly. Treat five browser turns as a safety ceiling, not a promise that the upstream ChatGPT App/Tunnel will sustain five local-tool calls concurrently.
- During the mixed soak, a DevPilot control-channel 502 resulted in two distinct root `codex_exec` test processes with different Codex thread ids. Each root completed independently with its own image artifact. This is recorded as test-controller duplication, not AsterBridge same-turn replay; exactly-once assertions remain scoped to one native Codex turn/execution key.

## 3.0.29 - 2026-09-03

### Explicit cancellation replay safety

- Fixed a release-soak failure where Launcher `Cancel active Codex turn` aborted AsterBridge HTTP/browser ownership but did not mark the native turn terminal. Codex could reconnect with the same turn and AsterBridge would create a fresh browser session, replaying an already-started MCP tool. The reproducer launched the same 120-second PowerShell command twice after one explicit cancel, and both copies eventually completed.
- Explicit Launcher cancellation now tombstones every cancelled AsterBridge execution key for the lifetime of the running service (bounded to a finite registry). A reconnect for that exact cancelled turn fails before browser creation with `code=turn_cancelled` and `retryable=false`; unrelated network/UI failures keep their existing retry behavior, and a new Codex turn is unaffected.
- The lifecycle control endpoint now uses explicit-cancel semantics rather than the generic session-cache clear path. Registry, server-control, and adapter-level regression tests prove the cancelled execution key cannot create another ChatGPT browser response.
- Clarified Launcher wording: AsterBridge stops subsequent Web/MCP steps and prevents replay, but a local tool that outer Codex already started may still finish because Codex remains the tool executor and process owner.

## 3.0.28 - 2026-09-03

### Deferred Multi-Agent handoff replay fix

- Fixed a Full-Harness lifecycle mismatch found by an installed long-chain MCP soak. `Codex Native3` deliberately permits the five deferred `multi_agent_v1__*` lifecycle tools even when Codex has not preloaded them into the current turn registry, but the outer adapter still required every broker batch to appear in `parsed.context.tools`. A deferred `spawn_agent` could therefore be accepted and delivered by MCP, then rejected by the adapter, retiring the browser session and causing the next native retry to replay earlier successful tool steps.
- Moved the five deferred Multi-Agent wire names into one shared allowlist used by both the MCP server and outer adapter validation. Only `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, and `close_agent` receive this deferred exception; arbitrary unadvertised tools continue to fail closed.
- Added adapter-level regression coverage proving a deferred `spawn_agent` batch is accepted while an unrelated unadvertised tool is rejected. The pre-install focused MCP/subagent/browser regression passes **136 / 136** with TypeScript PASS.
- The reproducing 3.0.27 soak executed the same harmless `Write-Output SOAK_LONG_2` and `view_image` pair four times before the deferred `spawn_agent` transition, with each browser session aborted immediately after the deferred batch was delivered. 3.0.28 promotion requires the exact same long-chain E2E to execute those earlier steps exactly once and continue through a real child-agent completion.

## 3.0.27 - 2026-09-03

### ChatGPT connector discovery compatibility

- Fixed MCP verification and tool-capable prompt attachment against the current ChatGPT unified composer. The old short mention trigger `@c` no longer reliably surfaces custom apps such as `Codex Native3`; AsterBridge now types the complete configured app name (`@${appName}`) so ChatGPT can return the exact custom app row.
- Scoped connector row discovery to the currently visible composer `.popover` instead of the page-wide `.__menu-item` class. The current ChatGPT UI reuses that class for sidebar navigation, attachment actions, recent chats, and plugin rows, which caused misleading diagnostics that listed unrelated Japanese sidebar items as connector candidates.
- Real RoxyBrowser validation on the affected profile now succeeds with `ChatGPT connector "Codex Native3" is available in the configured external browser.` The selected connector still resolves to ChatGPT's canonical `data-id="plugin:..."` / `data-keyword="Codex Native3"` pill, so MCP broker, approval, and tool-loop behavior remain unchanged.

## 3.0.26 - 2026-09-03

### Codex model-catalog verification compatibility

- Fixed Launcher setup getting stuck at `codexCatalogVerified=false` with newer Codex desktop builds that consume the managed `model_catalog_json` directly and therefore may never issue a `/v1/models` request to the local Responses route. An intact active route plus the verified managed-catalog journal now proves catalog installation; a real `/v1/models` request remains additional live evidence and clears the restart reminder when present.
- Browser-only setup now resets the dormant `localToolTransport` selector to `mcp`, so a prior experimental Responses choice cannot survive as stale configuration and later influence a Full setup that omitted an explicit transport flag.

### Live diagnosis

- The affected Windows 3.0.25 install had a valid 11-model managed catalog (8 native Codex models plus Plus-account Instant/Medium/High Web routes), a correct `model_catalog_json` route, and a healthy 3.0.25 Browser-only daemon, but zero `/v1/models` requests and Launcher state remained `codexCatalogVerified=false`. This patch aligns Launcher verification with the current static-catalog behavior instead of treating the absent HTTP request as a model-list failure.

## 3.0.25 - 2026-09-03

### MCP restored as the primary Full Harness transport

- Restored the original product contract: MCP / `Codex Native3` is again the primary Full Harness path. The Launcher no longer advertises the connectorless Responses tool bridge as the recommended native-tool mode, and reinstalling models no longer silently keeps or enables Responses Full.
- Kept the 3.0.15-3.0.19 reliability work intact: RoxyBrowser lifecycle, native image routing, retained conversations, model-catalog ownership, automatic compaction, native-provider replay, route recovery, cancellation, and packaging hardening are unchanged by this transport correction.
- Kept the Responses direct-tool implementation only as an explicit experimental fallback (`--responses-tool-bridge`). It is never selected automatically. This preserves a connectorless diagnostic path without redefining Full Harness around repeated Web-generation tool envelopes.
- Added an explicit contract test that `defaultConfig("full")` uses `localToolTransport="mcp"`, plus Launcher wiring coverage proving the normal Setup UI routes users to MCP rather than the Responses fallback.

### Maintenance correctness

- Preserved the active Full transport across managed upgrades and Bigger Context changes. MCP remains MCP; an explicitly selected Responses experiment remains Responses instead of falling through an implicit CLI default.
- Limited legacy connector identity migration to MCP configurations so an experimental Responses config never fails an upgrade by attempting to validate an irrelevant ChatGPT App name.
- Hardened the experimental direct-tool parser to prefer raw assistant DOM text and to keep Markdown fallback normalization protocol-scoped; arbitrary tool argument strings are never rewritten.

### Release position

- The 3.0.24 Plus-account Responses shell/image E2E remains useful fallback evidence, but it is no longer a substitute for the stable Full Harness gate. 3.0.25 promotion requires a real `Codex Native3` MCP tool loop on an account/workspace that exposes the custom App.
- The maintainer machine's old managed Tunnel key/profile is no longer present in the standard AsterBridge private-storage locations after the earlier Responses migration, so MCP revalidation requires importing/recreating Tunnel credentials rather than manufacturing or recovering secrets from logs.

## 3.0.24 - 2026-09-02

### Final Markdown transport normalization

- Extended the private Responses tool-envelope compatibility path to the second renderer mutation observed in the real Plus-account shell probe: ChatGPT can escape JSON array brackets as `\\[` / `\\]` in addition to underscores. Normalization remains gated by both private Markdown-escaped AsterBridge boundary markers, and only restores the exact transport escapes observed for the marker/JSON syntax. Ordinary answers, paths, unrelated backslashes, mixed prose, stale bindings, and unadvertised tools still fail closed.
- Kept the GPT-5 tokenizer's 4,096-character bounded chunking after benchmarking larger chunks: highly compressible pathological text became dramatically slower with larger WASM calls. The usage correctness stress test now has an explicit 10-second test budget to avoid conflating Windows/WASM scheduling jitter with functional failure; repeated isolated runs remained around 2.6-2.8 seconds with unchanged token-count assertions.

### Packaging reliability

- Fixed a Windows electron-builder stall observed while it was `unpacking default Electron distribution`. Packaging now pins `build.electronDist` to the repository's locked `node_modules/electron/dist` (Electron 41.7.1), which electron-builder supports as a custom unpacked distribution. This removes the flaky cache-unzip step and makes the packaged Electron input match the dependency lock more directly.
- Added a packaging contract requiring that pinned local Electron distribution. The repaired package run progressed through `using custom unpacked Electron distribution`, copied the embedded AsterBridge runtime, built NSIS, and produced the final `asterbridge-3.0.24-win-x64.exe` plus blockmap.

### Validation notes

- Focused direct-tool + Full-Harness regression after the bracket normalization: **82 pass, 0 fail / 520 assertions**, TypeScript PASS. Packaging contract: **11 pass, 0 fail**.
- Final Windows artifact: `asterbridge-3.0.24-win-x64.exe` (**151,524,624 bytes**) with blockmap (**158,095 bytes**). Installed manifest reports `3.0.24`, bundle id `229a06ca04442562a26b542d98e0bdbc828c7399d074f473d9bc77a88c88049b`; packaged Launcher/Bun/CLI are present.
- Installed Plus-account Responses-Full shell E2E passed without a ChatGPT custom MCP App or Tunnel: outer Codex emitted a real `command_execution`, PowerShell returned `RESPONSES_BRIDGE_324_OK` with exit code 0, and the same Web turn returned the final sentinel.
- Installed Plus-account image generation E2E passed through the direct Responses bridge: rollout ordinal 8 contains `function_call name=imagegen` with call id `dtc_198b26ab82a7b592d16d8bb3`, ordinal 9 reports completed extension execution, ordinal 10 contains the matching `function_call_output`, and the Web turn completed normally. A new 1254×1254 PNG was written under Codex `generated_images` (858,753 bytes; SHA-256 `5B6081312C25A326FDC489094F08E4667342C45E5386943C378497CB7D84C74A`).
- Production health returned to `active_http_turns=0` and `active_browser_turns=0` after both live E2E turns.
- The final exact-source release gate is rerun after the packaging-config change before promotion; publication remains a separate action.

## 3.0.23 - 2026-09-02

### ChatGPT Markdown-safe direct tool envelopes

- Fixed a real Plus-account Responses-tool turn where ChatGPT emitted the private bridge envelope correctly but its Markdown renderer escaped every underscore (`\\_`), causing the strict parser to treat the request as ordinary assistant text instead of a Codex tool call.
- The compatibility path is deliberately narrow: underscore unescaping is applied only when both private AsterBridge boundary markers are themselves Markdown-escaped. Exact envelopes, ordinary answers, paths, and unrelated backslashes are left untouched; malformed or mixed-prose envelopes still fail closed.
- The prompt contract also now explicitly asks ChatGPT to emit the private envelope as raw transport text without Markdown escaping.

### Validation notes

- Focused direct-tool + Full-Harness regression after the renderer-normalization fix: **82 pass, 0 fail / 520 assertions**. The failed installed 3.0.22 probe executed no command; it safely surfaced the escaped envelope as text, proving no unauthorized tool execution occurred before this fix.

## 3.0.22 - 2026-09-02

### Clean Responses-Full migration state

- Finalized the 3.0.21 lifecycle split by removing the legacy `tunnel` object from the primary config whenever Full mode is migrated to `localToolTransport=responses`. Existing tunnel key/profile files are left intact on disk, so switching back to MCP can rediscover them without making the active Responses runtime depend on stale Connector state.
- Production setup now proves the migration as `mode=full`, `transport=responses`, and no tunnel block while keeping the managed Codex route and bounded remote-v1 compaction contract unchanged.

### Validation notes

- Source setup migration was exercised against the real Windows configuration and produced `mode=full / transport=responses / tunnelPresent=false`. Full source/package/install and real Plus-account shell + image generation E2E remain the promotion gates for this exact 3.0.22 artifact.

## 3.0.21 - 2026-09-02

### Responses Full lifecycle decoupled from Tunnel

- Completed the lifecycle half of the connector-independent Full Harness. `mode=full` plus `localToolTransport=responses` no longer requires Tunnel credentials, OpenAI Tunnel control-plane readiness, a ChatGPT custom MCP App, or a launcher-managed tunnel process. The outer Codex Responses tool bridge remains the only local-tool transport in this mode; Codex still owns approval, sandboxing, and execution.
- Added one shared MCP-transport predicate across config validation, setup, Doctor, and the Launcher runtime supervisor. Legacy Full installs with no explicit transport remain MCP for backward compatibility, while an explicit Responses Full config can load and start with no `tunnel` block at all.
- Setup no longer invokes tunnel-client when the Responses bridge is selected. Switching back through Launcher MCP setup now passes `--mcp-tool-bridge` explicitly so the transition is reversible instead of inheriting Responses mode and rejecting Tunnel credentials.
- Launcher recovery/readiness logic now requires a managed tunnel only for MCP transport. Responses Full starts and recovers the Responses daemon exactly like Browser-only while preserving the Full tool registry. DEV Full remains intentionally MCP-only until its isolated harness grows a Responses listener.
- Doctor reports Responses Full as tool-ready without probing `api.openai.com`, Tunnel credentials, tunnel-client, or Connector visibility.

### Validation notes

- Focused connectorless lifecycle + direct-tool regression: **72 pass, 0 fail / 405 assertions** across runtime/config/setup/direct-tool/Full-Harness tests, plus Launcher Supervisor/renderer focused **67 pass, 0 fail**, TypeScript PASS.
- Windows package/install and real Plus-account shell + `image_gen__imagegen` E2E are still required before promotion.

## 3.0.20 - 2026-09-02

### Connector-independent outer Codex tools

- Added an optional **native Responses tool bridge** for Full Harness turns. It restores outer Codex shell/file/patch/image/tool access when the signed-in ChatGPT account does not expose a custom MCP App such as `Codex Native3`; the existing Native3 MCP transport remains supported for accounts/workspaces that expose it.
- The Web model never executes a local tool through this fallback. AsterBridge supplies only the current outer Codex turn's advertised tool manifest plus a response-bound private binding, accepts a strict whole-answer tool-request envelope, validates the requested wire names and argument shape, then emits ordinary Responses `function_call` / `custom_tool_call` items. Codex remains the only executor, sandbox/approval authority, and source of real tool results.
- Direct-tool bindings fail closed when stale or malformed. Unknown/unadvertised tools, mixed prose plus a private envelope, freeform/function argument mismatches, disallowed `tool_choice`, and forbidden parallel calls are rejected before any native tool event is emitted. Deterministic call ids make provider retries replay the same Codex call instead of duplicating an effect.
- Tool results continue through the canonical Codex history on the same retained ChatGPT conversation. The next browser response receives only the canonical suffix containing the real `tool_result`, can request another current-turn tool when required, or completes with a normal user-facing answer. Private direct-tool envelopes are never streamed to Codex as assistant prose.
- Full setup can explicitly select `--responses-tool-bridge` or `--mcp-tool-bridge`; existing Full installations remain MCP unless migrated deliberately. Connector setup is no longer required when the Responses bridge is selected.

### Validation notes

- Initial connector-independent tool-bridge regression: **81 pass, 0 fail / 519 assertions** across the full ChatGPT harness, direct-bridge security contract, model mapping, and prompt contract, with TypeScript PASS. This includes a complete two-round tool loop: Web request -> native Responses tool call -> real canonical `tool_result` -> same retained conversation -> normal final answer.
- Windows packaging and installed Plus-account E2E, including a harmless shell call and `image_gen__imagegen`, remain required before 3.0.20 can be promoted.

## 3.0.19 - 2026-09-02

### Codex 0.150 automatic-compaction compatibility

- Installed 3.0.18 live testing proved that Codex 0.150 automatic compaction was selecting `remote_compaction_v2`, whose client-side replacement builder retains up to 64k tokens of user/developer/system history before appending the provider compaction item. That protocol cannot safely serve the measured 41k Instant Web window, regardless of how small AsterBridge makes the returned summary.
- Added reversible v9 Codex route ownership for `[features].remote_compaction_v2 = false` while AsterBridge is connected. Codex therefore continues to use OpenAI remote compaction, but through `/responses/compact` v1 where AsterBridge can return the bounded replacement history implemented in 3.0.18. Disconnect and uninstall restore the user's prior feature line/table byte-for-byte; active-route edits fail closed instead of being overwritten.
- Bounded the exact latest-user appendix added to structured browser compaction handoffs. Short prompts remain exact; oversized prompts keep a token-bounded beginning/end excerpt with an explicit omission marker, capped at 1,024 GPT-5 tokens. This removes a second live amplification where a 112k-character latest user message was duplicated into `ocx1:` and expanded to roughly 150k base64 characters.

### Windows promotion-gate hardening

- Fixed packaged Windows smoke and the public PowerShell installer so an NSIS bootstrap process returning before its detached exact installer no longer produces a false failure. Success still requires bounded process settlement plus the expected registry, launcher, packaged runtime, and manifest evidence; a bare non-zero exit without those completion signals remains a failure.
- Gave the packaged Launcher smoke a separate bounded runtime-install window instead of killing a healthy first launch at the old 45-second generic command timeout while thousands of embedded runtime files were still being copied.

### Validation notes

- Focused compaction/integration/model-catalog regression after the v9 route and latest-user bound: **64 pass, 0 fail / 271 assertions**, TypeScript PASS. The final full source gate also passed again: **41/41 core files**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, renderer production build, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Packaged Windows 3.0.19 installed successfully with a verified `3.0.19 / win32 / x64` runtime manifest. The installed Launcher smoke wrote `ok=true`, `packaged=true`, `runtimeVerified=true`, and `trayReady=true`; production then migrated the active Codex route to v9 with `remote_compaction_v2 = false` and returned a healthy `127.0.0.1:17841` daemon.
- Real installed browser-only Instant validation crossed the 31,980-token window (`lastInput=34,760`), then the next turn emitted a Codex `compacted` record plus `ContextCompaction`; the replacement reduced the following live turn to **17,639 / 31,980** input tokens and returned `ISO319_AFTER_REAL_COMPACT_OK` without `context_window_exceeded`. The same compacted thread then switched to native `gpt-5.6-sol` and returned `NATIVE_AFTER_V1_COMPACT_319_OK` without encrypted-content verification errors, and survived a complete daemon restart before returning `RESTART_CONTINUITY_319_OK`.
- A real eight-image Browser-only High turn completed at **51,487 input tokens** with `EIGHT_IMAGES_HIGH_319_OK`; the same payload on Instant correctly exceeded the 31,980-token model budget before browser submission. A forced client cancellation returned the isolated runtime to `active_http_turns=0` and `active_browser_turns=0`. Production route disconnect/reconnect restored the unmanaged Codex config and then reinstalled `openai_base_url`, managed `model_catalog_json`, and `remote_compaction_v2=false` with `errors=[]`.
- Stable publication remains blocked by the account-bound Full Harness gate: on the maintainer's current ChatGPT Plus session the live Apps menu does not expose the configured `Codex Native3` custom MCP app even after AsterBridge's bounded catalog refresh, so a fresh Native3 tool turn and `image_gen__imagegen` E2E cannot currently be re-proven. AsterBridge fails closed rather than silently substituting ChatGPT's first-party image tool or claiming Full Harness readiness.

## 3.0.18 - 2026-09-02

### Model-aware post-compaction headroom

- Replaced the fixed 20k-token retained-user-history allowance for routed v1 compaction with a model-aware budget derived from the selected `chatgpt-web/*` route's real `auto_compact_token_limit`.
- The replacement-history planner now reserves the larger of the compact request's measured stable system/developer/tool overhead and the observed 17k-token Codex harness floor, plus the actual summary token count, structural allowance, and at least 6k tokens of post-compaction headroom. Large-window High/Pro routes still retain up to 20k historical tokens; Instant's 32k gate retains only what can safely fit after those reserves.
- Retained text is counted with the GPT-5 tokenizer instead of the old four-characters-per-token approximation. Retained historical images now consume the same model-aware budget using the browser input image reserves, while the existing ten-image hard cap remains in force.
- Added privacy-safe `[asterbridge:compaction]` telemetry with only model and token-budget figures so installed validation can prove the selected budget without logging prompt or summary content.

### Validation notes

- Focused compaction regression: **20 pass, 0 fail / 87 assertions**, including the 32k Instant gate, larger exposed harnesses, token-dense history, and image-budget accounting.
- Full source release gate: **41/41 core files PASS**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/renderer production build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Packaged Windows installation and live automatic-compaction continuation remain the final promotion gates before publication.

## 3.0.17 - 2026-09-02

### Native Sol replay after Web compaction

- Fixed a cross-provider continuation failure where a thread compacted while using `chatgpt-web/*` could later fail after switching back to native `gpt-5.6-sol` with `encrypted content ocx1... could not be verified`. `ocx1:` is AsterBridge's transparent Web-compaction envelope, not an OpenAI-encrypted blob, and must never be forwarded to the official native backend as `encrypted_content`.
- Native passthrough now detects AsterBridge `compaction` / `compaction_summary` / `context_compaction` envelopes and replays their decoded summary as ordinary user context before a native provider switch. The local `previous_response_id` is removed so the official backend never tries to resolve an AsterBridge-owned response id.
- AsterBridge `ocxr1:` reasoning envelopes continue to be stripped to their readable summary/content for native replay, while genuine OpenAI encrypted reasoning/compaction items are preserved with their original provider-owned `id` and `encrypted_content` intact so verification bindings are not disturbed.
- Native-only requests remain byte-for-byte passthrough. Focused native transport regression now covers the exact Web-compaction-to-native-Sol wire shape that produced the verification error.

## 3.0.16 - 2026-09-01

### Deterministic Codex Web model metadata and compaction routing

- Added a reversible v8 Codex integration that owns both `openai_base_url` and an AsterBridge-generated `model_catalog_json` while the bridge is active. This fixes Codex 0.149 turns intermittently reporting `Model metadata for chatgpt-web/... not found`, which previously caused custom Web models to fall back to native defaults and could bypass their intended automatic-compaction thresholds.
- The managed static catalog preserves every native Codex model and appends the same account-gated `chatgpt-web/*` rows served dynamically by `/v1/models`, including their exact context windows, `auto_compact_token_limit`, reasoning metadata, V1 multi-agent compatibility, and current account capabilities.
- Managed catalog source selection is deterministic and local-first: an existing user `model_catalog_json` is treated as read-only source, otherwise AsterBridge uses `models_cache.json`, and finally the installed Codex binary's `codex debug models --bundled` catalog for a clean machine. User catalog files are never modified.
- Route disconnect restores the user's prior `openai_base_url` and `model_catalog_json` byte-for-byte while retaining the verified managed copy for reconnect. Uninstall restores the prior config and removes only AsterBridge's own unchanged managed catalog. SHA-256 integrity checks fail closed if that managed file or assignment is changed externally.
- Explicit `--replace-codex-route` may adopt a newer user `openai_base_url` as the next reversible baseline, but it still refuses to overwrite a changed managed catalog assignment or tampered managed catalog file.

### Validation notes

- v8 integration/model-catalog focused regression: **37 pass, 0 fail / 152 assertions**, with root TypeScript PASS before full 3.0.16 promotion.
- Installed/live automatic-compaction and browser-surface lifecycle validation remains the final promotion gate for this release candidate.

## 3.0.15 - 2026-09-01

### Browser line-ending normalization

- A six-thread installed 3.0.14 stress run reproduced the same deterministic `prompt_attachment` mismatch (`expectedChars=31931, actualChars=31929`) even though both the Responses daemon and tunnel MCP worker were confirmed to be 3.0.14. The two-code-unit delta is consistent with Chromium/Lexical exposing inserted Windows CRLF line endings as LF.
- Prompt integrity comparison now canonicalizes CRLF and lone CR to LF in addition to the existing NFC/presentation-selector handling. This preserves line-break semantics while still rejecting deleted/added line breaks, tabs, spaces, punctuation, ZWJ removal, ordinary character mutations, and other non-equivalent text changes.
- Regression coverage explicitly accepts CRLF/CR-to-LF representation changes and rejects collapsing two logical line breaks into one.

### Validation notes

- Installed 3.0.14 stress testing, rather than a mock-only test, found this remaining edge before public release. Full 3.0.15 promotion and the same six-thread LRU scenario are rerun before handoff.

## 3.0.14 - 2026-09-01

### Lexical prompt-integrity compatibility

- Fixed a live 3.0.13 Full Harness failure where ChatGPT's Lexical composer preserved the prompt semantics but canonicalized its Unicode representation, leaving the observed text two UTF-16 code units shorter and causing repeated `prompt_attachment` integrity failures before an outer image tool could run.
- Prompt verification now accepts only two additional representation-level equivalences: Unicode NFC canonical composition and removal/addition of U+FE0E/U+FE0F text/emoji presentation selectors. ZWJ, whitespace, punctuation, ordinary characters, line breaks, and every non-canonical mutation remain exact and fail closed.
- The regression suite covers dropped emoji/text presentation selectors, decomposed-to-NFC text, the existing repeated-space/NBSP case, and explicit rejection of ordinary character deletion and ZWJ removal.

### Validation notes

- Focused Browser Worker regression after the fix: **77 pass, 0 fail / 360 assertions**, plus root TypeScript PASS. Full core promotion remained **41/41 deterministic batches PASS**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Packaged Windows 3.0.14 installed successfully, upgraded the managed runtime from 3.0.13 to 3.0.14, kept the Codex route active with `errors=[]`, returned Doctor `ready`, and verified `Codex Native3` in the configured external browser.
- A fresh image turn that had failed under 3.0.13 at `expectedChars=31931, actualChars=31929` completed under 3.0.14, queued/delivered `image_gen__imagegen`, wrote an **835,896-byte PNG**, and emitted `[asterbridge:image] endpoint=images/generations durationMs=15793 status=200 origin=upstream retryable=false`.
- A real eight-image turn completed file attachment in **12.124 s**, selected `uploadTimeoutMs=220000` / `sendTimeoutMs=104000`, accepted submission after **18.098 s**, and returned `MULTI8_OK` without the former fixed-20-second send retry loop. Final `/healthz` reported `active_http_turns=0` and `active_browser_turns=0`.

## 3.0.13 - 2026-08-31

### Browser-surface, multi-image, and image-route reliability

- External-browser maintenance operations (`browser check`, account/session inspection, connector verification, and smoke probes) now use ephemeral task surfaces. Their page is closed after both success and failure, and maintenance honors the same five-physical-surface ceiling as normal turns by evicting the oldest idle retained conversation when necessary.
- Clarified retained-page lifecycle through implementation and tests: successful conversations may remain for bounded continuation reuse, while failed/aborted turns, retired conversations, compaction retirement, LRU eviction, and worker shutdown close their owned browser surfaces. Maintenance probes no longer add an unbounded extra Roxy/system-browser page.
- Multi-image attachment handling now decodes prompt images once and sizes upload/submission deadlines from the attached image count and aggregate bytes. Text-only sends keep the existing 20-second budget; image-heavy sends receive a bounded 45–120 second acknowledgement budget and file upload receives a bounded 120–300 second budget. This fixes the observed eight-image case where attachments completed in 13–17 seconds but a fixed 20-second send stage repeatedly timed out before ChatGPT acknowledged submission.
- When outer Codex advertises `image_gen__imagegen`, Temporary Chat is now explicitly forbidden from using ChatGPT's separate first-party image-generation path. Image creation must travel through `Codex Native3 -> codex_tool_call -> image_gen__imagegen`, keeping artifact delivery, retry semantics, and `[asterbridge:image]` status/origin telemetry on one deterministic path.
- Live investigation disproved a fixed 60-second local proxy limit: the same configured proxy successfully completed native image-edit requests in roughly 54.5 seconds and 150.2 seconds. A separately reproduced "consecutive HTTP 502" turn emitted no broker image call and no AsterBridge image telemetry, proving that failure had bypassed AsterBridge through ChatGPT's first-party image tool; the routing contract above closes that split-path failure mode.

### Validation notes

- Focused browser/image-route regression after the changes: browser-worker + prompt contracts **98 pass, 0 fail / 510 assertions**. Full 3.0.13 promotion and installed live E2E remain pending.

## 3.0.12 - 2026-08-31

### Upgrade recovery and external-browser session handling

- Fixed managed Launcher upgrades unnecessarily hard-gating on a fresh RoxyBrowser/system-browser account capability probe. When the external browser host/profile is unchanged and the existing config already contains verified Sol/Pro capability flags, an upgrade now reuses those flags; first setup, browser/Profile changes, missing capability evidence, and explicit `--refresh-account-capabilities` still perform a live probe.
- Fixed failed cross-version Launcher upgrades manufacturing a secondary `Previous runtime recovery returned needs-setup` error. After restoring the previous config/checkpoint, the new Launcher no longer tries to start that older versioned runtime under the new Launcher ownership contract; the safe fallback is the restored pre-bridge Codex route.
- A logged-out ChatGPT page is now detected structurally through the visible `/auth/login` surface and reported as a non-retryable `chatgpt_session_expired` authentication error. The previous ambiguous `login is expired or the Temporary Chat surface is unavailable` fallback is reserved for genuinely composer-less pages without an explicit login surface.

### Validation notes

- Focused browser/setup/rollback regression: **118 pass, 0 fail / 356 assertions** before the full 3.0.12 gate.
- The reported Windows failure was reproduced with a real RoxyBrowser profile: retained pages still showed an already-loaded composer, while every newly navigated Temporary Chat page displayed ChatGPT's logged-out surface. This confirmed that the primary failure was an expired browser session and the `needs-setup` text was a separate rollback bug.
- Full 3.0.12 source gate passed: **41/41 core files**, Launcher **203 pass / 0 fail / 1 Windows-inapplicable skip**, TypeScript/renderer build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- After re-authenticating the same RoxyBrowser profile, a live capability probe returned `sol=true, pro=false`. The installed Windows 3.0.12 Launcher then upgraded the persisted managed runtime from 3.0.10 to 3.0.12 without another browser capability probe, without `chatgpt_session_expired`, and without the previous secondary `needs-setup` recovery error. It preserved the deliberately disconnected route during the upgrade.
- After reconnecting the bridge, the installed 3.0.12 daemon reported healthy on `127.0.0.1:17841`, Doctor returned `ok=true` including the image-backend route and generated-image storage diagnostics, and the configured external browser verified `Codex Native3` successfully.
- Installed `chatgpt-web/high` text E2E completed without a native tool call. A subsequent image E2E produced a real **959,359-byte PNG** and emitted `[asterbridge:image] endpoint=images/generations durationMs=20182 status=200 origin=upstream retryable=false`, proving the new image telemetry on the production path.

## 3.0.11 - 2026-08-31

### Image reliability and bounded image diagnostics

- Added privacy-safe native image transport telemetry. Every `/v1/images/generations` / `/v1/images/edits` passthrough now records only endpoint, duration, HTTP status, failure origin (`upstream` versus local `transport`), retryability, and a bounded transport error code. Prompts, image bytes, bearer tokens, proxy credentials, and generated content are never logged.
- Preserved image POST idempotency boundaries: AsterBridge still forwards each native image request exactly once and never retries a 502/503/504 in the HTTP transport layer, avoiding duplicate generations when an upstream request completed but its response failed in transit.
- Full Harness now recognizes only `image_gen__imagegen` tool failures carrying HTTP 502/503/504 as transient/retryable. The Web model may retry the same semantic generation at most twice, then must report a temporary backend failure instead of treating image generation as permanently unavailable or looping indefinitely.
- Doctor now separately probes the Codex image backend route through the active proxy/network path and reports local `~/.codex/generated_images` file count and disk usage without deleting user assets.
- Documented the existing browser-image bounds explicitly: at most **10 images per Web turn**, **20 MB per image**, **50 MB aggregate per turn**, newest images win on overflow, and image-generation history references are separately capped at **5**.

### Validation notes

- Focused image reliability / Doctor / prompt regression: **49 pass, 0 fail / 274 assertions** before the full 3.0.11 gate.

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
