# Changelog

All notable AsterBridge changes are documented here.

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
