import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import {
  boundedCodexToolArguments,
  CODEX_IMAGE_GEN_WIRE_NAME,
  CODEX_SUBAGENT_WAIT_POLL_MS,
  CODEX_SUBAGENT_WAIT_WIRE_NAME,
} from "../src/adapters/chatgpt-web/mcp-server";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

function nativeCatalog() {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        multi_agent_version: "v2",
        tool_mode: "code_mode_only",
        supported_reasoning_levels: [{ effort: "high", description: "High" }],
      },
      {
        slug: "gpt-5.5",
        display_name: "5.5",
        visibility: "list",
        supported_in_api: true,
        priority: 2,
        multi_agent_version: "disabled",
        tool_mode: "code_mode_only",
        supported_reasoning_levels: [{ effort: "high", description: "High" }],
      },
    ],
  };
}

test("compatibility-v1 remains the default routed subagent protocol", () => {
  const config = defaultConfig("full");
  expect(config.subagentProtocol).toBe("compatibility-v1");
  const models = augmentNativeModelCatalog(nativeCatalog(), config).models as Array<Record<string, unknown>>;
  expect(models.find(model => model.slug === "gpt-5.6-sol")?.multi_agent_version).toBe("v1");
  expect(models.find(model => model.slug === "gpt-5.5")?.multi_agent_version).toBe("disabled");
  expect(models.filter(model => String(model.slug).startsWith("chatgpt-web/"))
    .every(model => model.multi_agent_version === "v1")).toBe(true);
});

test("native protocol preserves native Codex agent versions without making Web routes opaque", () => {
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  const models = augmentNativeModelCatalog(nativeCatalog(), config).models as Array<Record<string, unknown>>;
  expect(models.find(model => model.slug === "gpt-5.6-sol")?.multi_agent_version).toBe("v2");
  expect(models.find(model => model.slug === "gpt-5.5")?.multi_agent_version).toBe("disabled");
  expect(models.filter(model => String(model.slug).startsWith("chatgpt-web/"))
    .every(model => model.multi_agent_version === "v1")).toBe(true);
});

test("closing a subagent thread releases only that retained conversation", async () => {
  const sessions = new ChatGptTurnSessions();
  let childReleases = 0;
  let parentReleases = 0;
  sessions.getOrCreate("parent-turn", () => ({
    mode: "tools",
    token: Promise.resolve("parent-token"),
    browser: Promise.resolve("parent"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    threadId: "parent-thread",
    conversationKey: "parent-conversation",
    releaseRetainedConversation: async () => { parentReleases += 1; },
    cancel: () => {},
  }));
  sessions.getOrCreate("child-turn", () => ({
    mode: "tools",
    token: Promise.resolve("child-token"),
    browser: Promise.resolve("child"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    threadId: "child-thread",
    conversationKey: "child-conversation",
    releaseRetainedConversation: async () => { childReleases += 1; },
    cancel: () => {},
  }));

  expect(await sessions.retireThreadAndWait("child-thread")).toBe(1);
  expect(childReleases).toBe(1);
  expect(parentReleases).toBe(0);
  expect(sessions.findConversationHead("child-conversation")).toBeUndefined();
  expect(sessions.findConversationHead("parent-conversation")).toBeDefined();
});

test("Web subagent waits are bounded to short polling without touching unrelated wait tools", () => {
  expect(boundedCodexToolArguments(CODEX_SUBAGENT_WAIT_WIRE_NAME, { ids: ["agent-1"] })).toEqual({
    ids: ["agent-1"],
    timeout_ms: CODEX_SUBAGENT_WAIT_POLL_MS,
  });
  expect(boundedCodexToolArguments(CODEX_SUBAGENT_WAIT_WIRE_NAME, {
    ids: ["agent-1"],
    timeout_ms: 30_000,
  })).toEqual({ ids: ["agent-1"], timeout_ms: CODEX_SUBAGENT_WAIT_POLL_MS });
  expect(boundedCodexToolArguments(CODEX_SUBAGENT_WAIT_WIRE_NAME, {
    ids: ["agent-1"],
    timeout_ms: 4_000,
  })).toEqual({ ids: ["agent-1"], timeout_ms: 4_000 });
  const unrelated = { session_id: "shell-1", timeout_ms: 60_000 };
  expect(boundedCodexToolArguments("functions__wait", unrelated)).toBe(unrelated);
});

test("image generation drops impossible history-image arguments and bounds real ones", () => {
  expect(boundedCodexToolArguments(CODEX_IMAGE_GEN_WIRE_NAME, {
    prompt: "draw a bridge",
    referenced_image_paths: [],
    num_last_images_to_include: 1,
  }, 0)).toEqual({ prompt: "draw a bridge" });

  expect(boundedCodexToolArguments(CODEX_IMAGE_GEN_WIRE_NAME, {
    prompt: "edit the latest image",
    num_last_images_to_include: 9,
  }, 2)).toEqual({
    prompt: "edit the latest image",
    num_last_images_to_include: 2,
  });

  expect(boundedCodexToolArguments(CODEX_IMAGE_GEN_WIRE_NAME, {
    prompt: "edit local reference",
    referenced_image_paths: ["C:/tmp/reference.png"],
    num_last_images_to_include: 0,
  }, 0)).toEqual({
    prompt: "edit local reference",
    referenced_image_paths: ["C:/tmp/reference.png"],
  });
});
