import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptWebAdapterError } from "./adapter-error";
import { createBrowserHelperPromptSelection } from "./browser-helper-prompt-selection";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import type { CompiledChatGptWebPrompt } from "./prompt";
import {
  ChatGptMirroredTurnProgress,
  type ChatGptExternalTurnProgressSnapshot,
} from "./turn-progress";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    compaction?: boolean;
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
  };
}

interface PreparedSelectedAckMessage {
  type: "prepared_selected_ack";
  id: string;
  prepared: CompiledChatGptWebPrompt;
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage;
type InputMessage = RunMessage
  | PreparedSelectedAckMessage
  | MaintenanceMessage
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string }
  | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown();
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): void => {
  protocolOutput.write(JSON.stringify(message));
};

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
const preparedSelections = new Map<string, ReturnType<typeof createBrowserHelperPromptSelection>>();
const turnProgress = new Map<string, ChatGptMirroredTurnProgress>();
const completionFenceBeginWaiters = new Map<string, {
  requestId: number;
  resolve: (revision: number | undefined) => void;
  reject: (error: Error) => void;
}>();
const completionFenceCommitWaiters = new Map<string, {
  requestId: number;
  resolve: (committed: boolean) => void;
  reject: (error: Error) => void;
}>();
let completionFenceRequestId = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requestShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  protocolOutput.close();
  diagnosticOutput.close();
  for (const controller of abortControllers.values()) controller.abort();
  for (const selection of preparedSelections.values()) selection.cancel();
  preparedSelections.clear();
  turnProgress.clear();
  for (const waiter of completionFenceBeginWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceBeginWaiters.clear();
  for (const waiter of completionFenceCommitWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceCommitWaiters.clear();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (message.turn.resumeAvailable !== undefined && typeof message.turn.resumeAvailable !== "boolean") {
    throw new Error("Browser helper resume availability is invalid");
  }
  if (message.turn.retainConversation !== undefined && typeof message.turn.retainConversation !== "boolean") {
    throw new Error("Browser helper conversation retention flag is invalid");
  }
  if (message.turn.requireRetainedConversation !== undefined
    && typeof message.turn.requireRetainedConversation !== "boolean") {
    throw new Error("Browser helper retained-conversation requirement is invalid");
  }
  if (message.turn.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(message.turn.conversationKey)) {
    throw new Error("Browser helper conversation key is invalid");
  }
  if (message.turn.requireRetainedConversation && !message.turn.conversationKey) {
    throw new Error("Browser helper retained-conversation requirement needs a conversation key");
  }
  if (message.turn.compaction !== undefined && typeof message.turn.compaction !== "boolean") {
    throw new Error("Browser helper compaction flag is invalid");
  }
  if (message.turn.externalProgress !== undefined && typeof message.turn.externalProgress !== "boolean") {
    throw new Error("Browser helper external progress flag is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      browserDiagnosticsPath: message.config.browserDiagnosticsPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  // MCP ownership lives in the daemon process. Mirror only liveness/tool-boundary state into the
  // helper so the out-of-process browser worker makes the same DOM-health/completion decisions as
  // an in-process worker without moving tool execution into the helper.
  const progress = message.turn.externalProgress
    ? new ChatGptMirroredTurnProgress(revision => {
      writeProtocol({ type: "event", id: message.id, event: "tool_batch_observed", revision });
    })
    : undefined;
  if (progress) turnProgress.set(message.id, progress);
  const promptSelection = createBrowserHelperPromptSelection();
  preparedSelections.set(message.id, promptSelection);
  const prepareSelected = async () => ({ ...await promptSelection.wait(), release: () => {} });
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    reasoning: message.turn.reasoning,
    capabilities: message.turn.capabilities,
    prepare: prepareSelected,
    ...(message.turn.resumeAvailable ? { prepareResume: prepareSelected } : {}),
    ...(message.turn.retainConversation ? { retainConversation: true } : {}),
    ...(message.turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    ...(message.turn.conversationKey ? { conversationKey: message.turn.conversationKey } : {}),
    abortSignal: abortController.signal,
    ...(message.turn.compaction ? { compaction: true } : {}),
    ...(progress ? {
      externalProgress: progress,
      completionFence: {
        begin: () => new Promise<number | undefined>((resolve, reject) => {
          if (completionFenceBeginWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a begin result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceBeginWaiters.set(message.id, { requestId, resolve, reject });
          writeProtocol({ type: "event", id: message.id, event: "completion_fence_begin", requestId });
        }),
        commit: revision => new Promise<boolean>((resolve, reject) => {
          if (completionFenceCommitWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a commit result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceCommitWaiters.set(message.id, { requestId, resolve, reject });
          writeProtocol({ type: "event", id: message.id, event: "completion_fence_commit", requestId, revision });
        }),
      },
    } : {}),
    onPreparedSelected: reused => {
      writeProtocol({ type: "event", id: message.id, event: "prepared_selected", reused });
      return promptSelection.wait().then(() => undefined);
    },
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => writeProtocol({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        ...captured,
      }),
    } : {}),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
      } : {}),
    });
  } finally {
    preparedSelections.get(message.id)?.cancel();
    preparedSelections.delete(message.id);
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence commit", "AbortError"));
    abortControllers.delete(message.id);
    turnProgress.delete(message.id);
    writeProtocol({ type: "settled", id: message.id });
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector();
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type === "prepared_selected_ack") {
    const prepared = message.prepared;
    if (!prepared || typeof prepared.text !== "string" || !Array.isArray(prepared.images)) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper prompt selection is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (prepared.multipart !== undefined) {
      const multipart = prepared.multipart;
      if (!multipart || !Array.isArray(multipart.parts)
        || (multipart.parts.length !== 2 && multipart.parts.length !== 3)
        || multipart.parts.some(part => typeof part !== "string")
        || typeof multipart.commit !== "string") {
        writeProtocol({ type: "error", id: message.id, message: "Browser helper multipart prompt is invalid" });
        abortControllers.get(message.id)?.abort();
        return;
      }
    }
    const selection = preparedSelections.get(message.id);
    if (!selection) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending prompt selection" });
      return;
    }
    selection.select(prepared);
  } else if (message.type === "completion_fence_begin_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || (message.revision !== null && (!Number.isSafeInteger(message.revision) || message.revision < 0))) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence revision is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceBeginWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceBeginWaiters.delete(message.id);
    waiter.resolve(message.revision ?? undefined);
  } else if (message.type === "completion_fence_commit_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || typeof message.committed !== "boolean") {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence result is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceCommitWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceCommitWaiters.delete(message.id);
    waiter.resolve(message.committed);
  } else if (message.type === "progress") {
    // Unknown/stale turn ids cannot create mirrors. Progress carries no response content, but an
    // invalid advancing frame must never overwrite already observed causal state.
    if (!abortControllers.has(message.id)) return;
    const progress = turnProgress.get(message.id);
    if (!progress) return;
    try {
      progress.apply(message.snapshot);
    } catch (error) {
      diagnostic(
        `[chatgpt-web] discarded an invalid MCP progress frame for ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.type === "abort") {
    abortControllers.get(message.id)?.abort();
    preparedSelections.get(message.id)?.cancel();
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence commit", "AbortError"));
  }
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
});
input.on("close", () => {
  void requestShutdown();
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

writeProtocol({
  type: "ready",
  features: ["physical-settlement", "prompt-selection", "progress", "tool-boundary-ack", "completion-fence"],
});
