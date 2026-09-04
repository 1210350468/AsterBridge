import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codexBin = process.env.ASTERBRIDGE_CODEX_BIN?.trim();
const requestedThreadId = process.env.ASTERBRIDGE_CODEX_THREAD_ID?.trim();
const createThread = process.env.ASTERBRIDGE_CODEX_CREATE_THREAD === "1";
const requestedModel = process.env.ASTERBRIDGE_CODEX_MODEL?.trim() || "chatgpt-web/light";
const remoteCompactionV2 = process.env.ASTERBRIDGE_REMOTE_COMPACTION_V2?.trim();
const baseUrl = process.env.ASTERBRIDGE_E2E_BASE_URL?.trim();
const compactTimeoutMs = Number.parseInt(process.env.ASTERBRIDGE_COMPACT_E2E_TIMEOUT_MS ?? "180000", 10);
if (!Number.isSafeInteger(compactTimeoutMs) || compactTimeoutMs < 10_000 || compactTimeoutMs > 600_000) {
  throw new Error("ASTERBRIDGE_COMPACT_E2E_TIMEOUT_MS must be an integer between 10000 and 600000");
}
if (!codexBin) throw new Error("ASTERBRIDGE_CODEX_BIN is required");
if (!createThread && !requestedThreadId) throw new Error("ASTERBRIDGE_CODEX_THREAD_ID is required unless ASTERBRIDGE_CODEX_CREATE_THREAD=1");
let threadId = requestedThreadId ?? "";

const appServerArgs = ["app-server", "--listen", "stdio://"];
if (baseUrl) appServerArgs.push("-c", `openai_base_url=${JSON.stringify(baseUrl)}`);
if (remoteCompactionV2 === "true" || remoteCompactionV2 === "false") {
  appServerArgs.push("-c", `features.remote_compaction_v2=${remoteCompactionV2}`);
}
const child = spawn(codexBin, appServerArgs, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let requestId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const notifications: unknown[] = [];
const stdout = createInterface({ input: child.stdout });
const stderr = createInterface({ input: child.stderr });

function send(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++requestId;
  const line = JSON.stringify({ id, method, params });
  child.stdin.write(`${line}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

stdout.on("line", line => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message?.id === "number" && pending.has(message.id)) {
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  notifications.push(message);
});

stderr.on("line", line => {
  if (/authorization|bearer|runtime[_ -]?key|tunnel[_ -]?id/i.test(line)) return;
  process.stderr.write(`[codex-app-server] ${line}\n`);
});

const exited = new Promise<never>((_, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => reject(new Error(`Codex app-server exited early: code=${code} signal=${signal}`)));
});

async function waitForTurnCompletion(targetThreadId: string, afterIndex: number, timeoutMs = 180_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = afterIndex; index < notifications.length; index += 1) {
      const message = notifications[index] as any;
      if (message?.method === "turn/completed" && message?.params?.threadId === targetThreadId) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Codex turn completion");
}

async function runTextTurn(text: string): Promise<any> {
  const startIndex = notifications.length;
  await Promise.race([send("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  }), exited]);
  return Promise.race([waitForTurnCompletion(threadId, startIndex), exited]);
}

async function waitForCompaction(afterIndex: number, timeoutMs = compactTimeoutMs): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = afterIndex; index < notifications.length; index += 1) {
      const message = notifications[index] as any;
      const method = message?.method;
      const params = message?.params;
      if (method === "item/completed" && params?.threadId === threadId && params?.item?.type === "contextCompaction") {
        return message;
      }
      if (method === "thread/compacted" && params?.threadId === threadId) return message;
      if (method === "turn/completed" && params?.threadId === threadId) {
        const compaction = (notifications as any[]).find(candidate => (
          candidate?.method === "item/completed"
          && candidate?.params?.threadId === threadId
          && candidate?.params?.item?.type === "contextCompaction"
        ));
        if (compaction) return compaction;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const recent = (notifications as any[]).slice(afterIndex).map(message => ({
    method: message?.method ?? null,
    itemType: message?.params?.item?.type ?? null,
    turnStatus: message?.params?.turn?.status ?? null,
  }));
  throw new Error(`Timed out waiting for native Codex compaction completion; events=${JSON.stringify(recent.slice(-40))}`);
}

try {
  await Promise.race([
    send("initialize", {
      clientInfo: { name: "asterbridge-compaction-e2e", version: "1.0.0" },
      capabilities: null,
    }),
    exited,
  ]);
  if (createThread) {
    const started = await Promise.race([send("thread/start", {
      model: requestedModel,
      cwd: process.cwd(),
    }), exited]) as any;
    threadId = started?.thread?.id ?? "";
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    await runTextTurn("Reply exactly SAME_OWNER_COMPACT_FIRST_OK. Do not use tools.");
    await runTextTurn("Reply exactly SAME_OWNER_COMPACT_SECOND_OK. Do not use tools.");
  } else {
    await Promise.race([send("thread/resume", { threadId }), exited]);
  }
  const compactStartIndex = notifications.length;
  await Promise.race([send("thread/compact/start", { threadId }), exited]);
  const completed = await Promise.race([waitForCompaction(compactStartIndex), exited]);
  // Codex 0.150 can emit the compaction item before the Compact turn itself becomes terminal.
  // Wait for the matching post-request turn/completed notification before sending any new input.
  await Promise.race([waitForTurnCompletion(threadId, compactStartIndex), exited]);
  if (createThread) await runTextTurn("Reply exactly SAME_OWNER_POST_COMPACTION_OK. Do not use tools.");
  process.stdout.write(`${JSON.stringify({
    event: "ASTERBRIDGE_CODEX_COMPACTION_OK",
    threadId,
    notification: completed?.method ?? "item/completed",
    itemType: completed?.params?.item?.type ?? "contextCompaction",
    sameOwner: createThread,
  })}\n`);
} finally {
  child.stdin.end();
  child.kill();
}
