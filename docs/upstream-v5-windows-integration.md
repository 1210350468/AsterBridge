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

Status: **IN PROGRESS**.

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

Implemented locally for **3.0.40 WIP** — deterministic retained compaction at the daemon/session boundary:

- Active compaction no longer mutates an already-owned canonical tool result into a same-response checkpoint request. Canonical results are delivered unchanged; only a later, not-yet-executed tool request may receive the stop instruction.
- The checkpoint now comes from exactly one dedicated structured retained-conversation handoff. The old browser-visible-text fallback is removed; missing structured submission fails closed under the bounded handoff deadline.
- The handoff deadline spans transaction acquisition, structured submission, browser shutdown, and token cleanup. Exact duplicate compaction executions share one in-flight/result promise; failures are evicted so retries are not poisoned by a stale rejected cache entry.
- Retained-conversation retirement can detach the browser epoch while preserving a terminal ordinary final response under the compacted source execution key, avoiding unnecessary regeneration when the ordinary response wins the race before any compaction instruction is delivered.
- Focused validation currently passes TypeScript plus retained-compaction/lifecycle **16 pass / 0 fail / 8 existing skips**.

Still pending in U5-W2:

- helper/Launcher-level physical-settlement ownership and progress forwarding from the later `a3a5083` evolution; the current 3.0.40 WIP intentionally stops at the daemon/session boundary rather than importing that broader helper rewrite;
- browser observation/rebind and Launcher lifecycle deltas from v5.0.5/v5.0.6 that remain applicable to RoxyBrowser/system-browser;
- final audit of managed Codex config preservation across launcher update/reconnect transactions.

Gate: the exact Interrupt slice has passed focused tests and the Windows/RoxyBrowser long-turn E2E. Keep U5-W2 **IN PROGRESS** until the retained physical-settlement, browser rebind, Launcher lifecycle, and config-preservation deltas are separately audited and validated.

## U5-W3 — Capability delta

Status: **PLANNED**.

- Luna Think mode (`09877fa`) is worth porting because AsterBridge already supports Luna but not the
  Think toggle used by Free/Go accounts.
- Audit the v5 Compatibility V1 / Native subagent hardening. AsterBridge already owns reversible
  `multi_agent` / `multi_agent_v2` configuration and 10-second `wait_agent` polling, so only missing
  protocol-boundary protections should be added.
- Preserve `Codex Native3` ABI and AsterBridge's current image-generation provider abstraction.

## Documentation rule

For every completed upstream-v5 item:

1. update this file's status and validation evidence;
2. update `CHANGELOG.md` for the release that contains the behavior;
3. update user-facing README/docs only when the visible product contract changes;
4. never mark a live browser/compact behavior complete based only on unit tests — require the relevant
   Windows/RoxyBrowser production-style E2E.
