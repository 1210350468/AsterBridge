import type { CodexContentPart, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { parseDataUrl } from "../image";
import { estimateTokens } from "../../lib/token-estimate";
import { ChatGptWebAdapterError } from "./adapter-error";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { ChatGptTurnSession, ChatGptTurnSessions } from "./turn-execution";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";
export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;
export const MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS = 1_024;
const COMPACTION_LATEST_USER_OMISSION = "\n...[AsterBridge omitted the middle of an oversized latest user prompt during compaction]...\n";
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

interface CachedCompactionRun {
  createdAt: number;
  promise: Promise<string>;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();

function pruneStructuredCompactionRuns(): void {
  const cutoff = Date.now() - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [key, run] of structuredCompactionRuns) {
    if (run.createdAt < cutoff) structuredCompactionRuns.delete(key);
  }
}

export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  start: () => Promise<string>,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const promise = Promise.resolve().then(start);
  structuredCompactionRuns.set(key, { createdAt: Date.now(), promise });
  void promise.catch(() => {
    if (structuredCompactionRuns.get(key)?.promise === promise) {
      structuredCompactionRuns.delete(key);
    }
  });
  return promise;
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

function prefixWithinTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= tokenBudget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    let mid = Math.ceil((low + high) / 2);
    if (mid < text.length) {
      const previous = text.charCodeAt(mid - 1);
      const next = text.charCodeAt(mid);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) mid -= 1;
    }
    if (estimateTokens(text.slice(0, mid)) <= tokenBudget) low = Math.max(mid, low + 1);
    else high = mid - 1;
  }
  let end = Math.min(low, text.length);
  while (end > 0 && estimateTokens(text.slice(0, end)) > tokenBudget) end -= 1;
  return text.slice(0, end);
}

function suffixWithinTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= tokenBudget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    let mid = Math.floor((low + high) / 2);
    if (mid > 0) {
      const code = text.charCodeAt(mid);
      if (code >= 0xDC00 && code <= 0xDFFF) mid -= 1;
    }
    if (estimateTokens(text.slice(mid)) > tokenBudget) low = Math.max(mid + 1, low + 1);
    else high = mid;
  }
  return text.slice(Math.min(low, text.length));
}

export function boundedCompactionLatestUserPrompt(latestUserPrompt: string): string {
  if (estimateTokens(latestUserPrompt) <= MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS) {
    return latestUserPrompt;
  }
  const omissionTokens = estimateTokens(COMPACTION_LATEST_USER_OMISSION);
  const remaining = Math.max(0, MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS - omissionTokens);
  let prefixBudget = Math.ceil(remaining / 2);
  let suffixBudget = Math.floor(remaining / 2);
  for (;;) {
    const bounded = `${prefixWithinTokenBudget(latestUserPrompt, prefixBudget)}${COMPACTION_LATEST_USER_OMISSION}${suffixWithinTokenBudget(latestUserPrompt, suffixBudget)}`;
    if (estimateTokens(bounded) <= MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS) return bounded;
    if (prefixBudget >= suffixBudget && prefixBudget > 0) prefixBudget -= 1;
    else if (suffixBudget > 0) suffixBudget -= 1;
    else return COMPACTION_LATEST_USER_OMISSION;
  }
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const boundedLatestUserPrompt = boundedCompactionLatestUserPrompt(latestUserPrompt);
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(boundedLatestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * If compaction arrives while the retained agent is blocked on MCP results, finish those canonical
 * results unchanged. A compaction instruction is injected only if the agent asks for another tool;
 * the checkpoint itself is always produced by the later dedicated retained handoff.
 */
export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel();
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(`Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`);
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(token, request.callId, toolResult(result));
        source.runtime.externalProgress?.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      return { answer: browserOutcome.answer, compactionInstructionDelivered };
    } catch (error) {
      if (signal?.aborted) source.cancel();
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

/**
 * Ask the exact retained ChatGPT conversation to produce the structured checkpoint. The one-shot
 * control token is embedded in the continuation prompt; no ordinary Codex tool environment is
 * attached to that token. The caller owns retirement of the retained conversation after success.
 */
export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: Awaited<ReturnType<TurnBroker["beginCompactionTransaction"]>> | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const instruction = structuredCompactionHandoffInstruction(transaction);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      // The retained conversation already owns Codex Native3. The only capability in the prompt is
      // the one-shot control token above; it cannot resolve to an ordinary outer-Codex environment.
      capabilities: { ...capabilities, localToolsEnabled: true },
      prepare,
      prepareResume: prepare,
      retainConversation: true,
      requireRetainedConversation: true,
      conversationKey,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const browserFailure = browser.then<never>(
      () => new Promise<never>(() => {}),
      error => { throw error; },
    );
    const summary = await withCompactionAbort(
      Promise.race([
        broker.waitForCompactionHandoff(transaction.token, operationSignal),
        browserFailure,
      ]),
      operationSignal,
    );
    browserAbort.abort(new DOMException("Structured compaction handoff accepted", "AbortError"));
    await withCompactionAbort(browser.then(() => undefined, () => undefined), operationSignal);
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      await withCompactionAbort(browser.then(() => undefined, () => undefined), operationSignal).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

export async function runRetainedCompaction(options: {
  worker: ChatGptBrowserWorker;
  parsed: CodexParsedRequest;
  sessions: ChatGptTurnSessions;
  broker: TurnBroker;
  capabilities: ChatGptWebCapabilities;
  conversationKey?: string;
  traceId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  compactedSourceExecutionKey?: string;
  freshFallback: (reason: string) => Promise<string>;
}): Promise<string> {
  const {
    worker,
    parsed,
    sessions,
    broker,
    capabilities,
    conversationKey,
    traceId,
    signal,
    timeoutMs,
    compactedSourceExecutionKey,
    freshFallback,
  } = options;
  const source = conversationKey ? sessions.findConversationHead(conversationKey) : undefined;
  if (!source || !conversationKey) {
    return canonicalizeCompactionHandoff(parsed, await freshFallback("source_unavailable_before_handoff"));
  }
  try {
    let preserveFinalResponse = !source.isActive() && source.settledOutcome()?.type === "final";
    let rawSummary: string;
    if (source.isActive() && source.runtime.mode === "tools") {
      const settlement = await settleActiveCompactionSource(parsed, source, broker, signal);
      preserveFinalResponse = !settlement.compactionInstructionDelivered;
    } else {
      if (source.isActive()) {
        const outcome = await withCompactionAbort(source.browserOutcome, signal);
        if (outcome.type === "error") throw outcome.error;
        preserveFinalResponse = true;
      }
    }
    rawSummary = await requestRetainedCompactionHandoff(
      worker,
      parsed,
      source,
      broker,
      capabilities,
      traceId,
      signal,
      timeoutMs,
    );
    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
    if (preserveFinalResponse && compactedSourceExecutionKey) {
      await sessions.retireConversationPreservingFinalResponse(
        conversationKey,
        source,
        compactedSourceExecutionKey,
      );
    } else {
      await sessions.retireConversationAndWait(conversationKey);
    }
    return summary;
  } catch (error) {
    await sessions.retireConversationAndWait(conversationKey).catch(() => {});
    if (error instanceof ChatGptWebAdapterError && error.code === "compaction_source_unavailable") {
      return canonicalizeCompactionHandoff(parsed, await freshFallback("source_disappeared_before_handoff"));
    }
    throw error;
  }
}
