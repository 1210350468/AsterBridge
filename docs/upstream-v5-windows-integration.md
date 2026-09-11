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

Status: **PLANNED**.

Audit v5.0.5/v5.0.6 deltas for Windows-relevant behavior only:

- pause / cancel / interrupt ownership (`codex-interrupt-hook`), especially cases where Codex stops
  while the retained ChatGPT page continues running;
- retained-page ownership, browser rebind, and helper cleanup;
- launcher restart / daemon drain / tunnel ownership;
- Codex config preservation when setup modifies managed keys;
- browser observation/rebind recovery that applies to RoxyBrowser/system-browser without importing
  upstream connector or Electron-only assumptions.

Gate: focused lifecycle tests plus a real RoxyBrowser long-turn cancel/restart E2E.

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
