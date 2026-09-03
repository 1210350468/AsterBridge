import { createHash } from "node:crypto";
import { namespacedToolName, type CodexParsedRequest, type CodexTool, type CodexToolChoice } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";

export const DIRECT_TOOL_BRIDGE_PREFIX = "<asterbridge_tool_calls_v1>";
export const DIRECT_TOOL_BRIDGE_SUFFIX = "</asterbridge_tool_calls_v1>";

function markdownEscapedProtocolToken(value: string): string {
  return value.replaceAll("_", "\\_");
}

function markdownEscapedJsonString(value: string): string {
  return JSON.stringify(value).replaceAll("_", "\\_");
}

function normalizeMarkdownStructuralBrackets(text: string): string {
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === "\\" && (text[index + 1] === "[" || text[index + 1] === "]")) {
      normalized += text[index + 1];
      index += 1;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

export function selectDirectToolBridgeTransportText(markdown: string, visibleText: string): string {
  const raw = visibleText.trim();
  return raw.startsWith(DIRECT_TOOL_BRIDGE_PREFIX) && raw.endsWith(DIRECT_TOOL_BRIDGE_SUFFIX)
    ? raw
    : markdown;
}

interface DirectToolCallEnvelope {
  binding: string;
  calls: Array<{
    wire_name: string;
    arguments?: Record<string, unknown>;
    input?: string;
  }>;
}

function allowedToolNames(choice: CodexToolChoice | undefined, tools: readonly CodexTool[]): Set<string> {
  const all = new Set(tools.map(tool => namespacedToolName(tool.namespace, tool.name)));
  if (choice === "none") return new Set();
  if (!choice || choice === "auto" || choice === "required") return all;
  if ("name" in choice) return all.has(choice.name) ? new Set([choice.name]) : new Set();
  return new Set(choice.allowedTools.filter(name => all.has(name)));
}

export function directToolBridgeTools(parsed: CodexParsedRequest): CodexTool[] {
  const tools = parsed.context.tools ?? [];
  const allowed = allowedToolNames(parsed.options.toolChoice, tools);
  return tools.filter(tool => allowed.has(namespacedToolName(tool.namespace, tool.name)));
}

export function directToolBridgeManifest(parsed: CodexParsedRequest): Array<Record<string, unknown>> {
  return directToolBridgeTools(parsed).map(tool => ({
    wire_name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description,
    schema: tool.parameters,
    ...(tool.freeform ? { input_kind: "freeform_string" } : { input_kind: "json_object" }),
    ...(tool.strict === true ? { strict: true } : {}),
    ...(tool.toolSearch === true ? { tool_search: true } : {}),
  }));
}

export function directToolBridgePromptContract(parsed: CodexParsedRequest, binding: string): string[] {
  const manifest = directToolBridgeManifest(parsed);
  const required = parsed.options.toolChoice === "required"
    || (typeof parsed.options.toolChoice === "object" && "allowedTools" in parsed.options.toolChoice && parsed.options.toolChoice.mode === "required");
  return [
    "This turn uses AsterBridge's native Responses tool bridge instead of a ChatGPT custom MCP App. Outer Codex remains the only tool executor, approval authority, and sandbox owner.",
    `Available outer-Codex tools for this exact turn: ${JSON.stringify(manifest)}.`,
    "When fresh local work is required, do not pretend to have performed it and do not narrate a proposed command as if it ran. Request the required outer tool instead.",
    `A tool request must be the entire final answer, with no Markdown fence and no prose before or after it: ${DIRECT_TOOL_BRIDGE_PREFIX}{\"binding\":${JSON.stringify(binding)},\"calls\":[{\"wire_name\":\"TOOL\",\"arguments\":{}}]}${DIRECT_TOOL_BRIDGE_SUFFIX}`,
    "Emit that private envelope as raw transport text. Do not Markdown-escape underscores or any JSON character inside it.",
    "For input_kind=json_object, provide exactly one arguments object matching that tool schema. For input_kind=freeform_string, omit arguments and provide one input string instead.",
    parsed.options.parallelToolCalls === false
      ? "Request exactly one tool per bridge response."
      : "Independent tool calls may be requested together in calls; dependent calls must wait for earlier tool results.",
    "Use only wire_name values from the manifest. Never invent a tool, binding, call result, file observation, process result, or image artifact.",
    "After outer Codex executes the request, the next transport message will contain canonical tool_result data. Continue from that real result: request another tool with the same protocol when needed, otherwise return the normal user-facing answer without any bridge marker.",
    "The bridge envelope is private transport syntax. Never explain or quote it to the user unless the user explicitly asks how AsterBridge transports tool calls.",
    required
      ? "The current Codex tool_choice requires at least one tool call before a normal final answer."
      : "If the task is fully answerable from existing context, return a normal answer and do not emit a bridge envelope.",
  ];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deterministicCallId(namespace: string, index: number, call: DirectToolCallEnvelope["calls"][number]): string {
  const digest = createHash("sha256")
    .update(`${namespace}:${index}:${canonicalJson(call)}`)
    .digest("hex")
    .slice(0, 24);
  return `dtc_${digest}`;
}

export function parseDirectToolBridgeResponse(
  text: string,
  parsed: CodexParsedRequest,
  binding: string,
  callNamespace: string,
): BrokerToolRequest[] | undefined {
  const trimmed = text.trim();
  const markdownPrefix = markdownEscapedProtocolToken(DIRECT_TOOL_BRIDGE_PREFIX);
  const markdownSuffix = markdownEscapedProtocolToken(DIRECT_TOOL_BRIDGE_SUFFIX);
  const hasMarker = trimmed.includes(DIRECT_TOOL_BRIDGE_PREFIX)
    || trimmed.includes(DIRECT_TOOL_BRIDGE_SUFFIX)
    || trimmed.includes(markdownPrefix)
    || trimmed.includes(markdownSuffix);
  if (!hasMarker) return undefined;
  const markdownEscapedEnvelope = trimmed.startsWith(markdownPrefix) && trimmed.endsWith(markdownSuffix);
  // Browser Worker normally passes the assistant DOM's raw visible text for private tool envelopes,
  // so renderer repair is only a compatibility fallback. When needed, repair protocol-owned strings
  // only: the boundary markers, the `wire_name` key, this turn's exact binding, and currently
  // advertised tool names. Structural brackets are repaired only outside JSON strings. Arbitrary
  // argument values are never unescaped; ambiguous renderer mutations therefore fail closed instead
  // of silently changing a command, regex, path, or freeform payload.
  let normalized = trimmed;
  if (markdownEscapedEnvelope) {
    normalized = normalized
      .replace(markdownPrefix, DIRECT_TOOL_BRIDGE_PREFIX)
      .replace(markdownSuffix, DIRECT_TOOL_BRIDGE_SUFFIX)
      .replaceAll('"wire\\_name"', '"wire_name"')
      .replaceAll(markdownEscapedJsonString(binding), JSON.stringify(binding));
    for (const tool of directToolBridgeTools(parsed)) {
      const wireName = namespacedToolName(tool.namespace, tool.name);
      normalized = normalized.replaceAll(
        markdownEscapedJsonString(wireName),
        JSON.stringify(wireName),
      );
    }
    normalized = normalizeMarkdownStructuralBrackets(normalized);
  }
  if (!normalized.startsWith(DIRECT_TOOL_BRIDGE_PREFIX) || !normalized.endsWith(DIRECT_TOOL_BRIDGE_SUFFIX)) {
    throw new Error("ChatGPT direct tool bridge marker must be the entire final answer");
  }
  const json = normalized.slice(DIRECT_TOOL_BRIDGE_PREFIX.length, -DIRECT_TOOL_BRIDGE_SUFFIX.length).trim();
  let envelope: DirectToolCallEnvelope;
  try {
    envelope = JSON.parse(json) as DirectToolCallEnvelope;
  } catch {
    throw new Error("ChatGPT direct tool bridge returned invalid JSON");
  }
  if (!envelope || typeof envelope !== "object" || envelope.binding !== binding || !Array.isArray(envelope.calls)) {
    throw new Error("ChatGPT direct tool bridge returned an invalid or stale binding");
  }
  if (envelope.calls.length === 0) throw new Error("ChatGPT direct tool bridge returned an empty tool batch");
  if (parsed.options.parallelToolCalls === false && envelope.calls.length !== 1) {
    throw new Error("ChatGPT direct tool bridge requested parallel tools when Codex disabled parallel tool calls");
  }
  const tools = new Map(directToolBridgeTools(parsed).map(tool => [namespacedToolName(tool.namespace, tool.name), tool]));
  return envelope.calls.map((call, index) => {
    if (!call || typeof call !== "object" || typeof call.wire_name !== "string" || !call.wire_name.trim()) {
      throw new Error("ChatGPT direct tool bridge returned a tool call without wire_name");
    }
    const tool = tools.get(call.wire_name);
    if (!tool) throw new Error(`ChatGPT direct tool bridge requested a tool that the active Codex round did not advertise: ${call.wire_name}`);
    if (tool.freeform) {
      if (typeof call.input !== "string" || call.arguments !== undefined) {
        throw new Error(`ChatGPT direct tool bridge freeform call ${call.wire_name} requires input and forbids arguments`);
      }
      return {
        callId: deterministicCallId(callNamespace, index, call),
        wireName: call.wire_name,
        freeform: true,
        input: call.input,
      };
    }
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) || call.input !== undefined) {
      throw new Error(`ChatGPT direct tool bridge function call ${call.wire_name} requires one arguments object and forbids input`);
    }
    return {
      callId: deterministicCallId(callNamespace, index, call),
      wireName: call.wire_name,
      freeform: false,
      arguments: call.arguments,
    };
  });
}
