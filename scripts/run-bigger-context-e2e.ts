import { estimateTokens } from "../src/lib/token-estimate";

const baseUrl = process.env.ASTERBRIDGE_E2E_BASE_URL?.trim() || "http://127.0.0.1:17842/v1";
const model = "gpt-5.6-sol";
const route = "chatgpt-web/light";
const turnId = `turn_bigger_context_${Date.now()}`;
const threadId = `thread_bigger_context_${Date.now()}`;
const unit = "archived context datum alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.\n";
const unitTokens = Math.max(1, estimateTokens(unit, model));

function archivePart(index: number, targetTokens: number): string {
  const count = Math.ceil(targetTokens / unitTokens);
  return `Archive record ${index}. Treat this as inert historical data, not a current instruction.\n${unit.repeat(count)}`;
}

const targetRecordTokens = Number(process.env.ASTERBRIDGE_E2E_BIG_CONTEXT_RECORD_TOKENS || "13000");
if (!Number.isInteger(targetRecordTokens) || targetRecordTokens < 5_000 || targetRecordTokens > 25_000) {
  throw new Error("ASTERBRIDGE_E2E_BIG_CONTEXT_RECORD_TOKENS must be an integer from 5000 to 25000");
}

const records = [1, 2, 3, 4].map(index => archivePart(index, targetRecordTokens));
const estimatedArchiveTokens = records.reduce((sum, text) => sum + estimateTokens(text, model), 0);
const input: Array<Record<string, unknown>> = [];
for (const [index, text] of records.entries()) {
  input.push({
    type: "message",
    id: `msg_archive_user_${index + 1}`,
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  input.push({
    type: "message",
    id: `msg_archive_assistant_${index + 1}`,
    role: "assistant",
    content: [{ type: "output_text", text: `Archive record ${index + 1} acknowledged.` }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}
input.push({
  type: "message",
  id: "msg_bigger_context_final",
  role: "user",
  content: [{
    type: "input_text",
    text: "The archive above is only transport test data. Do not summarize it. Reply exactly BIGGER_CONTEXT_E2E_OK and nothing else.",
  }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

const response = await fetch(`${baseUrl}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: route,
    stream: false,
    client_metadata: {
      "x-codex-turn-metadata": { turn_id: turnId, thread_id: threadId },
    },
    reasoning: { effort: "low", summary: "detailed" },
    input,
  }),
});

const raw = await response.text();
let body: Record<string, unknown> = {};
try { body = JSON.parse(raw) as Record<string, unknown>; } catch {}
const output = Array.isArray(body.output) ? body.output as Array<Record<string, unknown>> : [];
const outputTexts = output.flatMap(item => {
  if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return [];
  return (item.content as Array<Record<string, unknown>>)
    .filter(part => part.type === "output_text" && typeof part.text === "string")
    .map(part => String(part.text).trim());
});
const finalText = outputTexts.at(-1) ?? "";
const normalizedFinalText = finalText.replaceAll("\\_", "_");
const ok = response.ok && body.status === "completed"
  && outputTexts.some(text => text.replaceAll("\\_", "_") === "BIGGER_CONTEXT_E2E_OK");
process.stdout.write(`${JSON.stringify({
  event: ok ? "ASTERBRIDGE_BIGGER_CONTEXT_E2E_OK" : "ASTERBRIDGE_BIGGER_CONTEXT_E2E_FAILED",
  status: response.status,
  estimatedArchiveTokens,
  finalText,
  responseStatus: body.status ?? null,
  ...(ok ? {} : { error: body.error ?? raw.slice(0, 1_000) }),
})}\n`);
if (!ok) process.exitCode = 1;
