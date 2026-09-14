import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Bun daemon streams a prepared browser turn through the persistent Node helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const runs = new Map();
    send({ type: "ready", features: ["physical-settlement", "prompt-selection"] });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type === "run") {
        runs.set(message.id, message);
        send({ type: "event", id: message.id, event: "prepared_selected", reused: false });
        return;
      }
      if (message.type !== "prepared_selected_ack") return;
      const run = runs.get(message.id);
      if (!run || message.prepared.text !== "inspect") process.exit(98);
      send({ type: "event", id: message.id, event: "reasoning", text: "Reading project" });
      send({ type: "event", id: message.id, event: "reasoning", text: " files", continuation: true });
      send({ type: "event", id: message.id, event: "text", text: "done" });
      if (run.turn.captureLunaCheckpoint) send({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        answerHash: "a".repeat(64),
        checkpoint: {
          version: 1,
          objective: "Finish the helper test.",
          state: ["The answer streamed."],
          evidence: ["The helper emitted a checkpoint event."],
          decisions: [],
          pending: [],
        },
      });
      send({ type: "result", id: message.id, text: "done" });
      send({ type: "settled", id: message.id });
    });
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 2,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    systemBrowserChannel: "auto",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release: () => { released = true; } }),
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("a reused launcher surface compiles only the retained continuation prompt", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    systemBrowserChannel: "auto",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const child = {};
  const sent: Array<Record<string, unknown>> = [];
  const internal = client as unknown as {
    child?: unknown;
    helperFeatures: Set<string>;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    handleLine(child: unknown, line: string): void;
  };
  internal.child = child;
  internal.helperFeatures = new Set(["physical-settlement", "prompt-selection"]);
  internal.ensureChild = async () => {};
  internal.send = async message => {
    sent.push(message);
    if (message.type === "run") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "event",
        id: "resume-select-123",
        event: "prepared_selected",
        reused: true,
      })));
      return;
    }
    if (message.type === "prepared_selected_ack") {
      queueMicrotask(() => {
        internal.handleLine(child, JSON.stringify({ type: "result", id: "resume-select-123", text: "continued" }));
        internal.handleLine(child, JSON.stringify({ type: "settled", id: "resume-select-123" }));
      });
    }
  };

  let freshCalls = 0;
  let resumeCalls = 0;
  let releases = 0;
  const result = await client.run({
    traceId: "resume-select-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
    conversationKey: "a".repeat(64),
    retainConversation: true,
    prepare: async () => {
      freshCalls += 1;
      return { text: "fresh prompt", images: [], release: () => { releases += 1; } };
    },
    prepareResume: async () => {
      resumeCalls += 1;
      return { text: "resume prompt", images: [], release: () => { releases += 1; } };
    },
    onTextDelta() {},
  });

  expect(result).toBe("continued");
  expect(freshCalls).toBe(0);
  expect(resumeCalls).toBe(1);
  expect(releases).toBe(1);
  expect(sent[0]).toMatchObject({
    type: "run",
    turn: {
      resumeAvailable: true,
      retainConversation: true,
      conversationKey: "a".repeat(64),
    },
  });
  expect(sent[1]).toMatchObject({
    type: "prepared_selected_ack",
    prepared: { text: "resume prompt", images: [] },
  });
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    systemBrowserChannel: "auto",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
    helperFeatures: Set<string>;
  };
  internal.helperFeatures = new Set(["physical-settlement", "prompt-selection"]);
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    systemBrowserChannel: "auto",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      resolveSettlement: () => void;
      rejectSettlement: (error: Error) => void;
      logicalSettled?: boolean;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  let settlePhysical!: () => void;
  let rejectPhysical!: (error: Error) => void;
  const physicalSettlement = new Promise<void>((resolve, reject) => {
    settlePhysical = resolve;
    rejectPhysical = reject;
  });
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
      resolveSettlement: settlePhysical,
      rejectSettlement: rejectPhysical,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  internal.handleLine(child, JSON.stringify({ type: "settled", id: "rate-limit-123" }));
  await expect(physicalSettlement).resolves.toBeUndefined();
});

test("launcher helper logical result can precede physical settlement without releasing ownership", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    systemBrowserChannel: "auto",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      resolveSettlement: () => void;
      rejectSettlement: (error: Error) => void;
      logicalSettled?: boolean;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  let resolveResult!: (value: string) => void;
  let rejectResult!: (error: Error) => void;
  let resolveSettlement!: () => void;
  let rejectSettlement!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const physicalSettlement = new Promise<void>((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  internal.pending.set("physical-split-123", {
    turn: {
      traceId: "physical-split-123",
      modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      onTextDelta() {},
    },
    resolve: resolveResult,
    reject: rejectResult,
    resolveSettlement,
    rejectSettlement,
  });

  internal.handleLine(child, JSON.stringify({ type: "result", id: "physical-split-123", text: "done" }));
  await expect(result).resolves.toBe("done");
  let physicallySettled = false;
  void physicalSettlement.then(() => { physicallySettled = true; });
  await Promise.resolve();
  expect(physicallySettled).toBeFalse();
  expect(internal.pending.has("physical-split-123")).toBeTrue();

  internal.handleLine(child, JSON.stringify({ type: "settled", id: "physical-split-123" }));
  await expect(physicalSettlement).resolves.toBeUndefined();
  expect(physicallySettled).toBeTrue();
  expect(internal.pending.has("physical-split-123")).toBeFalse();
});
