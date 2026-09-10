import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt, countChatGptContextImages } from "./prompt";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnExplicitlyCancelledError, ChatGptTurnSupersededError, chatGptCompactionSourceExecutionKey, chatGptDirectTurnExecutionKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { chatGptConversationKey, retainedConversationResumeRequest } from "./conversation-key";
import { runRetainedCompaction } from "./compaction-handoff";
import { parseDirectToolBridgeResponse } from "./direct-tool-bridge";
import { isDeferredSubagentWireName } from "./deferred-subagent-tools";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
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

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
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

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

export function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName) && !isDeferredSubagentWireName(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: { broker?: TurnBrokerOwner } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    ...(provider.chatgptWeb?.localToolsEnabled === true
      ? { localToolTransport: provider.chatgptWeb?.localToolTransport ?? "mcp" }
      : {}),
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const directToolBinding = mode.localTools && turnCapabilities.localToolTransport === "responses"
      ? `dtb_${createHash("sha256").update(`${executionNamespace}:${traceId}:direct-tools`).digest("hex").slice(0, 24)}`
      : undefined;
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const compileOptionsFor = (input: CodexParsedRequest) => {
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities)
        : undefined;
      return {
        captureLunaCheckpoint,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
        ...(directToolBinding ? { directToolBinding } : {}),
      };
    };
    const retainExternalConversation = !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && (provider.chatgptWeb?.browserHost === "roxybrowser" || provider.chatgptWeb?.browserHost === "system-browser");
    const conversationKey = retainExternalConversation
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined;
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    if (!mode.localTools) {
      const browser = finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      }));
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        ...(identity.threadId ? { threadId: identity.threadId } : {}),
        ...(identity.turnId ? { turnId: identity.turnId } : {}),
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    if (turnCapabilities.localToolTransport === "responses") {
      if (!directToolBinding) throw new Error("Responses tool bridge lost its binding");
      const prepareDirect = async (input: CodexParsedRequest) => ({
        ...compileChatGptWebPrompt(
          input,
          turnCapabilities,
          undefined,
          compileOptionsFor(input),
        ),
        release: () => {},
      });
      const browser = finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: () => prepareDirect(checkpointInput.parsed),
        ...(resumeInput ? { prepareResume: () => prepareDirect(resumeInput) } : {}),
        ...(conversationKey ? { retainConversation: true, conversationKey } : {}),
        abortSignal: browserAbort.signal,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
      }));
      return {
        mode: "direct-tools",
        binding: directToolBinding,
        browser,
        trace,
        text,
        ...(identity.threadId ? { threadId: identity.threadId } : {}),
        ...(identity.turnId ? { turnId: identity.turnId } : {}),
        ...(conversationKey ? {
          conversationKey,
          releaseRetainedConversation: async () => { await worker.releaseRetainedConversation(conversationKey); },
        } : {}),
        cancel: () => browserAbort.abort(),
      };
    }
    const token = deferred<string>();
    const sameProcessToolProgress = provider.chatgptWeb?.browserHost === "roxybrowser"
      || provider.chatgptWeb?.browserHost === "system-browser"
      || provider.chatgptWeb?.browserHost === "managed-chrome";
    const externalProgress = sameProcessToolProgress
      ? new ChatGptExternalTurnProgress()
      : undefined;
    const completionFence = externalProgress
      && broker.beginCompletionFence
      && broker.commitCompletionFence
      ? {
          begin: async () => await broker.beginCompletionFence!(await token.promise),
          commit: async (revision: number) => await broker.commitCompletionFence!(await token.promise, revision),
        }
      : undefined;
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        {
          ...environment,
          contextImageCount: countChatGptContextImages(input.context.messages),
          imageGeneration: {
            provider: provider.chatgptWeb?.imageGenerationProvider ?? "auto",
            browserHost: provider.chatgptWeb?.browserHost,
            systemBrowserChannel: provider.chatgptWeb?.systemBrowserChannel,
            roxyBrowserProfileId: provider.chatgptWeb?.roxyBrowserProfileId,
            roxyBrowserDataDir: provider.chatgptWeb?.roxyBrowserDataDir,
            roxyBrowserAutoOpen: provider.chatgptWeb?.roxyBrowserAutoOpen,
            roxyBrowserApiHost: provider.chatgptWeb?.roxyBrowserApiHost,
            roxyBrowserApiKeyFile: provider.chatgptWeb?.roxyBrowserApiKeyFile,
            ...(identity.threadId ? { threadId: identity.threadId } : {}),
          },
        },
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      if (!tokenSettled) {
        tokenSettled = true;
        token.resolve(turnToken);
      }
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input),
        );
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browser = finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
      ...(conversationKey ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      ...(externalProgress ? { externalProgress } : {}),
      ...(completionFence ? { completionFence } : {}),
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }));
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      ...(externalProgress ? { externalProgress } : {}),
      browser,
      trace,
      text,
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
      ...(conversationKey ? {
        conversationKey,
        releaseRetainedConversation: async () => { await worker.releaseRetainedConversation(conversationKey); },
      } : {}),
      cancel: () => {
        browserAbort.abort();
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web subagents currently require a V1-rooted task. "
          + "Refresh the Codex model catalog and start a new task; an existing V2 task cannot migrate surfaces. "
          + "Codex MultiAgent V2 encrypts cross-backend task payloads.",
        );
      }
      const turnCapabilities = parsed._compactionRequest
        ? { ...configuredCapabilities, localToolsEnabled: false }
        : configuredCapabilities;
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
      const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
      if (exhaustedRetry) {
        emit({
          type: "error",
          message: exhaustedRetry.message,
          status: exhaustedRetry.status,
          errorType: exhaustedRetry.errorType,
          code: exhaustedRetry.code,
          retryable: false,
        });
        return;
      }
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      if (mode.localTools) {
        try {
          environment = environmentStore.resolve(parsed);
        } catch (error) {
          const identity = extractChatGptTurnIdentity(parsed);
          console.warn(
            `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
          );
          throw error;
        }
      }
      if (parsed._compactionRequest) {
        const retainedCompactionSupported = configuredCapabilities.localToolsEnabled
          && configuredCapabilities.localToolTransport !== "responses"
          && broker instanceof TurnBroker
          && (provider.chatgptWeb?.browserHost === "roxybrowser" || provider.chatgptWeb?.browserHost === "system-browser");
        if (retainedCompactionSupported) {
          const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
          const handoffTraceId = createHash("sha256")
            .update(`${compactionExecutionKey}:handoff`)
            .digest("hex")
            .slice(0, 12);
          const summary = await runRetainedCompaction({
            worker,
            parsed,
            sessions: chatGptTurnSessions,
            broker,
            capabilities: configuredCapabilities,
            conversationKey: chatGptConversationKey(parsed, executionNamespace),
            traceId: handoffTraceId,
            signal: incoming.abortSignal,
            timeoutMs,
            freshFallback: async reason => {
              console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
              const fallbackRuntime = startRuntime(
                parsed,
                undefined,
                `${handoffTraceId}_fallback`,
                turnCapabilities,
              );
              try {
                return await withAbort(fallbackRuntime.browser, incoming.abortSignal);
              } finally {
                fallbackRuntime.cancel();
              }
            },
          });
          emit({ type: "text_delta", text: summary, phase: "final_answer" });
          emitBrowserCompletion(
            { type: "final", answer: summary },
            estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities),
            emit,
          );
          chatGptWebTurnRetryPolicy.clear(retryKey);
          return;
        }
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
        await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      }
      const directToolRound = mode.localTools && turnCapabilities.localToolTransport === "responses";
      const executionKey = `${executionNamespace}:${directToolRound ? chatGptDirectTurnExecutionKey(parsed) : chatGptTurnExecutionKey(parsed)}`;
      const turnIdentity = extractChatGptTurnIdentity(parsed);
      if (turnIdentity.threadId && turnIdentity.turnId) {
        const preempted = await chatGptTurnSessions.preemptSupersededThread(turnIdentity.threadId, turnIdentity.turnId);
        if (preempted > 0) {
          console.warn(`[chatgpt-web] superseded ${preempted} active browser turn(s) for a newer native Codex turn on the same thread`);
        }
      }
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
      let session: ChatGptTurnSession;
      try {
        session = chatGptTurnSessions.getOrCreate(
          executionKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities),
        );
      } catch (error) {
        if (error instanceof ChatGptTurnExplicitlyCancelledError) {
          throw new ChatGptWebAdapterError(
            "This Codex turn was explicitly cancelled by the launcher and cannot be retried.",
            { status: 409, errorType: "invalid_request_error", code: "turn_cancelled", retryable: false },
          );
        }
        if (error instanceof ChatGptTurnSupersededError) {
          throw new ChatGptWebAdapterError(
            "This Codex turn was superseded by a newer turn on the same thread and cannot be retried.",
            { status: 409, errorType: "invalid_request_error", code: "turn_superseded", retryable: false },
          );
        }
        throw error;
      }
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await session.runExclusive(async () => {
          if (session.runtime.mode === "direct-tools") {
            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const reasoning = session.reasoningForOutstandingReplay();
              replayEvents(session.eventsForOutstandingReplay(), emit);
              emitToolBatch(
                outstanding,
                estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities),
                emit,
              );
              return;
            }
            const settledDirect = session.settledOutcome() ?? await withAbort(session.browserOutcome, incoming.abortSignal);
            if (settledDirect.type === "error") throw settledDirect.error;
            const replay = session.eventsForFinalReplay();
            let reasoning = session.reasoningForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
              emitBrowserCompletion(
                settledDirect,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settledDirect.answer, reasoning }, turnCapabilities),
                emit,
              );
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }
            const answer = session.runtime.text.value();
            if (answer !== settledDirect.answer) {
              throw new Error("ChatGPT browser Markdown stream did not reproduce the completed direct-tool answer");
            }
            const trace = session.runtime.trace.drain();
            reasoning = trace.map(event => event.text);
            const events: AdapterEvent[] = [];
            const emitCaptured = (event: AdapterEvent) => {
              events.push(event);
              emit(event);
            };
            emitTraceEvents(trace, emitCaptured);
            const requests = parseDirectToolBridgeResponse(
              answer,
              parsed,
              session.runtime.binding,
              executionKey,
            );
            if (requests) {
              validateBatchTools(parsed, requests);
              session.setOutstanding(requests, reasoning, events);
              emitToolBatch(
                requests,
                estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: requests }, turnCapabilities),
                emit,
              );
              return;
            }
            emitTextDeltas(session.runtime.text.drain(), emitCaptured);
            session.setFinalReasoning(reasoning);
            session.setFinalEvents(events);
            emitBrowserCompletion(
              settledDirect,
              estimateChatGptWebUsage(currentUsageInput(parsed), { answer, reasoning }, turnCapabilities),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") throw settled.error;
            let reasoning = session.reasoningForFinalReplay();
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              const events: AdapterEvent[] = [];
              const emitCaptured = (event: AdapterEvent) => {
                events.push(event);
                emit(event);
              };
              if (!parsed._compactionRequest) emitReadOnlyContextWarning(parsed, turnCapabilities, emitCaptured);
              const trace = session.runtime.trace.drain();
              reasoning = trace.map(event => event.text);
              emitTraceEvents(trace, emitCaptured);
              emitTextDeltas(session.runtime.text.drain(), emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(events);
            }
            emitBrowserCompletion(settled, estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities), emit);
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            await broker.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = currentToolResults(parsed, session);
              if (results.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(outstanding, estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                return;
              }
              if (results.length !== outstanding.length) {
                throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
              }
              for (const message of results) {
                const request = outstanding.find(candidate => candidate.callId === message.toolCallId);
                await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                session.runtime.externalProgress?.recordToolResult();
                session.markResultDelivered(message.toolCallId);
                const closedThreadId = request?.wireName === "multi_agent_v1__close_agent"
                  && message.isError === false
                  && typeof request.arguments?.target === "string"
                  ? request.arguments.target
                  : undefined;
                if (closedThreadId) {
                  const retired = await chatGptTurnSessions.retireThreadAndWait(closedThreadId);
                  console.info(`[chatgpt-web] released closed subagent retained thread=${closedThreadId.slice(0, 17)} sessions=${retired}`);
                }
              }
            }
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }

          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning: string[] = [];
            const roundEvents: AdapterEvent[] = [];
            const emitRound = (event: AdapterEvent) => {
              roundEvents.push(event);
              emit(event);
            };
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              emitTraceEvents(trace, emitRound);
            };
            const emitNewText = (deltas: string[]) => emitTextDeltas(deltas, emitRound);
            if (!parsed._compactionRequest) emitReadOnlyContextWarning(parsed, turnCapabilities, emitRound);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const nextTools = turnToken
              ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  const progress = session.runtime.mode === "tools"
                    ? session.runtime.externalProgress
                    : undefined;
                  if (progress && requests.length > 0) {
                    const revision = progress.recordToolBatch(requests.length);
                    await progress.waitForToolBatchObservation(revision, toolWaitAbort.signal);
                  }
                  return { type: "tools" as const, requests };
                })
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ]),
                incoming.abortSignal,
              );
              if (next.type === "trace") {
                emitNewTrace([next.event]);
                nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                if (turnToken) await broker.revoke(turnToken);
                if (next.outcome.type === "error") throw next.outcome.error;
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                emitBrowserCompletion(
                  next.outcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: next.outcome.answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              session.setOutstanding(next.requests, roundReasoning, roundEvents);
              emitToolBatch(
                next.requests,
                estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
        });
      } catch (error) {
        const handledError = error instanceof ChatGptWebAdapterError && error.retryable
          ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, error)
          : error;
        if (!(error instanceof ChatGptWebAdapterError && error.retryable)) {
          chatGptWebTurnRetryPolicy.clear(retryKey);
        }
        if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
          // A deterministic request failure remains replayable so a native reconnect cannot burn
          // another browser attempt. Every other failure retires the browser session: client
          // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
          // instead of replaying one rejected browser outcome for the registry's full TTL.
          session.cancel();
        } else {
          chatGptTurnSessions.retire(executionKey, session);
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (handledError instanceof ChatGptWebAdapterError) {
          emit({
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          });
          return;
        }
        chatGptWebTurnRetryPolicy.clear(retryKey);
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
