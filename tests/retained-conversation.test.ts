import { expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptPhysicalTaskSurfacePlan } from "../src/adapters/chatgpt-web/browser-worker";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

function request(turnId: string, input: unknown[] = []): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
        { role: "developer", content: "new constraint", timestamp: 3 },
        { role: "user", content: "second", timestamp: 4 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": { thread_id: "thread-retained", turn_id: turnId },
      },
      input,
    },
  };
}

test("conversation identity survives native turn ids but changes at compaction boundaries", () => {
  const first = request("turn-a");
  const second = request("turn-b");
  expect(chatGptConversationKey(first, "provider-a")).toBe(chatGptConversationKey(second, "provider-a"));

  const compacted = request("turn-c", [
    { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
    { type: "compaction", id: "cmp-1", encrypted_content: "opaque" },
  ]);
  expect(chatGptConversationKey(compacted, "provider-a")).not.toBe(chatGptConversationKey(first, "provider-a"));
  expect(chatGptConversationKey(first, "provider-b")).not.toBe(chatGptConversationKey(first, "provider-a"));
});

test("retained continuation sends only the canonical suffix after the last assistant reply", () => {
  const parsed = request("turn-b");
  const resumed = retainedConversationResumeRequest(parsed);
  expect(resumed).toBeDefined();
  expect(resumed!.context.messages).toEqual([
    { role: "developer", content: "new constraint", timestamp: 3 },
    { role: "user", content: "second", timestamp: 4 },
  ]);
  expect(resumed!.context.tools).toBe(parsed.context.tools);
  expect(resumed!._rawBody).toBe(parsed._rawBody);
});

test("retained continuation is unavailable before any prior assistant reply", () => {
  const parsed = request("turn-a");
  parsed.context.messages = [{ role: "user", content: "first", timestamp: 1 }];
  expect(retainedConversationResumeRequest(parsed)).toBeUndefined();
});

test("physical surface accounting deduplicates retained conversations and rejects only new slots", () => {
  expect(chatGptPhysicalTaskSurfacePlan(
    ["a", "b", "c", "d"],
    ["a", undefined],
    "a",
  )).toEqual({ occupied: 5, needsNewPhysicalSlot: false });
  expect(chatGptPhysicalTaskSurfacePlan(
    ["a", "b", "c", "d"],
    ["a", undefined],
    "e",
  )).toEqual({ occupied: 5, needsNewPhysicalSlot: true });
});

test("only the current conversation head may release a retained browser page", async () => {
  const sessions = new ChatGptTurnSessions();
  let releaseCount = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: Promise.resolve("ok"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "conversation-a",
    releaseRetainedConversation: async () => { releaseCount += 1; },
    cancel: () => {},
  });
  const first = sessions.getOrCreate("turn-1", runtime);
  const second = sessions.getOrCreate("turn-2", runtime);
  expect(sessions.findConversationHead("conversation-a")).toBe(second);

  expect(sessions.retire("turn-1", first)).toBe(true);
  await Promise.resolve();
  expect(releaseCount).toBe(0);

  expect(await sessions.retireAndWait("turn-2")).toBe(true);
  expect(releaseCount).toBe(1);
});

test("conversation retirement releases one retained page after all epoch sessions settle", async () => {
  const sessions = new ChatGptTurnSessions();
  let releaseCount = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: Promise.resolve("ok"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "conversation-b",
    releaseRetainedConversation: async () => { releaseCount += 1; },
    cancel: () => {},
  });
  sessions.getOrCreate("turn-1", runtime);
  sessions.getOrCreate("turn-2", runtime);
  expect(await sessions.retireConversationAndWait("conversation-b")).toBe(2);
  expect(releaseCount).toBe(1);
  expect(sessions.findConversationHead("conversation-b")).toBeUndefined();
});
