import { readJsonRequestBody } from "./http-body";
import { nativeUpstreamFetch } from "./native-upstream-fetch";
import {
  BRIDGE_COMPACTION_PREFIX,
  decodeCompactionSummary,
  SUMMARY_PREFIX,
} from "./responses/compaction";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeFetch = (request: Request) => Promise<Response>;
export type NativeCodexEndpoint =
  | "models"
  | "responses"
  | "responses/compact"
  | "alpha/search"
  | "images/generations"
  | "images/edits";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeReasoningItem(value: unknown): value is JsonObject {
  if (!isObject(value) || value.type !== "reasoning") return false;
  const encrypted = value.encrypted_content;
  if (typeof encrypted === "string" && encrypted.startsWith(BRIDGE_REASONING_PREFIX)) return true;
  return typeof value.id === "string"
    && /^rs_[0-9a-f]{32}$/i.test(value.id)
    && (encrypted === undefined || encrypted === null)
    && (Array.isArray(value.summary) || Array.isArray(value.content));
}

function isBridgeCompactionItem(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type !== "compaction" && value.type !== "compaction_summary" && value.type !== "context_compaction") {
    return false;
  }
  return typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(BRIDGE_COMPACTION_PREFIX);
}

function bridgeCompactionReplayMessage(item: JsonObject): JsonObject {
  const encrypted = item.encrypted_content as string;
  const summary = decodeCompactionSummary(encrypted);
  if (summary === null) {
    throw new Error("Managed Web compaction history is malformed and cannot be replayed to native Codex");
  }
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
  };
}

function hasNativeOpaqueEncryptedItem(value: JsonObject): boolean {
  if (value.type !== "reasoning"
    && value.type !== "compaction"
    && value.type !== "compaction_summary"
    && value.type !== "context_compaction") {
    return false;
  }
  const encrypted = value.encrypted_content;
  return typeof encrypted === "string"
    && !encrypted.startsWith(BRIDGE_REASONING_PREFIX)
    && !encrypted.startsWith(BRIDGE_COMPACTION_PREFIX);
}

/**
 * Response item ids are scoped to the backend that created them. A ChatGPT Web response is
 * generated locally, so replaying its `rs_*` id after switching back to native Codex makes the
 * official backend try to load an item it has never stored. Once a Web reasoning item proves that
 * the history crossed providers, send the complete item content without any provider-local ids.
 */
export function scrubBridgeArtifactsForNative(value: unknown): { value: unknown; changed: boolean } {
  if (!isObject(value) || !Array.isArray(value.input)) return { value, changed: false };
  const crossedProviders = value.input.some(item => isBridgeReasoningItem(item) || isBridgeCompactionItem(item));
  if (!crossedProviders) return { value, changed: false };

  const input = value.input.flatMap(item => {
    if (!isObject(item)) return [item];

    // AsterBridge's transparent Web compaction envelope is readable locally but is not an OpenAI
    // encrypted blob. Replay its summary as ordinary context before switching back to native Codex.
    if (isBridgeCompactionItem(item)) return [bridgeCompactionReplayMessage(item)];

    // Native encrypted reasoning/compaction belongs to the official backend. Preserve its opaque
    // blob and provider-owned item identity exactly; mutating either can invalidate verification.
    if (hasNativeOpaqueEncryptedItem(item)) return [item];

    const clean = { ...item };
    delete clean.id;
    if (clean.type !== "reasoning") return [clean];

    if (typeof clean.encrypted_content === "string"
      && clean.encrypted_content.startsWith(BRIDGE_REASONING_PREFIX)) {
      delete clean.encrypted_content;
    } else if (clean.encrypted_content === null) {
      delete clean.encrypted_content;
    }

    const hasSummary = Array.isArray(clean.summary) && clean.summary.length > 0;
    const hasContent = Array.isArray(clean.content) && clean.content.length > 0;
    const hasNativeEncryptedContent = typeof clean.encrypted_content === "string";
    return hasSummary || hasContent || hasNativeEncryptedContent ? [clean] : [];
  });
  const clean: JsonObject = { ...value, input };
  delete clean.previous_response_id;
  return { value: clean, changed: true };
}

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = nativeUpstreamFetch,
  decodedBody?: unknown,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  let body: BodyInit | undefined;
  if (method === "POST") {
    const shouldScrubResponsesBody = endpoint === "responses" || endpoint === "responses/compact";
    const parseRequest = shouldScrubResponsesBody && decodedBody === undefined ? request.clone() : undefined;
    const originalBody = await request.arrayBuffer();
    if (shouldScrubResponsesBody) {
      const scrubbed = scrubBridgeArtifactsForNative(
        decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody,
      );
      if (scrubbed.changed) {
        headers.delete("content-encoding");
        body = JSON.stringify(scrubbed.value);
      } else {
        body = originalBody;
      }
    } else {
      // Search and image-generation endpoints carry provider-owned request shapes. Forward their
      // bytes exactly instead of parsing/re-encoding them in the bridge; edits may evolve beyond
      // plain JSON without requiring another AsterBridge transport change.
      body = originalBody;
    }
  }
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  const upstream = await fetchUpstream(upstreamRequest);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: endToEndHeaders(upstream.headers),
  });
}
