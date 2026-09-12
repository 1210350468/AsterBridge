import { createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import { extractChatGptTurnIdentity } from "./adapters/chatgpt-web/environment";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import { readCodexModelContextOverride, type CodexModelContextOverride } from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import { forwardNativeCodexRequest, type NativeFetch } from "./native-passthrough";
import {
  buildCompactV1Output,
  buildNativeCompactV1Output,
  COMPACT_PROMPT,
  COMPACT_V1_MAX_RETAINED_HISTORY_TOKENS,
  decodeCompactionSummary,
  extractCompactUserMessages,
  planCompactV1Budget,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";

interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): { cancelled: number; settlement: Promise<void> } {
    this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
  ): Promise<Response> {
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = identity;
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: avoid an async pull(), but do not tee the response. A tee
      // keeps the underlying stream alive until both branches are cancelled, so a Codex-side stop
      // can cancel its branch while the lifecycle observer silently keeps the ChatGPT browser turn
      // running. A push-driven single-branch wrapper preserves the Windows workaround and gives the
      // client branch direct ownership of cancellation again.
      const reader = response.body.getReader();
      let closed = false;
      streamAbortListener = () => {
        closed = true;
        void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            try {
              while (!closed) {
                // Keep at most one upstream chunk in hand. Reading before waiting on downstream
                // capacity lets us observe EOF/release lifecycle ownership immediately after the
                // final chunk, instead of leaving a short completed response counted as active.
                const chunk = await reader.read();
                if (chunk.done) {
                  closed = true;
                  release();
                  try { controller.close(); } catch { /* client already cancelled */ }
                  return;
                }
                while (!closed && (controller.desiredSize ?? 1) <= 0) {
                  await new Promise<void>(resolve => setTimeout(resolve, 5));
                }
                if (closed) return;
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              if (closed) return;
              closed = true;
              release();
              try { controller.error(error); } catch { /* client already cancelled */ }
            }
          })();
        },
        cancel(reason) {
          closed = true;
          if (!abort.signal.aborted) {
            abort.abort(reason ?? new Error("Client response stream cancelled"));
          } else {
            void reader.cancel(reason).catch(() => {}).finally(release);
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the trusted native Codex turn identity to the owning HTTP lifecycle. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config);
  parsed.modelId = route.backendModel;
  // A Pro task remains Pro, but its isolated summarization turn does not benefit from Pro's much
  // slower reasoning. Extra High has the same 95k pre-compaction budget on a Pro account, so it
  // can summarize the complete bounded input without changing the task's selected model.
  parsed.options.reasoning = parsed._compactionRequest && route.adapterEffort === "max"
    ? "xhigh"
    : route.adapterEffort;
  return route;
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) return upstream;
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export const RETRYABLE_IMAGE_UPSTREAM_STATUSES = new Set([502, 503, 504]);

export function imageUpstreamRetryable(status: number): boolean {
  return RETRYABLE_IMAGE_UPSTREAM_STATUSES.has(status);
}

function imageTransportErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || error.name;
  }
  return error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "Error";
}

export async function nativeImageRequest(
  req: Request,
  endpoint: "images/generations" | "images/edits",
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await forwardNativeCodexRequest(req, endpoint, fetchUpstream);
    const durationMs = Date.now() - startedAt;
    const retryable = imageUpstreamRetryable(response.status);
    console.info(
      `[asterbridge:image] endpoint=${endpoint} durationMs=${durationMs} status=${response.status} origin=upstream retryable=${String(retryable)}`,
    );
    return response;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = imageTransportErrorCode(error);
    const retryable = !(error instanceof DOMException && error.name === "AbortError");
    console.error(
      `[asterbridge:image] endpoint=${endpoint} durationMs=${durationMs} status=502 origin=transport retryable=${String(retryable)} error=${errorCode}`,
    );
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
    route = routeChatGptWebRequest(parsed, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  if (compaction && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = adapterFactory(providerConfig(config));
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
        options.onAdapterEvent?.(event);
        queue.push(event);
      });
    } catch (error) {
      const event: AdapterEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
      options.onAdapterEvent?.(event);
      queue.push(event);
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(compaction ? { compaction: true } : {
          ...(options.rememberState === false ? {} : {
            onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, { force: true }),
          }),
        }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  if (!compaction && options.rememberState !== false) {
    rememberResponseState(parsed._rawBody, json, { force: true });
  }
  return Response.json(json);
}

function nativeCompactionItem(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ((value as { type?: unknown }).type === "compaction"
      || (value as { type?: unknown }).type === "context_compaction"));
}

async function collectNativeV2CompactionItem(response: Response): Promise<Record<string, unknown>> {
  // This helper is called only for a synthesized `stream:true` Responses compaction request.
  // Do not infer transport from Content-Type: the authenticated Codex backend can return an SSE
  // body through intermediaries that normalize or omit that header. The current Codex client also
  // consumes this operation as an event stream unconditionally.
  if (!response.body) throw new Error("Native compaction v2 fallback returned an empty event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const completedItems: Record<string, unknown>[] = [];
  let buffer = "";

  const handleFrame = (frame: string): Record<string, unknown> | null => {
    if (!frame.trim()) return null;
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return null;
    let event: Record<string, unknown>;
    try {
      const decoded = JSON.parse(data);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
      event = decoded as Record<string, unknown>;
    } catch {
      return null;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.output_item.done" && nativeCompactionItem(event.item)) {
      completedItems.push(event.item);
      return null;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      const terminal = event.response;
      const status = terminal && typeof terminal === "object" && !Array.isArray(terminal)
        ? (terminal as { status?: unknown }).status
        : undefined;
      throw new Error(`Native compaction v2 fallback terminated as ${status ? String(status) : type}`);
    }
    if (type !== "response.completed") return null;
    if (completedItems.length === 0) {
      const completed = event.response;
      if (completed && typeof completed === "object" && !Array.isArray(completed)) {
        const output = (completed as { output?: unknown }).output;
        if (Array.isArray(output)) completedItems.push(...output.filter(nativeCompactionItem));
      }
    }
    if (completedItems.length !== 1) {
      throw new Error(`Native compaction v2 fallback produced ${completedItems.length} compaction items; expected one`);
    }
    return completedItems[0]!;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      if (done) buffer += decoder.decode();
      while (true) {
        const lf = buffer.indexOf("\n\n");
        const crlf = buffer.indexOf("\r\n\r\n");
        const positions = [lf, crlf].filter(index => index >= 0);
        if (positions.length === 0) break;
        const boundary = Math.min(...positions);
        const separatorLength = boundary === crlf ? 4 : 2;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        const item = handleFrame(frame);
        if (item) {
          try { await reader.cancel(); } catch { /* terminal event already received */ }
          return item;
        }
      }
      if (done) {
        const trailing = handleFrame(buffer);
        if (trailing) return trailing;
        throw new Error("Native compaction v2 fallback stream ended before response.completed");
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function compactNativeViaModernResponses(
  req: Request,
  raw: Record<string, unknown>,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const input = Array.isArray(raw.input) ? raw.input : [];
  const modernBody: Record<string, unknown> = {
    model: raw.model,
    input: [...input, { type: "compaction_trigger" }],
    tool_choice: "auto",
    parallel_tool_calls: raw.parallel_tool_calls === true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  for (const key of [
    "tools",
    "instructions",
    "reasoning",
    "service_tier",
    "prompt_cache_key",
    "text",
    "client_metadata",
    "access_programs",
    "stream_options",
  ]) {
    if (raw[key] !== undefined) modernBody[key] = raw[key];
  }

  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.delete("content-encoding");
  headers.delete("content-length");
  const modernRequest = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(modernBody),
    signal: req.signal,
  });
  console.error("[asterbridge:native-compaction] forwarding legacy compact as responses compaction_trigger");
  const modern = await forwardNativeCodexRequest(
    modernRequest,
    "responses",
    fetchUpstream,
    modernBody,
  );
  if (!modern.ok) {
    const message = await modelCatalogFailureMessage(modern);
    console.error(`[asterbridge:native-compaction] modern fallback failed status=${modern.status} message=${JSON.stringify((message ?? "unknown").slice(0, 500))}`);
    return modern;
  }

  let compactionItem: Record<string, unknown>;
  try {
    compactionItem = await collectNativeV2CompactionItem(modern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[asterbridge:native-compaction] modern stream rejected message=${JSON.stringify(message.slice(0, 500))}`);
    return formatErrorResponse(
      502,
      "invalid_response_error",
      message,
    );
  }
  const output = buildNativeCompactV1Output(
    extractCompactUserMessages(input),
    compactionItem,
    { retainedHistoryTokenBudget: COMPACT_V1_MAX_RETAINED_HISTORY_TOKENS },
  );
  console.error(`[asterbridge:native-compaction] modern fallback PASS retained_items=${Math.max(0, output.length - 1)}`);
  return Response.json({ output });
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  fetchUpstream?: NativeFetch,
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    try {
      const legacy = await forwardNativeCodexRequest(nativeRequest, "responses/compact", fetchUpstream, raw);
      if (legacy.status !== 404) return legacy;
      console.error("[asterbridge:native-compaction] legacy endpoint returned 404; activating compatibility fallback");
      // ChatGPT's legacy `/backend-api/codex/responses/compact` endpoint is retired. Keep the local
      // v1 contract for Codex clients that still select it, but translate the native operation to
      // the modern `/responses` + `compaction_trigger` protocol before it leaves AsterBridge.
      return await compactNativeViaModernResponses(req, raw, fetchUpstream);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, { onTurnIdentity });
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
  const budget = planCompactV1Budget(limits.autoCompactTokenLimit, summary, raw);
  console.error(
    `[asterbridge:compaction] model=${route.slug} autoCompact=${budget.autoCompactTokenLimit} stableHarness=${budget.stableHarnessReserveTokens} summary=${budget.summaryTokens} headroom=${budget.postCompactHeadroomTokens} retained=${budget.retainedHistoryTokenBudget}`,
  );
  return Response.json({
    output: buildCompactV1Output(extractCompactUserMessages(input), summary, {
      retainedHistoryTokenBudget: budget.retainedHistoryTokenBudget,
    }),
  });
}

async function modelCatalogFailureMessage(response: Response): Promise<string | null> {
  if (response.ok) return null;
  try {
    const body = await response.clone().json() as {
      error?: { message?: unknown } | string;
    };
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
      const message = body.error.message.trim();
      if (message) return message;
    }
  } catch {
    // Preserve a stable status-only fallback for non-JSON upstream failures.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export function startServer(
  config: AppConfig,
  dependencies: { fetchUpstream?: NativeFetch } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  const startedAt = Date.now();
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let totalModelCatalogRequests = 0;
  let successfulModelCatalogRequests = 0;
  let failedModelCatalogRequests = 0;
  let lastModelCatalogStatus: number | null = null;
  let lastModelCatalogError: string | null = null;
  let lastModelCatalogRequestAt: string | null = null;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining,
          total_model_catalog_requests: totalModelCatalogRequests,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          failed_model_catalog_requests: failedModelCatalogRequests,
          last_model_catalog_status: lastModelCatalogStatus,
          last_model_catalog_error: lastModelCatalogError,
          last_model_catalog_request_at: lastModelCatalogRequestAt,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        turnBroker?.setExternalOwnersAccepted(!draining);
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let identity: { threadId: string; turnId: string };
        try {
          const body = await req.json() as { threadId?: unknown; turnId?: unknown };
          const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
          const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
            throw new Error("native Codex threadId or turnId is invalid");
          }
          identity = { threadId, turnId };
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = new DOMException("Codex turn interrupted", "AbortError");
        const browserCancellation = chatGptTurnSessions.cancelNativeTurn(identity.threadId, identity.turnId);
        const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
        void Promise.allSettled([browserCancellation.settlement, httpCancellation.settlement]).then(results => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(`[chatgpt-web] interrupted turn cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
            }
          }
        });
        return Response.json({
          status: "ok",
          cancelled_http_turns: httpCancellation.cancelled,
          cancelled_browser_turns: browserCancellation.cancelled,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const cancelledBrowserTurns = chatGptTurnSessions.cancelAllExplicitly() + (turnBroker?.revokeExternalOwners() ?? 0);
        const cancelledHttpTurns = await httpTurns.cancelAll(new Error("Active turn cancelled by launcher"));
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancelledHttpTurns,
          cancelled_browser_turns: cancelledBrowserTurns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async signal => {
          totalModelCatalogRequests += 1;
          lastModelCatalogRequestAt = new Date().toISOString();
          const response = await modelsRequest(
            new Request(req, { signal }),
            config,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
          );
          lastModelCatalogStatus = response.status;
          lastModelCatalogError = await modelCatalogFailureMessage(response);
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          } else {
            failedModelCatalogRequests += 1;
          }
          return response;
        }, req.signal);
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            createChatGptWebAdapter,
            { onTurnIdentity: bindIdentity },
          ),
          req.signal,
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            createChatGptWebAdapter,
            dependencies.fetchUpstream,
            bindIdentity,
          ),
          req.signal,
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
          req.signal,
        );
      }
      if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        const endpoint = url.pathname.endsWith("/edits") ? "images/edits" : "images/generations";
        return httpTurns.track(
          signal => nativeImageRequest(new Request(req, { signal }), endpoint, dependencies.fetchUpstream),
          req.signal,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
