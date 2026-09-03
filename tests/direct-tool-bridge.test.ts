import { expect, test } from "bun:test";
import {
  DIRECT_TOOL_BRIDGE_PREFIX,
  DIRECT_TOOL_BRIDGE_SUFFIX,
  directToolBridgeManifest,
  parseDirectToolBridgeResponse,
  selectDirectToolBridgeTransportText,
} from "../src/adapters/chatgpt-web/direct-tool-bridge";
import type { CodexParsedRequest } from "../src/types";

function request(): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/high",
    stream: true,
    context: {
      tools: [
        { name: "exec_command", description: "Run command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
        { name: "apply_patch", description: "Apply patch", parameters: {}, freeform: true },
        { name: "web_search", namespace: "mcp__search", description: "Search", parameters: { type: "object" } },
      ],
      messages: [{ role: "user", content: "Inspect it", timestamp: 1 }],
    },
    options: { reasoning: "high" },
  };
}

function envelope(binding: string, calls: unknown[]): string {
  return `${DIRECT_TOOL_BRIDGE_PREFIX}${JSON.stringify({ binding, calls })}${DIRECT_TOOL_BRIDGE_SUFFIX}`;
}

test("direct Responses tool bridge exposes only current-turn tool metadata", () => {
  expect(directToolBridgeManifest(request())).toEqual([
    expect.objectContaining({ wire_name: "exec_command", input_kind: "json_object" }),
    expect.objectContaining({ wire_name: "apply_patch", input_kind: "freeform_string" }),
    expect.objectContaining({ wire_name: "mcp__search__web_search", input_kind: "json_object" }),
  ]);
});

test("direct Responses tool bridge prefers the raw DOM envelope over Markdown serialization", () => {
  const raw = envelope("bind_raw", [
    { wire_name: "exec_command", arguments: { cmd: "Write-Output RAW_OK" } },
  ]);
  const markdown = raw.replaceAll("_", "\\_").replaceAll("[", "\\[").replaceAll("]", "\\]");
  expect(selectDirectToolBridgeTransportText(markdown, raw)).toBe(raw);
  expect(selectDirectToolBridgeTransportText("Normal **answer**", "Normal answer")).toBe("Normal **answer**");
});

test("direct Responses tool bridge repairs only protocol-owned Markdown escapes", () => {
  const parsed = request();
  const escapedSuffix = DIRECT_TOOL_BRIDGE_SUFFIX.replaceAll("_", "\\_");
  const raw = envelope("bind_escaped", [
    { wire_name: "exec_command", arguments: { cmd: "Write-Output OK" } },
  ]);
  const markdownEscaped = raw
    .replace(DIRECT_TOOL_BRIDGE_PREFIX, DIRECT_TOOL_BRIDGE_PREFIX.replaceAll("_", "\\_"))
    .replace(DIRECT_TOOL_BRIDGE_SUFFIX, escapedSuffix)
    .replace('"bind_escaped"', '"bind\\_escaped"')
    .replace('"wire_name"', '"wire\\_name"')
    .replace('"exec_command"', '"exec\\_command"')
    .replace('"calls":[', '"calls":\\[')
    .replace(`}]}${escapedSuffix}`, `}\\]}${escapedSuffix}`);
  expect(parseDirectToolBridgeResponse(markdownEscaped, parsed, "bind_escaped", "round_escape")).toEqual([
    expect.objectContaining({
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "Write-Output OK" },
    }),
  ]);
});

test("direct Responses tool bridge never rewrites literal escape sequences inside tool arguments", () => {
  const parsed = request();
  const escapedSuffix = DIRECT_TOOL_BRIDGE_SUFFIX.replaceAll("_", "\\_");
  const literal = String.raw`\[literal\]_value`;
  const raw = envelope("bind_literal", [
    { wire_name: "exec_command", arguments: { cmd: literal } },
  ]);
  const markdownEscaped = raw
    .replace(DIRECT_TOOL_BRIDGE_PREFIX, DIRECT_TOOL_BRIDGE_PREFIX.replaceAll("_", "\\_"))
    .replace(DIRECT_TOOL_BRIDGE_SUFFIX, escapedSuffix)
    .replace('"bind_literal"', '"bind\\_literal"')
    .replace('"wire_name"', '"wire\\_name"')
    .replace('"exec_command"', '"exec\\_command"')
    .replace('"calls":[', '"calls":\\[')
    .replace(`}]}${escapedSuffix}`, `}\\]}${escapedSuffix}`);
  const parsedCalls = parseDirectToolBridgeResponse(markdownEscaped, parsed, "bind_literal", "round_literal")!;
  expect(parsedCalls[0]).toMatchObject({ arguments: { cmd: literal } });
});

test("direct Responses tool bridge fails closed instead of guessing when Markdown mutates an argument value", () => {
  const parsed = request();
  const raw = envelope("bind_argument", [
    { wire_name: "exec_command", arguments: { cmd: "Write-Output VALUE_WITH_UNDERSCORES" } },
  ]);
  const unsafeMarkdown = raw.replaceAll("_", "\\_").replaceAll("[", "\\[").replaceAll("]", "\\]");
  expect(() => parseDirectToolBridgeResponse(unsafeMarkdown, parsed, "bind_argument", "round_argument"))
    .toThrow("invalid JSON");
});

test("direct Responses tool bridge parses advertised function and freeform calls with deterministic ids", () => {
  const parsed = request();
  const text = envelope("bind_1", [
    { wire_name: "exec_command", arguments: { cmd: "Write-Output OK" } },
    { wire_name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
  ]);
  const first = parseDirectToolBridgeResponse(text, parsed, "bind_1", "round_a")!;
  const replay = parseDirectToolBridgeResponse(text, parsed, "bind_1", "round_a")!;
  expect(first).toEqual(replay);
  expect(first[0]).toMatchObject({ wireName: "exec_command", freeform: false, arguments: { cmd: "Write-Output OK" } });
  expect(first[1]).toMatchObject({ wireName: "apply_patch", freeform: true, input: "*** Begin Patch\n*** End Patch" });
  expect(first[0]!.callId).toMatch(/^dtc_[a-f0-9]{24}$/);
});

test("direct Responses tool bridge fails closed on stale binding, unknown tools, malformed shapes, and mixed prose", () => {
  const parsed = request();
  expect(() => parseDirectToolBridgeResponse(
    envelope("stale", [{ wire_name: "exec_command", arguments: { cmd: "x" } }]),
    parsed,
    "current",
    "round",
  )).toThrow("invalid or stale binding");
  expect(() => parseDirectToolBridgeResponse(
    envelope("current", [{ wire_name: "not_advertised", arguments: {} }]),
    parsed,
    "current",
    "round",
  )).toThrow("did not advertise");
  expect(() => parseDirectToolBridgeResponse(
    envelope("current", [{ wire_name: "apply_patch", arguments: {} }]),
    parsed,
    "current",
    "round",
  )).toThrow("requires input and forbids arguments");
  expect(() => parseDirectToolBridgeResponse(
    `I will run it. ${envelope("current", [{ wire_name: "exec_command", arguments: { cmd: "x" } }])}`,
    parsed,
    "current",
    "round",
  )).toThrow("must be the entire final answer");
});

test("direct Responses tool bridge honors tool_choice and parallel_tool_calls", () => {
  const parsed = request();
  parsed.options.toolChoice = { allowedTools: ["exec_command"], mode: "required" };
  parsed.options.parallelToolCalls = false;
  expect(directToolBridgeManifest(parsed).map(tool => tool.wire_name)).toEqual(["exec_command"]);
  expect(() => parseDirectToolBridgeResponse(
    envelope("b", [
      { wire_name: "exec_command", arguments: { cmd: "one" } },
      { wire_name: "exec_command", arguments: { cmd: "two" } },
    ]),
    parsed,
    "b",
    "round",
  )).toThrow("disabled parallel tool calls");
});

test("normal model prose without a bridge marker remains a normal answer", () => {
  expect(parseDirectToolBridgeResponse("No tool is needed.", request(), "b", "round")).toBeUndefined();
});
