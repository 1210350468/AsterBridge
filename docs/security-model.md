# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the selected browser profile/session, the selected ChatGPT workspace, and—when Full Harness is enabled—the configured OpenAI Tunnel/custom MCP connector. Repository contents, tool output, websites, and prompt text are untrusted data.

## Full-mode capability flow

1. The daemon accepts a Codex Responses turn on `127.0.0.1`.
2. It extracts `cwd`, workspace roots, sandbox policy, and the tool registry only from the native
   Codex wire envelope with matching turn metadata. A user-authored `<environment_context>` is not
   accepted as authority.
3. In primary MCP Full, a turn-scoped capability is claimed through the private broker and `Codex Native3` connector. The derived binding remains private to the local bridge, and ChatGPT can continue requesting tools within the same response.
4. In the experimental Responses fallback, AsterBridge creates a private turn binding and includes only the current turn's advertised tool names/schemas in the ChatGPT prompt. The Browser Worker prefers the assistant DOM's raw private envelope; AsterBridge validates binding, tool membership, argument shape, and parallel-call policy before returning a normal Responses tool call to outer Codex.
5. Both transports can request only tools advertised by the active outer Codex turn. Codex remains responsible for sandbox, approval, UI, command sessions, execution, and tool results. All turn capabilities are revoked on completion, abort, or retirement.

The bridge transports decisions; it does not add a second planner, semantic router, tool executor, or fallback model. Missing bindings/tools/transport capability fail explicitly. MCP is the default Full Harness transport; the Responses fallback requires explicit opt-in and is never selected as an automatic migration.

The current MCP schema is attached only through the `Codex Native3` connector identity. The retired `Codex Native` and `Codex Native2` identities are not reused because ChatGPT can cache MCP contracts by App identity.
The pre-v4 `Codex Native` connector is treated as legacy and is never selected as a fallback. This
prevents a cached legacy schema from being mistaken for the current capability contract.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions. Full mode
can invoke write and command tools. Use a trusted workspace, keep Codex sandbox/approval settings
appropriate. In MCP Full, grant only intended connector actions; outer Codex still owns the actual sandbox and approval decision. In the experimental Responses fallback, AsterBridge never executes the requested tool itself. Automatic per-call approval is off by default.

### Browser session theft

The launcher's persistent Electron partition can authorize ChatGPT access. It remains in the
current OS user's private application-data directory and is never copied into a daemon prompt or
runtime descriptor. Never sync, upload, attach, or commit it. On suspected exposure, sign out or
revoke the ChatGPT session from the launcher.

### Tunnel credential theft

This risk applies to the primary MCP Full transport. The runtime key needs only Tunnels Read + Use. It is accepted through a hidden prompt or copied from a file, stored with user-only permissions, referenced by file, and never placed in a command argument or generated profile. Rotate it after suspected exposure.

### Same-user local process

The Responses endpoint is loopback-only, but it has no independent bearer secret because the
built-in Codex OpenAI provider cannot be configured with a bridge-specific credential while
preserving the native provider/task identity. Another process under the same OS user can reach the
port. Run on a trusted single-user account and treat local code execution as inside the trust
boundary.

The lifecycle endpoints are separate from the Responses surface. `/admin/drain`, `/admin/resume`,
`/admin/cancel-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow and completion requires stable completed-turn evidence. For private Responses tool envelopes, raw assistant DOM text is preferred over Markdown serialization. The compatibility fallback repairs only protocol-owned markers/binding/tool names and structural brackets outside JSON strings; it never rewrites arbitrary tool argument values. Ambiguous mutation fails closed. UI drift never chooses another model/transport or returns fabricated tool success.

### Login-state isolation

The launcher keeps ChatGPT login, identity-provider navigation, and model turns in one private
Electron partition. Allowed login popups are adopted into an in-launcher `WebContentsView` that
shares that partition; unrelated external links remain outside it. A visible composer alone is not
authentication evidence: the launcher also requires a valid server session and an exact Temporary
Chat URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

Browser turns use at most five independent task-bound surfaces in one private login partition. A
Codex task/compaction epoch owns one Temporary Chat document; compatible sequential turns may reuse
that same retained document, but pages are never shared across different tasks. Retained pages
expire, are LRU-evicted only while idle, and are retired when a successful compaction hands the
thread to a new epoch. Closing a running task surface destroys its page and terminates that turn.
The five-surface limit bounds parallel account traffic, and maintenance probes cannot bypass it.
Tool calls remain in the same ChatGPT response.

For routed compaction, AsterBridge may install the replacement-history shape required by Codex, but
only after a dedicated read-only summarization turn. AsterBridge-owned `ocx1:` / `ocxr1:` envelopes
are transparent local formats and are decoded before crossing back to a native provider. Genuine
OpenAI encrypted reasoning or compaction remains opaque and preserves its provider-owned identity
and ciphertext unchanged. The v1 retained-history planner also reserves stable harness and
post-compaction headroom so history reduction cannot immediately recreate a context overflow.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Primary MCP Full uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound firewall rule.
- The experimental Responses fallback adds no public listener or Tunnel; tool calls return through the same loopback Responses request to outer Codex.
- The embedded browser connects to ChatGPT, the selected identity provider during explicit sign-in,
  and user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
