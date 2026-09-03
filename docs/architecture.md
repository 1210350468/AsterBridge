# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound browser surfaces)
  └─ full-mode tool transport
       ├─ MCP (primary): broker + stdio MCP server → outbound Tunnel → custom ChatGPT App
       └─ Responses bridge (experimental opt-in): validated tool intent → outer Codex
```

## Modes

### `browser-only`

- Exposes Instant (`chatgpt-web/light`), Medium, High, and Extra High; each model advertises exactly one
  immutable Codex effort matching its ChatGPT browser mode. `chatgpt-web/pro` is appended only when
  the authenticated account exposes Pro.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

Full mode has two transports with the same authority boundary: ChatGPT proposes tool use; outer Codex remains the only approval, sandbox, and execution authority.

- **MCP (primary)** uses a custom MCP connector backed by `openai/tunnel-client`. The broker keeps its derived binding private and the stdio MCP server accepts only tools advertised by the active outer Codex turn. MCP is the stable Full Harness path because ChatGPT can remain inside one response while performing a multi-step tool loop.
- **Responses (experimental opt-in)** requires no Tunnel or custom ChatGPT App, but each dependent tool step can require an additional Web generation. It exists only as a connectorless fallback and is never selected automatically. The prompt contains only the current turn's advertised tool metadata plus a private turn binding; AsterBridge validates the request before returning a normal Responses tool call to outer Codex.
- Renderer compatibility for the experimental Responses path is fail-closed: raw DOM text is preferred for private envelopes; fallback Markdown repair touches only protocol-owned markers, binding, tool names, and structural brackets outside JSON strings. Arbitrary tool argument values are never unescaped or rewritten.

### Repository DEV driver

The DEV chat is not another provider or browser implementation. It is a synthetic outer-Codex
driver around the same in-process Responses handlers. `dev launcher` starts the packaged launcher
with an explicit `development` profile. That profile has a different core home, sandboxed
`CODEX_HOME`, Electron `userData`, persistent browser partition, descriptor, cookie jar, login,
configuration, chat store, diagnostic store, broker path, tunnel profile, and alias. The normal and
DEV launchers can therefore run at the same time with different ChatGPT accounts.

The working-tree adapter attaches to a tab leased only from that DEV launcher. In Full mode the DEV
launcher owns one persistent, isolated tunnel runtime; a named CLI chat owns only the private turn
broker attached to that tunnel for the command's lifetime. The distinct `Codex Native3 DEV`
connector reaches the same MCP server and turn-token contract without requiring any Responses
daemon or colliding with the production `Codex Native3` connector.

Only the responsibilities normally owned by native Codex are synthetic: named history storage,
turn metadata, tool-result execution, context-threshold scheduling, and installation of compacted
replacement history. Every tool result is an explicit `simulated: true` receipt with
`side_effects_performed: false`; no semantic router guesses a command result.

The driver calls `responseRequest` and `compactRequest` directly. It starts no HTTP server, does not
read or write Codex's route journal or `config.toml`, and does not stop or replace the normal
launcher-owned daemon. A `dev-harness` discriminator prevents the Responses server and production
launcher from starting a Responses daemon for its config. DEV setup stores browser capabilities
and tunnel credentials but performs no Codex integration, system service installation, or port
probe. The DEV launcher supervisor owns only the isolated MCP tunnel. Browser diagnostics, broker
state, thread authority, checkpoints, and named chat state live
under `~/.codex-chatgpt-web-dev` by default.

The ChatGPT connector name is also the public MCP ABI identity. The current direct turn-token contract uses
`Codex Native3`; the retired `Codex Native` and `Codex Native2` identities are never selected or refreshed in place. Setup
migrates known legacy local configuration to the new name, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only a legacy identity is visible, and never falls back to
an old connector. Future public schema changes require another explicit connector identity.
Repository DEV mode uses `Codex Native3 DEV` so the same ChatGPT account can keep both production
and development connectors installed without renaming, refreshing, or deleting either one.

## Browser lifecycle

The Responses adapter has three browser hosts behind one Browser Worker contract:

- **Embedded Launcher browser** owns a persistent Electron partition. Each active Codex turn is leased an independent `WebContentsView`/surface ID through a launcher-owned loopback control channel.
- **RoxyBrowser** connects only to the configured Profile's own Chromium `DevToolsActivePort`. A closed Profile can be opened through the loopback Roxy Local API when auto-start is configured; cookies/profile data are never copied into Electron.
- **System Chrome/Edge** is an experimental external host discovered from an already enabled main-browser remote-debugging endpoint.

A new Codex conversation/compaction epoch opens a fresh Temporary Chat page. Compatible sequential turns in the same thread/model/effort/epoch may retain and reuse that task page, sending only the canonical suffix after the last assistant reply. Retained pages expire, can be LRU-evicted when idle, and are retired exactly once when compaction hands the thread to a new epoch. Failed/aborted non-retained turns and maintenance probes close their owned surfaces. At most five physical ChatGPT task surfaces exist at once; a sixth genuinely active turn fails explicitly, while a new idle conversation may evict the least-recently-used retained page instead of exceeding the account-safety ceiling.

Embedded turns expose their native `WebContentsView` directly in Launcher. Roxy turns remain owned by the Browser Worker and publish a bounded low-rate JPEG/status preview over the authenticated loopback launcher control channel. **Take control** is queued to the exact turn owner; that Worker restores/activates the matching Roxy task window instead of Launcher establishing a second CDP controller. This preserves one automation owner per page even with concurrent turns.

Embedded sign-in uses the persistent Electron partition. ChatGPT login pages and allowed identity-provider popups are adopted into a temporary `WebContentsView` inside Launcher. Roxy/system-browser sign-in remains owned by the selected external browser profile. The project does not perform browser-profile handoff, cookie import/export, or temporary session-transfer directories between hosts.

The current compiled Codex task context is inserted as one inline JSON envelope. Image bytes stay
out of the JSON and are attached natively with stable references. The runtime does not create a
context JSONL file, upload a synthetic context document, include prompt hashes, or silently truncate
the envelope. Attachment acceptance and send readiness are verified before the turn begins.

The appended models advertise the authenticated account's measured context window and explicit
`auto_compact_token_limit`. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.

Routed compaction v1/v2 runs as a dedicated read-only browser summarization turn with no broker or
local tools. AsterBridge wraps Web-generated summaries in its transparent `ocx1:` envelope for the
v2 contract and returns Codex's expected replacement-history shape for v1. The v1 retained-history
budget is model-aware: it starts from the routed model's real automatic-compaction gate, reserves
the stable Codex/system/skills/plugins/tool overhead, the actual summary, structure allowance, and
post-compaction headroom, then permits only the remaining recent user text/images up to Codex's
20k historical ceiling. This prevents a successful compact from immediately exceeding the same
window after Codex re-injects its stable harness. When a thread later switches back to a native
OpenAI model, AsterBridge decodes only its own `ocx1:` / `ocxr1:` envelopes to readable context;
genuine provider-owned OpenAI encrypted reasoning/compaction items retain their original ids and
`encrypted_content` unchanged.

A prompt-level checkpoint marker is translated into a visible Codex trace item; every later tool
action in the same turn continues to present the current turn capability. Visible ChatGPT status
rows become reasoning summaries, while stable prose between rows becomes native Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no installed Chrome/Chromium or system Node/Bun;
sign-in and model turns both remain in Electron. Full mode separately downloads the official pinned
`openai/tunnel-client` build for the current OS/architecture and verifies it against the release
SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup keeps Codex's built-in `openai` provider and transactionally owns both `openai_base_url` and
an AsterBridge-generated `model_catalog_json` while the bridge is active. The managed catalog is
built from the user's existing catalog, Codex model cache, or bundled Codex catalog, preserves every
native model, and appends only the account-available `chatgpt-web/` routes with their exact context,
auto-compaction, reasoning, and compatibility metadata. The user's original catalog assignment is
never modified in place and is restored byte-for-byte on disconnect/uninstall; the managed copy is
hash-verified and fails closed if externally changed. While the integration is active, native models
that support delegation and routed Web models share Codex's readable V1 collaboration surface so an
explicitly selected Web subagent receives plaintext task content. An explicit native `disabled`
delegation capability is preserved. For Codex 0.150 automatic compaction, the active v9 route also
transactionally owns `[features].remote_compaction_v2 = false`: remote compaction remains enabled
but uses `/responses/compact` v1, where AsterBridge can bound replacement history to the selected
Web model's window. Disconnect/uninstall restores the user's prior feature assignment and table
placement byte-for-byte; an external edit while the route is active fails closed. Model choice,
effort, context, and service tiers are otherwise unchanged.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
