# Upstream v5 Windows Selective Integration Plan

This document tracks selective integration from `miuuyy/codex-chatgpt-web` v5 into AsterBridge.
The target is **Windows-first AsterBridge**, not feature parity with upstream. The stable AsterBridge
architecture remains authoritative: `Codex Native3`, RoxyBrowser/system-browser support, Full Harness,
retained Web tasks, native compaction, Bigger Context, and AsterBridge image-provider routing.

## Upstream baseline

- Upstream remote: `https://github.com/miuuyy/codex-chatgpt-web.git`
- Audited upstream head: `e85e369` (`v5.0.6`)
- AsterBridge head at audit start: `4ecfa20`
- Historical merge base: `e076a29049a1290a783521a151070a46c6dd4311`
- Difference at audit start: 182 changed files / roughly 40.7k upstream-added lines.

This is too large for a wholesale merge. Every item below is a behavior-level port or a narrowly
reviewed commit delta.

## Explicit exclusions

The following upstream features are **not** AsterBridge goals for this integration cycle:

- Zero Risk/manual clipboard interaction mode.
- macOS passkey sign-in.
- macOS-only sleep blockers or platform-specific launcher work that has no Windows value.
- Japanese launcher localization.
- Connector identity changes away from `Codex Native3`.
- Replacing RoxyBrowser/system-browser ownership with upstream's Electron-only assumptions.

## U5-W1 — Remote compact and BrowserTurn reliability

Status: **DONE for 3.0.38**.

Upstream references:

- `ecc1084` — staged Bigger Context acknowledgement headroom.
- `3b0ac80` — perform a fresh assistant observation before expiring response grace.
- `10106e4` — do not charge browser stage budgets for time spent suspended/asleep.
- Later v5 retained-compaction fixes (`bd535d8`, `a3a5083`, `740c4ea`, `0b053b6`) were audited but are intentionally deferred to U5-W2 because they rewrite handoff/physical-settlement ownership rather than fixing the fallback BrowserTurn boundary addressed by this hotfix.

Implemented locally:

- Ordinary first-response grace remains 60 s.
- Multipart stage send and acknowledgement each receive a dedicated 180 s budget, matching the
  upstream staged-transaction contract rather than the temporary AsterBridge 5-minute blanket grace.
- Browser stage timing now tracks large event-loop gaps as system suspension and refunds that time
  from the stage budget. The implementation is intentionally platform-neutral and useful for Windows
  sleep / Modern Standby; no macOS-only power blocker is imported.
- Multipart acknowledgement expiry performs one fresh global assistant lookup before declaring the
  response DOM missing. The fallback is accepted only when the visible text is the exact
  transaction-bound acknowledgement or its prefix, so an older retained answer cannot be rebound
  silently.
- A response element that provably exists but cannot be inspected remains an explicit local
  `response_dom_read_error`, not an absent-response 502.

Validation:

- Focused Browser Worker + Full Harness: **140 pass / 0 fail**.
- Complete release verification: Core **42 / 42** deterministic batches, Launcher **217 pass / 0 fail / 1 platform-inapplicable skip**, TypeScript PASS, renderer build PASS, and `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Installed Windows 3.0.38 candidate bundle `d1e8bb58b7a56d6cf9e8c407e63e2b83a40e945af70c2f901627424376883ed0` ran the production Full route with `turnBrowserHost=roxybrowser`.
- A **543,781-character** native `/v1/responses/compact` request completed **HTTP 200 in 54.85 s**.
- Browser diagnostic trace `253e9048a6a7_fallback` recorded `multipart-stage-1-acknowledged`, `multipart-stage-2-acknowledged`, final-part effort restoration, `send-accepted`, `response-visible`, and `turn-completed` in order. The previous false `ChatGPT did not create a response DOM` 502 did not recur.

Acceptance gate: **PASS**.

## U5-W2 — Windows turn lifecycle delta

Status: **DONE**.

3.0.42 completes the deferred `a3a5083` ownership work without importing its later helper protocol wholesale. `ChatGptTurnRuntime` / `ChatGptTurnSession` distinguish the logical browser result from `physicalSettlement`, and every retirement/cancellation path that releases browser ownership waits on the latter. Structured compaction also keeps a failed execution key owned until registered retained-handoff/fallback cleanup has physically settled, preventing a retry from racing a still-unwinding Roxy/system-browser surface. The persistent Launcher helper exposes a later cross-process `settled` boundary and negotiates retained prompt selection after the Launcher lease decides whether the owned surface is fresh or reused.

3.0.41 release slice: the v5.0.6 audit continues as selective deltas rather than a wholesale lifecycle rewrite. Roxy `browser_unavailable` wrappers now retain their native `cause` for diagnostics, and assistant-response presence observation is bounded so a stalled `Locator.count()` cannot hang the browser loop before the existing DOM-health machinery can react. A proven response-DOM transport failure marks the shared external CDP connection suspect without disrupting concurrent turns; the next sole owner drops the stale Playwright transport/retained handles before normal endpoint rediscovery, so native retry cannot become pinned to a zombie `managedBrowserReady`. Submission acceptance also no longer checks terminal UI state through the not-yet-bound assistant locator, because that boundary can otherwise inherit a historical failed response and reject a newly accepted message; terminal response errors remain enforced once the current assistant turn is bound. Those bound-turn checks now recognize both the known terminal text and ChatGPT's structural `regenerate-thread-error-button`, avoiding locale/wording-dependent failure detection. The final v5.0.6 `Stopped thinking` behavior is also backported narrowly: only visible status UI in the bound response is terminal, quoted answer/commentary/code text is excluded, and the result is an explicit non-retryable `chatgpt_stopped_thinking` upstream error rather than an inferred cancellation/quota verdict or a later generic timeout. The upstream fresh-assistant-before-grace fix (`3b0ac80`) is already structurally satisfied by AsterBridge's snapshot-first DOM health loop, and the Interrupt path determinism change (`9929638`) is already present, so neither is duplicated as a second implementation.

Diagnostics in this slice also record canonical structural evidence for the effort slider and current turn state (`aria-valuemin/max/now`, user-turn count, visible stop buttons, assistant Markdown/streaming/completion-action counts). The upstream move of the stalled snapshot from 30 to 60 seconds is intentionally not copied: AsterBridge's 30-second checkpoint does not terminate the turn, and keeping the earlier snapshot improves evidence capture for Windows/Roxy stalls without changing runtime liveness semantics.

Audited upstream v5.0.5/v5.0.6 deltas are being split into independently verifiable Windows changes instead of importing the v5 lifecycle rewrite wholesale.

Implemented — exact Codex Interrupt ownership:

- Added exact native-turn cancellation keyed by trusted `thread_id + turn_id` for both the HTTP Responses owner and the matching retained ChatGPT browser session. Concurrent turns, including a newer turn on the same thread, remain untouched.
- The HTTP lifecycle remembers an Interrupt that arrives before request parsing has bound the native identity; once that request later binds the same identity it is aborted immediately rather than escaping through a race.
- Added the internal `hook interrupt` CLI command that validates Codex's `Interrupt` JSON from stdin and forwards the exact identity to the authenticated local `/admin/interrupt-turn` endpoint.
- Added reversible Codex `[[hooks.Interrupt]]` ownership and journal **v10**. Existing v9 route/catalog/`remote_compaction_v2` state remains the baseline and migrates to v10 on Setup. Disconnect/uninstall removes only the owned hook and restores the previous route exactly.
- Hook verification tolerates native Codex TOML rewrites that normalize line endings or insert unrelated tables before the trailing managed marker, while modified owned definitions, trust state, marker duplication, or hook reordering remain fail-closed.
- Focused integration/hook/server/session tests: **66 pass / 0 fail / 8 existing process-level skips**; TypeScript PASS.
- Windows/Roxy production gate: installed 3.0.39 bundle `ddd2aab9c091b2e04c6bd3ed07d42d5483e23cb24b6f121e4e86d9febfa6e194`; the production journal migrated to v10 and the managed hook command pointed at that durable runtime. A production-format long Responses turn reached `1 HTTP / 1 browser`; standard Codex Interrupt JSON returned `HOOK_EXIT=0`, health settled to `0/0`, the request terminated with HTTP **499**, and health remained `0/0` five seconds later with no retry resurrection. The exact Interrupt slice therefore passes its live gate.
- Windows packaging observation from the same deployment: NSIS bootstrap exit code `2` is not sufficient failure evidence on this machine. `/S` completed HKCU registration, the exact 3.0.39 bundle, launcher executable, and uninstaller despite returning `2`; package smoke and the public PowerShell installer now use a bounded 60-second finalization grace and verify complete installed state instead of trusting that bootstrap code alone.
- Recovery after the DevPilot disconnect confirmed that the clean-install transaction had in fact finalized: Windows reports AsterBridge 3.0.39 installed, the launcher and uninstaller are present, the packaged manifest matches bundle `ddd2aab9c091b2e04c6bd3ed07d42d5483e23cb24b6f121e4e86d9febfa6e194`, and the durable 3.0.39 runtime contains the same manifest plus Bun and the CLI entrypoint. No second installer run was required.

Implemented and released in **3.0.40** — deterministic retained compaction at the daemon/session boundary:

- Active compaction no longer mutates an already-owned canonical tool result into a same-response checkpoint request. Canonical results are delivered unchanged; only a later, not-yet-executed tool request may receive the stop instruction.
- The checkpoint now comes from exactly one dedicated structured retained-conversation handoff. The old browser-visible-text fallback is removed; missing structured submission fails closed under the bounded handoff deadline.
- The handoff deadline spans transaction acquisition, structured submission, browser shutdown, and token cleanup. Exact duplicate compaction executions share one in-flight/result promise; failures are evicted so retries are not poisoned by a stale rejected cache entry.
- Retained-conversation retirement can detach the browser epoch while preserving a terminal ordinary final response under the compacted source execution key, avoiding unnecessary regeneration when the ordinary response wins the race before any compaction instruction is delivered.
- `a3a5083` was audited as the next candidate but its helper/Launcher cleanup ownership depends on the newer cross-process helper protocol. That protocol is intentionally deferred rather than partially imported into the current Roxy/system-browser production path.
- Retained external pages now have a bounded **5 s** observability gate before reuse. A Roxy/system-browser page can remain `isClosed() === false` after its CDP/DOM transport has stalled; such a page is now evicted and closed before `requireRetainedConversation` is evaluated, which turns the stale epoch into the existing `compaction_source_unavailable` recovery instead of a late browser-stage timeout.
- Final managed-config preservation audit against the relevant `b536fdb` hook changes is complete for the existing v10 route: unrelated Codex TOML tables inserted before the managed end marker survive disconnect/uninstall, while appended definitions that extend the owned Interrupt hook/state and earlier Interrupt-group reordering fail closed. The unrelated upstream catalog/Voice/subagent protocol redesign is deliberately not imported.
- Focused validation currently passes TypeScript plus browser-worker contract/retained-compaction **93 pass / 0 fail**.

Final U5-W2 implementation/audit state:

- helper physical-settlement ownership, retained-surface prompt selection, MCP progress/completion-fence forwarding, structured Launcher compaction, false-green tunnel MCP startup gating, descriptor-v3 native target ownership, and bounded exact same-page rebind are all backported as independent slices rather than by importing the broader upstream rewrite;
- the remaining Windows-relevant Launcher lifecycle/update transaction deltas are now aligned: pre-boot ownership evidence cannot survive a Windows reboot/PID reuse as live ownership; tunnel recovery uses a forced replacement instead of re-adopting the runtime that monitoring rejected; fatal local MCP `502` evidence triggers recovery immediately; reconnect clears stale diagnostics discovery; launcher upgrades force a fresh account/model capability probe; and setup rollback preserves a symlinked Codex `config.toml` by restoring the verified link target rather than replacing the link;
- remaining upstream differences were classified rather than copied: dual automatic/manual tunnel state and the `safe` contract belong to the explicitly excluded Zero Risk path; `subagentProtocol` / `stallTimeoutSec` belong to U5-W3 capability work; Linux AppImage runner/update changes are not part of the Windows-first gate; upstream's extra browser-only targeted-cancel API is not required for current ownership because AsterBridge already has exact native Codex Interrupt (`thread_id + turn_id`) plus the separate explicit all-turn cancel path;
- focused lifecycle/update validation passes **109 pass / 0 fail / 2 environment/platform skips**, with TypeScript PASS. One skip is the symlink preservation assertion on the current Windows host because file-symlink creation is denied by the OS test environment; the other is Linux AppImage execution on Windows.

3.0.41 focused release validation: browser-worker contract + Full Harness **146 pass / 0 fail / 789 assertions**, TypeScript PASS, version/docs contracts PASS, `git diff --check` PASS, and final candidate `35e0605` passed all five CI jobs including Windows.

Gate: **PASS / DONE**. The exact Interrupt/config-preservation slices, 3.0.40/3.0.41 Roxy/browser hardening, and the 3.0.42 helper physical-settlement/progress/retained-compaction/live-page-rebind/lifecycle slices passed their focused gates. The required short Windows production-style gate also passed on the 3.0.42 candidate: the live Roxy account probe reported `Sol=true / Pro=false`; a real Temporary Chat smoke selected High and returned `CODEX WEB GPT READY`; an isolated Full/MCP runtime on `127.0.0.1:17842` reached healthy/ready tunnel state; native Codex then completed two same-owner turns, a structured retained compaction, and the post-compaction turn. The terminal event was `ASTERBRIDGE_CODEX_COMPACTION_OK` with `sameOwner=true` and `itemType=contextCompaction`. Cleanup stopped the candidate runtime/tunnel and left the two unrelated DevPilot tunnels untouched. An attempted embedded-Launcher probe was not counted because the legacy Electron partition was logged out; the relevant authenticated Windows/Roxy production path satisfied this document's live-browser completion rule.

The v5.0.5 tunnel lifecycle delta is now selectively aligned for Windows Full mode: Launcher local health requires `/healthz`, `/readyz`, and observable MCP diagnostics; recent dispatcher-internal `502` evidence for `initialize` / `tools/call` blocks readiness even when the two HTTP health endpoints are green. Both adoption of an existing managed alias and a newly connected alias must pass the MCP transport gate before monitoring starts, and a failed gate runs the existing cleanup path instead of publishing a false-ready runtime. Inventory can still prove an alias stopped, but inventory `ready` alone cannot replace missing transport evidence. Focused runtime-supervisor/runtime-host/update coverage passes **105 / 0 / 1 platform skip**.

3.0.42 now carries the complete selectively backported U5-W2 implementation: physical-settlement ownership, retained Launcher continuity, helper MCP progress/completion fences, structured retained compaction, false-green MCP transport gating, descriptor-v3 native target identity, bounded same-page rebind, and the applicable Windows lifecycle/update transaction hardening. It intentionally does not absorb Zero Risk dual-tunnel semantics, Native-subagent capability configuration, or Linux-only updater changes. The browser/Full-Harness/compaction/lifecycle gate is **185 pass / 0 fail / 8 existing Windows skips / 959 assertions**; the dedicated Launcher runtime/update gate is **109 pass / 0 fail / 2 environment/platform skips**; TypeScript and Launcher production build pass. The Windows/Roxy live release gate above closes U5-W2.

The live-gate cleanup also exposed and closed one terminal Windows lifecycle defect outside the Launcher supervisor itself. The `tunnel` CLI had unconditionally invoked the macOS LaunchAgent wrapper before native stop/start handling, so Windows `tunnel stop` failed even though the native runtime manager was valid. Platform ownership is now explicit: macOS keeps LaunchAgent management, while Windows/Linux use native `runtimes connect/stop`; successful stop returns the proven stopped state without a second potentially blocking status query. Focused CLI/tunnel coverage passes **21 pass / 0 fail / 74 assertions**, TypeScript PASS, and the real Windows stop command exits 0.

Launcher retained-surface ownership is connected end-to-end through the helper prompt and compaction boundaries: `/v1/turn/start` accepts validated conversation ownership metadata and reports `reused`, the helper emits `prepared_selected(reused)`, and only then does the daemon compile and acknowledge the exact fresh or resume prompt. `/v1/turn/end` may retain only a completed owned tab, `/v1/turn/release` removes only ready tabs for the exact conversation key, and a required-but-missing retained tab returns typed `409 retained_conversation_unavailable`. Ready retained tabs are bounded by TTL and can be evicted before rejecting a sixth task surface. Ordinary retained continuity and structured compaction both use the same physical ownership model; the latter cannot start its retained handoff until the prior helper has physically settled, and cannot release its own compaction owner until the handoff helper has settled.

## U5-W3 — Capability delta

Status: **IMPLEMENTATION COMPLETE — LUNA-ONLY LIVE GATE PENDING**.

- Ported Luna Think mode (`09877fa`) as a second Luna-only native Codex route, `chatgpt-web/think`.
  It keeps the `gpt-5.6-luna` backend, maps the adapter effort to `medium`, and toggles the one visible
  semantic `Think` button by `aria-pressed`. Normal Luna explicitly clears Think. Missing or ambiguous
  Think controls fail closed instead of silently changing the requested mode.
- Preserved `Codex Native3` ABI and AsterBridge's image-generation provider abstraction. Free/Go
  catalog publication now exposes both Luna and Think; DEV chat, provider reasoning efforts, and
  `/v1/models` use the same route source of truth.
- Removed the old Pro-only prompt clause that prohibited delegation, so Pro now keeps the same native
  Codex subagent contract as Extra High. Existing Compatibility V1 / Native configuration and the
  bounded 10-second `wait_agent` polling remain unchanged.
- Backported the interrupted-turn boundary: a synthetic `<turn_aborted>` record stays historical
  context and cannot become the next turn's user revision, while a real foreign-turn steering message
  still fails closed.
- Wired the already-existing bridge stall watchdog end-to-end as one optional config value:
  `AppConfig.stallTimeoutSec` -> provider config -> server -> Responses bridge. `--stall-timeout-sec N`
  is an explicit setup override; unset behavior remains the existing 300-second default.
- Native mode preserves current Codex agent-version metadata for native Codex surfaces, but a real
  Codex 0.153.4 V2 parent -> ChatGPT Web child probe confirmed that the delegated child task itself is
  carried as opaque `encrypted_content`. A browser backend cannot decrypt that cross-backend payload.
  AsterBridge therefore keeps this path fail-closed before browser execution instead of replacing the
  task with `[encrypted content omitted]` or adding rollout JSONL/SQLite as a second authority source.
  Compatibility V1 remains the supported Web-subagent path.
- The connectorless Responses fallback also received one live-gate repair discovered by that work:
  a valid private tool envelope can be preserved exactly in the completed raw DOM while ChatGPT's
  Markdown serializer escapes protocol punctuation in the streaming view. The raw completed envelope
  is now authoritative only after it validates against the exact current binding and advertised tool
  registry; ordinary prose still requires exact completed/streamed equality. Deferred V1 tools remain
  discovered with the current turn's `tool_search` and then invoked by their newly advertised wire name.
- Real isolated Windows/Roxy 3.0.43 validation on `127.0.0.1:17842` passed the supported Web-subagent
  chain end to end through the Responses fallback: parent `tool_search` exposed the deferred V1 tools,
  outer Codex executed `spawn_agent`, a separate `chatgpt-web/light` child browser turn returned
  `CHILD_AGENT_OK`, the parent used bounded `wait_agent`, then `close_agent`, and finished with
  `SUBAGENT_E2E_OK`. One transient missing-response-DOM retry was recovered by the existing browser
  recovery path; the E2E process exited 0 with real child-session evidence.
- Current code gates cover Luna/Think route selection, semantic Think toggling, Pro delegation,
  interrupted-turn revision isolation, configurable streaming stall timeout, V1 Web-subagent
  delegation, the Responses direct-tool boundary, and Native V2 encrypted-payload fail-closed behavior.
  Final local validation passes the focused U5-W3/direct-tool gate at **124 pass / 0 fail**, Core at
  **44 / 44 deterministic batches**, Launcher at **227 pass / 0 fail / 2 expected platform skips**,
  plus root TypeScript, version/docs contracts, `git diff --check`, Launcher TypeScript, and the
  production renderer build. A real Luna-only browser gate is still
  required before U5-W3 can be marked DONE; the current Windows production account probes as
  `Sol=true`, so it cannot expose the Luna-only Think control for an honest live test.

## Documentation rule

For every completed upstream-v5 item:

1. update this file's status and validation evidence;
2. update `CHANGELOG.md` for the release that contains the behavior;
3. update user-facing README/docs only when the visible product contract changes;
4. never mark a live browser/compact behavior complete based only on unit tests — require the relevant
   Windows/RoxyBrowser production-style E2E.
