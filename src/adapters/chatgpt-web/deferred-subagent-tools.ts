export const CODEX_SUBAGENT_WAIT_WIRE_NAME = "multi_agent_v1__wait_agent";

export const CODEX_DEFERRED_SUBAGENT_WIRE_NAMES = new Set([
  "multi_agent_v1__spawn_agent",
  "multi_agent_v1__send_input",
  "multi_agent_v1__resume_agent",
  CODEX_SUBAGENT_WAIT_WIRE_NAME,
  "multi_agent_v1__close_agent",
]);

export function isDeferredSubagentWireName(value: string): boolean {
  return CODEX_DEFERRED_SUBAGENT_WIRE_NAMES.has(value);
}
