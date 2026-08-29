import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../src/adapters/chatgpt-web/native-compaction-control";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

test("compaction transactions are one-shot, scoped, and validate the handoff id", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace-compaction", 10_000);
  expect(() => store.submit(transaction.token, "wrong-handoff", "summary")).toThrow("handoff id");
  const waiting = store.wait(transaction.token);
  store.submit(transaction.token, transaction.handoffId, "  canonical checkpoint  ");
  expect(await waiting).toBe("canonical checkpoint");
  await expect(store.wait(transaction.token)).rejects.toThrow("invalid, expired, or consumed");
  store.close();
});

test("Codex Native3 generic tool_call can submit a one-shot compaction handoff without a normal turn binding", async () => {
  const socketPath = brokerTestEndpoint(`cgw-compaction-control-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const transaction = await broker.beginCompactionTransaction("trace-compaction-control", 30_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "compaction-control-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const waiting = broker.waitForCompactionHandoff(transaction.token);
    const submitted = await client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: transaction.token,
        wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
        arguments: {
          handoff_id: transaction.handoffId,
          summary: "retained agent checkpoint",
        },
      },
    });
    expect(submitted.structuredContent).toEqual({ submitted: true });
    expect(await waiting).toBe("retained agent checkpoint");

    const ordinary = await client.callTool({
      name: "codex_exec",
      arguments: {
        turn_token: transaction.token,
        cmd: "echo must-not-run",
      },
    });
    expect(ordinary.isError).toBe(true);
    expect(JSON.stringify(ordinary.content)).toContain("invalid");
  } finally {
    await client.close().catch(() => {});
    broker.abortCompactionTransaction(transaction.token);
    await broker.close();
  }
}, 30_000);
