import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const codexHome = process.env.ASTERBRIDGE_CODEX_E2E_HOME?.trim();
if (!codexHome || !existsSync(codexHome)) throw new Error("ASTERBRIDGE_CODEX_E2E_HOME is required");
const codexExe = process.env.ASTERBRIDGE_CODEX_EXE?.trim() || Bun.which("codex") || "";
if (!codexExe || !existsSync(codexExe)) {
  throw new Error("Codex executable is missing; set ASTERBRIDGE_CODEX_EXE or add codex to PATH");
}

const mode = process.argv[2] ?? "single";
const prompt = mode === "nested"
  ? "Use Codex Multi-agent V1 to perform a real nested-agent test. Discover deferred Multi-agent V1 tools with tool_search if needed. Spawn exactly one child. Tell that child to spawn exactly one grandchild whose only task is to return GRANDCHILD_AGENT_OK without tools; the child must wait for the grandchild, verify that exact result, close it, then return CHILD_NESTED_OK. The parent must wait for the child with short wait_agent polls, verify CHILD_NESTED_OK, close the child, and finally answer exactly SUBAGENT_NESTED_E2E_OK. Do not use shell commands for this test."
  : "Use Codex Multi-agent V1 to perform a real subagent test. Discover deferred Multi-agent V1 tools with tool_search if needed. Spawn exactly one child whose only task is to return CHILD_AGENT_OK without tools. Poll the child with short wait_agent calls until complete, verify that exact result, close the child, and finally answer exactly SUBAGENT_E2E_OK. Do not use shell commands for this test.";

const expected = mode === "nested" ? "SUBAGENT_NESTED_E2E_OK" : "SUBAGENT_E2E_OK";
const baseUrl = process.env.ASTERBRIDGE_E2E_BASE_URL?.trim() || "http://127.0.0.1:17842/v1";
const childExpected = mode === "nested" ? "CHILD_NESTED_OK" : "CHILD_AGENT_OK";

const child = Bun.spawn([
  codexExe,
  "exec",
  "--json",
  "--skip-git-repo-check",
  "-m",
  "chatgpt-web/light",
  "-c",
  `openai_base_url=${JSON.stringify(baseUrl)}`,
  "-c",
  "agents.max_depth=2",
  prompt,
], {
  cwd: resolve(import.meta.dir, ".."),
  env: { ...process.env, CODEX_HOME: codexHome },
  stdout: "pipe",
  stderr: "pipe",
});

const timeoutMs = 240_000;
const timeout = setTimeout(() => child.kill(), timeoutMs);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
clearTimeout(timeout);

const lines = stdout.split(/\r?\n/).filter(Boolean);
let finalMessage = "";
let taskError = "";
for (const line of lines) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") finalMessage = item.text;
    }
    if (event.type === "turn.failed" || event.type === "error") taskError = line;
  } catch {}
}

const sessionRoot = join(codexHome, "sessions");
let childEvidence = false;
if (existsSync(sessionRoot)) {
  const stack = [sessionRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".jsonl")) {
        const content = readFileSync(path, "utf8");
        if (content.includes(childExpected)) childEvidence = true;
      }
    }
  }
}

const ok = exitCode === 0 && finalMessage.replaceAll("\\_", "_").trim() === expected && childEvidence;
process.stdout.write(`${JSON.stringify({
  event: ok ? "ASTERBRIDGE_SUBAGENT_E2E_OK" : "ASTERBRIDGE_SUBAGENT_E2E_FAILED",
  mode,
  exitCode,
  finalMessage,
  childEvidence,
  stderrTail: stderr.trim().split(/\r?\n/).slice(-4),
  ...(taskError ? { taskError } : {}),
})}\n`);
if (!ok) process.exitCode = 1;
