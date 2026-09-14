import { expect, test } from "bun:test";
import {
  ChatGptMirroredTurnProgress,
  assertChatGptTurnProgressSnapshot,
} from "../src/adapters/chatgpt-web/turn-progress";

test("mirrored turn progress advances monotonically and acknowledges observed tool boundaries", async () => {
  const acknowledged: number[] = [];
  const progress = new ChatGptMirroredTurnProgress(revision => {
    acknowledged.push(revision);
  });

  const changed = progress.waitForChange(0);
  expect(progress.apply({
    revision: 1,
    lastToolBatchRevision: 1,
    activeToolCalls: 1,
    lastProgressAt: 1_000,
  })).toBe(true);
  await expect(changed).resolves.toEqual({
    revision: 1,
    lastToolBatchRevision: 1,
    activeToolCalls: 1,
    lastProgressAt: 1_000,
  });

  await progress.acknowledgeToolBatch(1);
  await progress.acknowledgeToolBatch(1);
  expect(acknowledged).toEqual([1]);

  expect(progress.apply({
    revision: 1,
    lastToolBatchRevision: 1,
    activeToolCalls: 1,
    lastProgressAt: 1_000,
  })).toBe(false);
  expect(() => progress.apply({
    revision: 2,
    lastToolBatchRevision: 0,
    activeToolCalls: 0,
    lastProgressAt: 2_000,
  })).toThrow("regressed");
});

test("cross-process progress snapshots fail closed on impossible causal state", () => {
  expect(() => assertChatGptTurnProgressSnapshot({
    revision: 1,
    lastToolBatchRevision: 2,
    activeToolCalls: 0,
    lastProgressAt: 1_000,
  })).toThrow("invalid");
  expect(() => assertChatGptTurnProgressSnapshot({
    revision: 1,
    lastToolBatchRevision: 1,
    activeToolCalls: 0,
  })).toThrow("invalid");
});
