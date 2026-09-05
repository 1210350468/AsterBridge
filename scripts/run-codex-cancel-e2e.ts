import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codexBin = process.env.ASTERBRIDGE_CODEX_BIN?.trim();
const baseUrl = process.env.ASTERBRIDGE_E2E_BASE_URL?.trim();
const healthUrl = process.env.ASTERBRIDGE_E2E_HEALTH_URL?.trim()
  || (baseUrl ? `${baseUrl.replace(/\/v1\/?$/, "")}/healthz` : "");
const model = process.env.ASTERBRIDGE_CODEX_MODEL?.trim() || "chatgpt-web/light";
const timeoutMs = Number.parseInt(process.env.ASTERBRIDGE_CANCEL_E2E_TIMEOUT_MS ?? "90000", 10);
const interruptDelayMs = Number.parseInt(process.env.ASTERBRIDGE_CANCEL_E2E_INTERRUPT_DELAY_MS ?? "10000", 10);
if (!codexBin) throw new Error("ASTERBRIDGE_CODEX_BIN is required");
if (!baseUrl) throw new Error("ASTERBRIDGE_E2E_BASE_URL is required");
if (!healthUrl) throw new Error("ASTERBRIDGE_E2E_HEALTH_URL is required when the base URL cannot derive /healthz");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 300_000) {
  throw new Error("ASTERBRIDGE_CANCEL_E2E_TIMEOUT_MS must be an integer between 10000 and 300000");
}
if (!Number.isSafeInteger(interruptDelayMs) || interruptDelayMs < 500 || interruptDelayMs > 30_000) {
  throw new Error("ASTERBRIDGE_CANCEL_E2E_INTERRUPT_DELAY_MS must be an integer between 500 and 30000");
}

const child = spawn(codexBin, [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  `openai_base_url=${JSON.stringify(baseUrl)}`,
], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let requestId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const notifications: any[] = [];
const stdout = createInterface({ input: child.stdout });
const stderr = createInterface({ input: child.stderr });

function send(method: string, params: Record<string, unknown>): Promise<any> {
  const id = ++requestId;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

stdout.on("line", line => {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
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

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout, exited]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function health(): Promise<{ active_http_turns: number; active_browser_turns: number }> {
  const response = await fetch(healthUrl);
  if (!response.ok) throw new Error(`Bridge health failed with HTTP ${response.status}`);
  return response.json() as Promise<{ active_http_turns: number; active_browser_turns: number }>;
}

async function waitForHealth(predicate: (value: { active_http_turns: number; active_browser_turns: number }) => boolean, label: string) {
  const deadline = Date.now() + timeoutMs;
  let last = await health();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
    last = await health();
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function waitForTurnCompletion(threadId: string, turnId: string, afterIndex: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = afterIndex; index < notifications.length; index += 1) {
      const message = notifications[index];
      if (message?.method !== "turn/completed" || message?.params?.threadId !== threadId) continue;
      const completedId = message?.params?.turn?.id ?? message?.params?.turnId;
      if (!completedId || completedId === turnId) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for turn/completed for ${turnId}`);
}

async function runFollowup(threadId: string): Promise<{ turnId: string; completed: any }> {
  const startIndex = notifications.length;
  const started = await withTimeout(send("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply exactly POST_INTERRUPT_OK. Do not use tools." }],
  }), "follow-up turn/start");
  const turnId = started?.turn?.id;
  if (!turnId) throw new Error("Follow-up turn/start did not return a turn id");
  const completed = await withTimeout(waitForTurnCompletion(threadId, turnId, startIndex), "follow-up turn/completed");
  return { turnId, completed };
}

try {
  await withTimeout(send("initialize", {
    clientInfo: { name: "asterbridge-cancel-e2e", version: "1.0.0" },
    capabilities: null,
  }), "initialize");
  const startedThread = await withTimeout(send("thread/start", { model, cwd: process.cwd() }), "thread/start");
  const threadId = startedThread?.thread?.id;
  if (!threadId) throw new Error("Codex app-server did not return a thread id");

  const interruptStartIndex = notifications.length;
  const startedTurn = await withTimeout(send("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Write the integers 1 through 2000, one number per line. Do not use tools and do not stop early.",
    }],
  }), "interrupt target turn/start");
  const turnId = startedTurn?.turn?.id;
  if (!turnId) throw new Error("Interrupt target turn/start did not return a turn id");

  const active = await waitForHealth(value => value.active_browser_turns > 0, "browser turn activation");
  process.stderr.write(`[cancel-e2e] active before interrupt http=${active.active_http_turns} browser=${active.active_browser_turns}\n`);
  await new Promise(resolve => setTimeout(resolve, interruptDelayMs));

  process.stderr.write(`[cancel-e2e] requesting turn/interrupt turn=${turnId} delayMs=${interruptDelayMs}\n`);
  const interrupt = send("turn/interrupt", { threadId, turnId });
  await new Promise(resolve => setTimeout(resolve, 500));
  process.stderr.write("[cancel-e2e] starting same-thread follow-up while interrupt cleanup is pending\n");
  const followup = await runFollowup(threadId);
  await withTimeout(interrupt, "turn/interrupt");
  await withTimeout(waitForTurnCompletion(threadId, turnId, interruptStartIndex), "interrupted turn/completed").catch(() => undefined);
  const idle = await waitForHealth(
    value => value.active_http_turns === 0 && value.active_browser_turns === 0,
    "bridge cancellation cleanup",
  );
  const finalIdle = await waitForHealth(
    value => value.active_http_turns === 0 && value.active_browser_turns === 0,
    "post-interrupt follow-up cleanup",
  );
  process.stdout.write(`${JSON.stringify({
    event: "ASTERBRIDGE_CODEX_CANCEL_OK",
    threadId,
    interruptedTurnId: turnId,
    followupTurnId: followup.turnId,
    idleAfterInterrupt: idle,
    idleAfterFollowup: finalIdle,
  })}\n`);
} finally {
  child.stdin.end();
  child.kill();
}
