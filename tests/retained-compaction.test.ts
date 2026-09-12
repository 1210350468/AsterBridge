import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexParsedRequest } from "../src/types";
import type { ChatGptBrowserWorker, BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  boundedCompactionLatestUserPrompt,
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  LATEST_USER_PROMPT_MARKER,
  MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS,
  requestRetainedCompactionHandoff,
  runRetainedCompaction,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { estimateTokens } from "../src/lib/token-estimate";

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function compactionRequest(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [{ role: "user", content: "latest human request", timestamp: 1 }],
      tools: [],
    },
    options: { reasoning: "high" },
    _compactionRequest: true,
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": { thread_id: "thread-compaction", turn_id: "turn-compaction" },
      },
      input: [{
        type: "message",
        id: "msg-latest-user",
        role: "user",
        content: [{ type: "input_text", text: "latest human request" }],
      }],
    },
  };
}

function sourceSession(conversationKey = "retained-conversation"): ChatGptTurnSession {
  return new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    cancel: () => {},
  });
}

test("canonical compaction handoff preserves the latest human prompt exactly once", () => {
  const parsed = compactionRequest();
  const canonical = canonicalizeCompactionHandoff(parsed, "Objective: resume work\nState: ready");
  expect(canonical).toContain(`\n\n${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify("latest human request")}`);
  expect(canonicalizeCompactionHandoff(parsed, canonical)).toBe(canonical);
  expect(() => canonicalizeCompactionHandoff(
    parsed,
    `Objective: bad\n${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify("different request")}`,
  )).toThrow("conflicting latest-user marker");
});

test("oversized latest-user appendix is token-bounded instead of duplicating the full prompt", () => {
  const huge = `important-prefix:${" filler".repeat(20_000)}:important-suffix`;
  const bounded = boundedCompactionLatestUserPrompt(huge);
  expect(bounded).toStartWith("important-prefix:");
  expect(bounded).toEndWith(":important-suffix");
  expect(bounded).toContain("AsterBridge omitted the middle");
  expect(bounded.length).toBeLessThan(huge.length / 4);
  expect(estimateTokens(bounded)).toBeLessThanOrEqual(MAX_COMPACTION_LATEST_USER_PROMPT_TOKENS);

  const parsed = compactionRequest();
  parsed.context.messages = [{ role: "user", content: huge, timestamp: 1 }];
  (parsed._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text = huge;
  const canonical = canonicalizeCompactionHandoff(parsed, "bounded checkpoint");
  expect(canonical).not.toContain(huge);
  expect(estimateTokens(canonical)).toBeLessThan(1_200);
});

test("retained compaction uses the exact conversation and waits for structured handoff plus browser completion", async () => {
  const socketPath = brokerTestEndpoint(`cgw-retained-compaction-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const parsed = compactionRequest();
  const source = sourceSession("conversation-exact");
  let observedTurn: BrowserTurn | undefined;
  let browserFinished = false;
  const worker = {
    run(turn: BrowserTurn) {
      observedTurn = turn;
      return (async () => {
        const prepared = await turn.prepareResume!();
        const token = /turn_token (control_[0-9a-f]+)/.exec(prepared.text)?.[1];
        const handoffId = /handoff_id (handoff_[0-9a-f]+)/.exec(prepared.text)?.[1];
        if (!token || !handoffId) throw new Error("compaction prompt did not expose its one-shot binding");
        await callTurnBroker(socketPath, {
          method: "submit_compaction_handoff",
          token,
          handoffId,
          summary: "structured retained checkpoint",
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        browserFinished = true;
        return "visible compaction completion";
      })();
    },
  } as unknown as ChatGptBrowserWorker;

  try {
    const summary = await requestRetainedCompactionHandoff(
      worker,
      parsed,
      source,
      broker,
      { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      "trace-retained-compaction",
      undefined,
      30_000,
    );
    expect(summary).toBe("structured retained checkpoint");
    expect(browserFinished).toBe(true);
    expect(observedTurn).toMatchObject({
      conversationKey: "conversation-exact",
      retainConversation: true,
      requireRetainedConversation: true,
    });
    expect(observedTurn?.prepareResume).toBeFunction();
  } finally {
    await broker.close();
  }
}, 30_000);

test("retained compaction fails closed when ChatGPT skips the structured MCP handoff", async () => {
  const socketPath = brokerTestEndpoint(`cgw-retained-compaction-text-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const parsed = compactionRequest();
  const source = sourceSession("conversation-text-fallback");
  let token = "";
  let handoffId = "";
  const worker = {
    run(turn: BrowserTurn) {
      return (async () => {
        const prepared = await turn.prepareResume!();
        token = /turn_token (control_[0-9a-f]+)/.exec(prepared.text)?.[1] ?? "";
        handoffId = /handoff_id (handoff_[0-9a-f]+)/.exec(prepared.text)?.[1] ?? "";
        if (!token || !handoffId) throw new Error("compaction prompt did not expose its one-shot binding");
        return "browser-only retained checkpoint";
      })();
    },
  } as unknown as ChatGptBrowserWorker;

  try {
    await expect(requestRetainedCompactionHandoff(
      worker,
      parsed,
      source,
      broker,
      { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      "trace-retained-compaction-text",
      undefined,
      25,
    )).rejects.toThrow("timed out after 25ms");
    await expect(callTurnBroker(socketPath, {
      method: "submit_compaction_handoff",
      token,
      handoffId,
      summary: "late stale checkpoint",
    })).rejects.toThrow("invalid, expired, or consumed");
  } finally {
    await broker.close();
  }
}, 30_000);

test("active tool-boundary compaction delivers the canonical result unchanged before the retained checkpoint", async () => {
  const socketPath = brokerTestEndpoint(`cgw-active-compaction-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [process.cwd()],
    sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [process.cwd()], networkAccess: false },
    tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
  };
  const token = await broker.register(environment, 30_000, "trace-active-compaction");
  const claim = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }, 30_000);
  const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
    method: "invoke",
    bindingId: claim.bindingId,
    wireName: "exec_command",
    arguments: { cmd: "echo once" },
  }, 30_000);
  const [request] = await broker.nextToolBatch(token);
  expect(request?.wireName).toBe("exec_command");

  let resolveBrowser!: (value: string) => void;
  const browser = new Promise<string>(resolve => { resolveBrowser = resolve; });
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve(token),
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "active-conversation",
    cancel: () => {},
  });
  source.setOutstanding([request!]);
  const parsed = compactionRequest();
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: request!.callId,
    toolName: "exec_command",
    content: "canonical result",
    isError: false,
    timestamp: 2,
  });
  const observedResult = invocation.then(result => {
    expect(JSON.stringify(result.content)).not.toContain("CODEX_ACTIVE_COMPACTION_REQUEST");
    expect(result.content).toEqual([{ type: "text", text: "canonical result" }]);
    resolveBrowser("ordinary final after canonical result");
    return result;
  });

  try {
    expect(await settleActiveCompactionSource(parsed, source, broker)).toEqual({
      answer: "ordinary final after canonical result",
      compactionInstructionDelivered: false,
    });
    expect((await observedResult).isError).not.toBe(true);
    expect(source.outstanding()).toEqual([]);
  } finally {
    broker.revoke(token);
    await broker.close();
  }
}, 30_000);

test("retained conversation retirement can preserve an already committed final response under the compacted execution key", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "preserved-conversation";
  let releases = 0;
  let replacementStarts = 0;
  const source = sessions.getOrCreate("source-execution", () => ({
    mode: "read-only",
    browser: Promise.resolve("ordinary final answer"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel: () => {},
  }));
  await source.browserOutcome;

  expect(await sessions.retireConversationPreservingFinalResponse(
    conversationKey,
    source,
    "compacted-source-execution",
  )).toBe(1);
  expect(releases).toBe(1);
  expect(source.conversationKey()).toBeUndefined();
  expect(sessions.findConversationHead(conversationKey)).toBeUndefined();
  expect(sessions.getOrCreate("compacted-source-execution", () => {
    replacementStarts += 1;
    throw new Error("the committed final response must be replayed, not replaced");
  })).toBe(source);
  expect(replacementStarts).toBe(0);
  sessions.clear();
});

test("a failed structured compaction run is evicted while a successful exact run remains replayable", async () => {
  const key = `structured-retry-${Date.now()}-${Math.random()}`;
  let starts = 0;
  await expect(runStructuredCompactionOnce(key, async () => {
    starts += 1;
    throw new Error("first handoff failed");
  })).rejects.toThrow("first handoff failed");
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  const retry = runStructuredCompactionOnce(key, async () => {
    starts += 1;
    return "recovered checkpoint";
  });
  expect(runStructuredCompactionOnce(key, async () => "must not start")).toBe(retry);
  await expect(retry).resolves.toBe("recovered checkpoint");
  await expect(existingStructuredCompactionRun(key)).resolves.toBe("recovered checkpoint");
  expect(starts).toBe(2);
});

test("missing retained source rebuilds one canonical checkpoint from fresh Codex history", async () => {
  const socketPath = brokerTestEndpoint(`cgw-compaction-fallback-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const sessions = new ChatGptTurnSessions();
  let fallbackCalls = 0;
  try {
    const summary = await runRetainedCompaction({
      worker: {} as ChatGptBrowserWorker,
      parsed: compactionRequest(),
      sessions,
      broker,
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      conversationKey: "missing-conversation",
      traceId: "trace-fallback",
      freshFallback: async reason => {
        fallbackCalls += 1;
        expect(reason).toBe("source_unavailable_before_handoff");
        return "fresh canonical state";
      },
    });
    expect(fallbackCalls).toBe(1);
    expect(summary).toContain("fresh canonical state");
    expect(summary).toContain(LATEST_USER_PROMPT_MARKER);
  } finally {
    await broker.close();
  }
});

test("lost retained Roxy page retires the stale epoch before one fresh recovery checkpoint", async () => {
  const socketPath = brokerTestEndpoint(`cgw-compaction-lost-page-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const sessions = new ChatGptTurnSessions();
  let released = 0;
  sessions.getOrCreate("source-turn", () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "lost-conversation",
    releaseRetainedConversation: async () => { released += 1; },
    cancel: () => {},
  }));
  await Promise.resolve();
  let fallbackCalls = 0;
  const worker = {
    run() {
      return Promise.reject(new ChatGptWebAdapterError(
        "retained page gone",
        { status: 409, errorType: "invalid_request_error", code: "compaction_source_unavailable", retryable: false },
      ));
    },
  } as unknown as ChatGptBrowserWorker;
  try {
    const summary = await runRetainedCompaction({
      worker,
      parsed: compactionRequest(),
      sessions,
      broker,
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      conversationKey: "lost-conversation",
      traceId: "trace-lost-page",
      freshFallback: async reason => {
        fallbackCalls += 1;
        expect(reason).toBe("source_disappeared_before_handoff");
        return "recovered checkpoint";
      },
    });
    expect(summary).toContain("recovered checkpoint");
    expect(fallbackCalls).toBe(1);
    expect(released).toBe(1);
    expect(sessions.findConversationHead("lost-conversation")).toBeUndefined();
  } finally {
    await broker.close();
  }
}, 30_000);
