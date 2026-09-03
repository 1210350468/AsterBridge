import { expect, test } from "bun:test";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  planCompactV1Budget,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";
import { estimateTokens } from "../src/lib/token-estimate";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("v1 compaction keeps only the newest ten structured images without copying them into text", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  const imageUrls = retained.flatMap(item => item.content
    .filter(block => block.type === "input_image")
    .map(block => block.image_url));
  expect(imageUrls).toEqual(input.slice(2).map(item => item.content[1]!.image_url));
  expect(retained.flatMap(item => item.content)
    .filter(block => block.type === "input_text")
    .every(block => !block.text?.includes("data:image"))).toBe(true);
  expect(retained.at(-1)?.content.at(-1)).toMatchObject({ detail: "high" });
});

test("Instant compaction reserves stable harness and post-compact headroom before retaining history", () => {
  const plan = planCompactV1Budget(32_000, "small checkpoint", {
    model: "chatgpt-web/light",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "current request" }] }],
  });

  expect(plan.stableHarnessReserveTokens).toBe(17_000);
  expect(plan.postCompactHeadroomTokens).toBe(6_000);
  expect(plan.retainedHistoryTokenBudget).toBeLessThan(8_500);
  expect(
    plan.stableHarnessReserveTokens
      + plan.postCompactHeadroomTokens
      + plan.summaryTokens
      + plan.structureReserveTokens
      + plan.retainedHistoryTokenBudget,
  ).toBeLessThanOrEqual(32_000);
});

test("compaction grows the stable-harness reserve when the request exposes larger instructions and tools", () => {
  const plan = planCompactV1Budget(80_000, "checkpoint", {
    instructions: "developer-policy ".repeat(12_000),
    tools: [{
      type: "function",
      name: "large_tool",
      description: "schema ".repeat(4_000),
      parameters: { type: "object", properties: {} },
    }],
    input: [],
  });

  expect(plan.stableHarnessReserveTokens).toBeGreaterThan(17_000);
  expect(plan.retainedHistoryTokenBudget).toBeLessThanOrEqual(20_000);
});

test("model-aware v1 history charges retained images against the same token budget", () => {
  const input = [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "recent text ".repeat(2_000) },
      { type: "input_image", image_url: "data:image/png;base64,newest-image", detail: "high" },
    ],
  }];
  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint", {
    retainedHistoryTokenBudget: 5_000,
  });
  const retained = output[0] as { content: Array<{ type: string; text?: string; image_url?: string }> };
  const images = retained.content.filter(block => block.type === "input_image");
  const text = retained.content.filter(block => block.type === "input_text").map(block => block.text ?? "").join("");

  expect(images).toHaveLength(1);
  expect(images[0]!.image_url).toBe("data:image/png;base64,newest-image");
  expect(estimateTokens(text)).toBeLessThanOrEqual(904);
});

test("model-aware v1 history truncates token-dense text by tokens rather than character ratio", () => {
  const dense = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4_000);
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: dense }],
  }]), "checkpoint", { retainedHistoryTokenBudget: 1_000 });
  const retainedText = (output[0] as { content: Array<{ text?: string }> }).content[0]!.text ?? "";

  expect(estimateTokens(retainedText)).toBeLessThanOrEqual(1_000);
  expect(retainedText.length).toBeLessThan(dense.length);
  expect(dense.endsWith(retainedText)).toBe(true);
});

test("v1 compaction drops persisted one-pixel image sentinels", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).toContain("data:image/png;base64,real-image");
});
