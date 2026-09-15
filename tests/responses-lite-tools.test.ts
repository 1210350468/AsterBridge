import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const freeformFormat = {
  type: "grammar",
  syntax: "lark",
  definition: 'start: "tool"',
};

function responsesLiteTools() {
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run native Codex code", format: freeformFormat },
      {
        type: "function",
        name: "wait",
        description: "Wait for native Codex code",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ],
  }, {
    type: "namespace",
    name: "mcp__python",
    description: "Python tools",
    tools: [{
      type: "custom",
      name: "run_script",
      description: "Run a Python script",
      format: freeformFormat,
    }],
  }];
}

test("Responses Lite exposes native exec from the default functions namespace only", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: responsesLiteTools() }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    name: "exec",
    freeform: true,
  }));
  const waitTool = parsed.context.tools?.find(tool => tool.name === "wait");
  expect(waitTool).toEqual(expect.objectContaining({ name: "wait" }));
  expect(waitTool).not.toHaveProperty("namespace");
  expect(parsed.context.tools?.some(tool => tool.name === "run_script")).toBe(false);
});

test("Codex image_gen namespace survives routed Responses parsing", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: [],
    tools: [{
      type: "namespace",
      name: "image_gen",
      description: "Native Codex image generation",
      tools: [{
        type: "function",
        name: "imagegen",
        description: "Generate or edit an image",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            referenced_image_paths: { type: ["array", "null"], items: { type: "string" } },
            num_last_images_to_include: { type: ["integer", "null"] },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      }],
    }, {
      type: "image_generation",
    }],
  });

  expect(parsed.context.tools).toContainEqual(expect.objectContaining({
    namespace: "image_gen",
    name: "imagegen",
  }));
  expect(parsed.context.tools?.some(tool => tool.name === "image_generation")).toBe(false);
});

test("Responses Lite native exec survives a complete server request as one custom call", async () => {
  const config = defaultConfig("full");
  config.solAvailable = false;
  config.proAvailable = false;
  const turnId = "turn_responses_lite_exec_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      metadata: { turn_id: turnId, thread_id: "thread_responses_lite_exec_regression" },
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: responsesLiteTools().slice(0, 1),
      }, {
        type: "message",
        id: "msg_responses_lite_exec_regression",
        role: "user",
        content: [{ type: "input_text", text: "Use the native exec tool" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "responses-lite-exec-regression",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "exec", freeform: true }));
      emit({ type: "tool_call_start", id: "call_exec", name: "exec" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({ input: "text('ok')" }) });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: false });
    },
  }));

  expect(response.status).toBe(200);
  const body = await response.json() as { output: Array<Record<string, unknown>> };
  const calls = body.output.filter(item => item.type === "custom_tool_call");
  expect(calls).toEqual([expect.objectContaining({
    call_id: "call_exec",
    name: "exec",
    input: "text('ok')",
  })]);
});

test("configured adapter silence budget reaches the streaming Responses bridge", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  config.proAvailable = false;
  config.stallTimeoutSec = 1;
  const turnId = "turn_stall_timeout_regression";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: true,
      metadata: { turn_id: turnId, thread_id: "thread_stall_timeout_regression" },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Exercise the configured stall budget" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  }), config, () => ({
    name: "stall-timeout-regression",
    async runTurn(_parsed, incoming, _emit) {
      await new Promise<void>(resolveAbort => {
        if (incoming.abortSignal?.aborted) resolveAbort();
        else incoming.abortSignal?.addEventListener("abort", () => resolveAbort(), { once: true });
      });
    },
  }));

  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain("upstream_stall_timeout");
});
