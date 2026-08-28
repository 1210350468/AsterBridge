import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_EFFORT_CONTROL_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_HEADER_MODEL_CONTROL_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

test("the effort selector supports the current composer menu plus the legacy/header model control", () => {
  expect(CHATGPT_COMPOSER_EFFORT_CONTROL_SELECTOR).toBe('button[aria-haspopup="menu"][data-tone="neutral"]');
  expect(CHATGPT_HEADER_MODEL_CONTROL_SELECTOR).toBe('button[data-testid="model-switcher-dropdown-button"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain(CHATGPT_COMPOSER_EFFORT_CONTROL_SELECTOR);
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain(CHATGPT_HEADER_MODEL_CONTROL_SELECTOR);
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    count: async () => 0,
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: (selector: string) => selector === CHATGPT_HEADER_MODEL_CONTROL_SELECTOR ? effortButton : composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const emptyHeader = {
    filter() { return this; },
    last() { return this; },
    count: async () => 0,
    isVisible: async () => false,
  };
  const page = {
    locator: (selector: string) => selector === CHATGPT_HEADER_MODEL_CONTROL_SELECTOR ? emptyHeader : composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});
