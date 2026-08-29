import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codexBin = process.env.ASTERBRIDGE_CODEX_BIN?.trim();
const threadId = process.env.ASTERBRIDGE_CODEX_THREAD_ID?.trim();
if (!codexBin) throw new Error("ASTERBRIDGE_CODEX_BIN is required");
if (!threadId) throw new Error("ASTERBRIDGE_CODEX_THREAD_ID is required");

const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
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

async function waitForCompaction(timeoutMs = 180_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const message of notifications as any[]) {
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
  throw new Error("Timed out waiting for native Codex compaction completion");
}

try {
  await Promise.race([
    send("initialize", {
      clientInfo: { name: "asterbridge-compaction-e2e", version: "1.0.0" },
      capabilities: null,
    }),
    exited,
  ]);
  await Promise.race([send("thread/resume", { threadId }), exited]);
  await Promise.race([send("thread/compact/start", { threadId }), exited]);
  const completed = await Promise.race([waitForCompaction(), exited]);
  process.stdout.write(`${JSON.stringify({
    event: "ASTERBRIDGE_CODEX_COMPACTION_OK",
    threadId,
    notification: completed?.method ?? "item/completed",
    itemType: completed?.params?.item?.type ?? "contextCompaction",
  })}\n`);
} finally {
  child.stdin.end();
  child.kill();
}
