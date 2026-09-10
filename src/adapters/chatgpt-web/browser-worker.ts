import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import type { CodexProviderConfig } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  compiledChatGptWebMaxMessageChars,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
  type ChatGptWebMultipartStage,
  type ChatGptWebPromptImage,
} from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_EFFORT_CONTROL_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_HEADER_MODEL_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
  detectChatGptAccountCapabilities,
  parseChatGptEffortSliderState,
  preferChatGptEffortSlider,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import { discoverSystemBrowserEndpoint, openSystemBrowserTaskWindow, type SystemBrowserChannel } from "../../system-browser-host";
import { ensureRoxyBrowserEndpoint } from "../../roxy-browser-host";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherRoxyPreview,
  notifyLauncherTurn,
  type LauncherExternalBrowserHost,
} from "../../launcher-browser-host";
import {
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { ChatGptWebAdapterError } from "./adapter-error";
import { selectDirectToolBridgeTransportText } from "./direct-tool-bridge";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
  type ChatGptExternalTurnProgressSnapshot,
  type ChatGptTurnProgressReader,
} from "./turn-progress";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly visibleRows: string[],
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

export class ChatGptPromptAttachmentIntegrityError extends ChatGptWebAdapterError {
  constructor(message: string) {
    super(message, {
      status: 500,
      errorType: "proxy_error",
      code: "prompt_attachment_integrity_error",
      retryable: false,
    });
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求|太多请求|リクエストが多すぎます/i })
  .filter({ hasText: /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: /^(Got it|知道了|了解)$/ }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate-limit dialog is open, but its acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}

type ChatGptTextScope = Pick<Locator, "getByText">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

const chatGptExpiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

export async function throwIfChatGptLoggedOutSurface(page: Page): Promise<void> {
  const loginLink = page
    .locator('a[href*="/auth/login"]')
    .filter({ visible: true })
    .first();
  if (!await loginLink.isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT is signed out in the configured browser profile. Sign in to ChatGPT in that same profile and retry.",
    { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
  );
}

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (await chatGptExpiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "The ChatGPT session has expired. Sign in again in Codex Web GPT.",
      { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
    );
  }
  if (!await chatGptSubscriptionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (!await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    const allowOnce = dialog.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 10_000 });
    await allowOnce.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: 2 | 3,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
  },
): void {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new ChatGptWebAdapterError(
      "Bigger Context is unavailable for Luna because every later browser request includes the accumulated transcript inside the same 28,000-token transport budget.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary("stage", transport.maxStageMessageTokens, transport.maxStageChars, transport.stagingEffort);
    assertMessageBoundary("final part", transport.finalMessageTokens, transport.finalMessageChars, effort);
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  const experimentalContextWindow = contextWindow * partCount;
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "three-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Select the cheapest account-visible mode that can carry every inert multipart stage. */
export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  requestedEffort: ChatGptWebModelMode["effort"],
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID || !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError(
      "Bigger Context staging is unavailable for a Luna-only account.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  const requestedContextWindow = resolveChatGptWebContextLimits(modelId, requestedEffort, capabilities).contextWindow;
  for (const candidate of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, candidate, capabilities);
    const candidateContextWindow = resolveChatGptWebContextLimits(modelId, candidate, capabilities).contextWindow;
    if (candidateContextWindow < requestedContextWindow) continue;
    const limits = resolveChatGptWebTransportLimits(modelId, candidate, capabilities);
    const tokenFits = limits.browserMessageTokenLimit === undefined
      || maxStageMessageTokens <= limits.browserMessageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
} as const;

export function chatGptFileAttachmentTimeoutMs(imageCount: number, totalBytes: number): number {
  if (imageCount <= 0 || totalBytes <= 0) return browserStageTimeouts.fileAttachment;
  const boundedCount = Math.min(CHATGPT_MAX_INPUT_IMAGES, Math.max(1, Math.trunc(imageCount)));
  const boundedBytes = Math.min(50_000_000, Math.max(1, Math.trunc(totalBytes)));
  const byteSteps = Math.ceil(boundedBytes / 10_000_000);
  return Math.min(300_000, browserStageTimeouts.fileAttachment + boundedCount * 5_000 + byteSteps * 30_000);
}

export function chatGptSendStageTimeoutMs(imageCount: number, totalBytes: number): number {
  if (imageCount <= 0 || totalBytes <= 0) return browserStageTimeouts.send;
  const boundedCount = Math.min(CHATGPT_MAX_INPUT_IMAGES, Math.max(1, Math.trunc(imageCount)));
  const boundedBytes = Math.min(50_000_000, Math.max(1, Math.trunc(totalBytes)));
  const byteSteps = Math.ceil(boundedBytes / 5_000_000);
  return Math.min(120_000, Math.max(
    45_000,
    browserStageTimeouts.send + boundedCount * 8_000 + byteSteps * 5_000,
  ));
}

/**
 * A six-figure Input.insertText can make current ChatGPT Lexical surfaces rewrite text inside the
 * first edit even when its final UTF-16 length is unchanged. Bound only the native edit operation;
 * the resulting user message remains one exact prompt, and every prefix is still verified before
 * another irreversible edit. This is independent of model context and compaction limits.
 */
export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 16_000;
const CHATGPT_PROMPT_INSERT_BOUNDARY_LOOKBACK_CHARS = 4_096;
const CHATGPT_PROMPT_WHITESPACE = /\s/u;
export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function promptInsertChunkEnd(text: string, offset: number): number {
  const hardEnd = Math.min(offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS, text.length);
  if (hardEnd >= text.length) return hardEnd;

  const minimumPreferredEnd = Math.max(
    offset + 1,
    hardEnd - CHATGPT_PROMPT_INSERT_BOUNDARY_LOOKBACK_CHARS,
  );
  for (let candidate = hardEnd; candidate >= minimumPreferredEnd; candidate -= 1) {
    if (!CHATGPT_PROMPT_WHITESPACE.test(text[candidate] ?? "")) continue;
    let whitespaceStart = candidate;
    while (
      whitespaceStart > offset
      && CHATGPT_PROMPT_WHITESPACE.test(text[whitespaceStart - 1] ?? "")
    ) {
      whitespaceStart -= 1;
    }
    if (whitespaceStart > offset) return whitespaceStart;
  }

  let end = hardEnd;
  const previousCodeUnit = text.charCodeAt(hardEnd - 1);
  const nextCodeUnit = text.charCodeAt(hardEnd);
  if (previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    end -= 1;
  }
  return end;
}

export function chatGptPhysicalTaskSurfacePlan(
  retainedConversationKeys: Iterable<string>,
  activeConversationKeys: Iterable<string | undefined>,
  requestedConversationKey?: string,
): { occupied: number; needsNewPhysicalSlot: boolean } {
  const retainedKeys = new Set(retainedConversationKeys);
  let distinctNonRetainedRuns = 0;
  for (const activeConversationKey of activeConversationKeys) {
    if (activeConversationKey) retainedKeys.add(activeConversationKey);
    else distinctNonRetainedRuns += 1;
  }
  return {
    occupied: retainedKeys.size + distinctNonRetainedRuns,
    needsNewPhysicalSlot: requestedConversationKey ? !retainedKeys.has(requestedConversationKey) : true,
  };
}

export function chatGptRetainedSurfaceEvictionCandidate(
  retainedConversationKeys: Iterable<string>,
  activeConversationKeys: Iterable<string | undefined>,
  requestedConversationKey?: string,
): string | undefined {
  const active = new Set([...activeConversationKeys].filter((key): key is string => Boolean(key)));
  for (const key of retainedConversationKeys) {
    if (key === requestedConversationKey || active.has(key)) continue;
    return key;
  }
  return undefined;
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Prompt containing only the canonical suffix after the last assistant reply. */
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Retain a completed external-browser Temporary Chat for the next native message in this epoch. */
  retainConversation?: boolean;
  /** Fail closed instead of opening a fresh surface when the requested retained source is gone. */
  requireRetainedConversation?: boolean;
  /** Stable Codex thread/model/effort/compaction-epoch identity for retained browser reuse. */
  conversationKey?: string;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Proven outer Codex MCP activity for this exact browser turn. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Final race check: the browser may finish only while the broker still has no active invocation. */
  completionFence?: {
    begin: () => Promise<number | undefined>;
    commit: (revision: number) => Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
}

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialUserTurnCount: number;
  initialResponseTurnCount: number;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher" | "system-browser" | "roxybrowser";
  systemBrowserChannel: SystemBrowserChannel;
  roxyBrowserProfileId?: string;
  roxyBrowserDataDir?: string;
  roxyBrowserAutoOpen?: boolean;
  roxyBrowserApiHost?: string;
  roxyBrowserApiKeyFile?: string;
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

export function chatGptSubmissionEvidence(state: {
  initialUserTurnCount: number;
  userTurnCount: number;
  initialAssistantTurnCount: number;
  assistantTurnCount: number;
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (state.assistantTurnCount > state.initialAssistantTurnCount) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastToolBatchRevision = 0;
  private postToolAnswerBaselineText?: string;
  private missingPostToolAnswerSince?: number;

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly missingPostToolAnswerMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  needsToolBatchObservation(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < this.lastToolBatchRevision) {
      throw new Error("ChatGPT completion received an invalid tool-batch revision");
    }
    return revision > this.lastToolBatchRevision;
  }

  observeToolBatch(revision: number, currentText: string): boolean {
    if (!this.needsToolBatchObservation(revision)) return false;
    this.postToolAnswerBaselineText = currentText;
    this.lastToolBatchRevision = revision;
    this.missingPostToolAnswerSince = undefined;
    this.candidate = undefined;
    return true;
  }

  update(
    state: Parameters<typeof chatGptTurnIsComplete>[0] & { externalToolCallsInFlight?: boolean },
    now = Date.now(),
  ): boolean {
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
    if (state.externalToolCallsInFlight) {
      this.candidate = undefined;
      this.missingPostToolAnswerSince = undefined;
      return false;
    }
    if (this.postToolAnswerBaselineText === state.currentText) {
      this.candidate = undefined;
      if (!chatGptTurnIsComplete(state)) {
        this.missingPostToolAnswerSince = undefined;
        return false;
      }
      this.missingPostToolAnswerSince ??= now;
      if (now - this.missingPostToolAnswerSince >= this.missingPostToolAnswerMs) {
        throw new Error("ChatGPT completed without producing a final answer after its last Codex tool call");
      }
      return false;
    }
    this.missingPostToolAnswerSince = undefined;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  clearMissingResponse(): void {
    this.missingResponseSince = undefined;
  }

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
    externalProgressLive?: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive) {
      this.missingResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.missingCompletionAction = undefined;
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS
    && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Commentary roots are identified
      // structurally by responseDomSnapshot before they reach this tracker.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        if (!completionActionVisible && this.traceStabilityMs > 0) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      if (!completionActionVisible && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

export function browserDiagnosticIncludesScreenshot(
  checkpoint: string,
  captureAll = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1",
): boolean {
  return captureAll || checkpoint === "response-stalled-30s" || checkpoint === "turn-failed";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;

  constructor(private readonly traceId: string, private readonly root: string) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = browserDiagnosticIncludesScreenshot(checkpoint);
      const [screenshot, state] = await Promise.all([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        page.evaluate(({ composerSelector, effortControlSelector, effortItemSelector, assistantTurnSelector }) => {
          const rendered = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            return candidate.isConnected
              && style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0";
          };

          const boundedText = (element: Element): string => (
            ((element as HTMLElement).innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 1_000)
          );
          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(rendered)
            .slice(-limit)
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                testId: element.getAttribute("data-testid"),
                ariaExpanded: element.getAttribute("aria-expanded"),
                ariaChecked: element.getAttribute("aria-checked"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                text: boundedText(element),
              };
            });
          const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
          return {
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            surfaceId: (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
              .__CODEX_WEB_GPT_SURFACE_ID__ ?? null,
            bodyTextChars: document.body?.innerText.length ?? 0,
            composer: {
              visibleCount: composers.length,
              textChars: composers.map(element => (element.textContent ?? "").length),
              selectedConnectors: rows('[data-id^="plugin:"][data-keyword]', 20),
            },
            effortControls: rows(effortControlSelector, 10),
            effortItems: rows(effortItemSelector, 20),
            menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
            connectorRows: rows('.__menu-item[tabindex="0"]', 40),
            overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
            turns: {
              user: document.querySelectorAll('[data-testid^="conversation-turn-"][data-message-author-role="user"]').length,
              assistant: assistantTurns.map(element => ({
                textChars: (element.textContent ?? "").length,
                htmlChars: (element as HTMLElement).innerHTML.length,
              })),
            },
          };
        }, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR,
          effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
          effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
          assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        }),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshot) atomicWriteFile(join(this.directory, `${stem}.png`), screenshot);
      atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
        version: 1,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? {
          error: redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error)),
        } : {}),
        state,
      }, null, 2)}\n`);
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}:`
        + ` ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const systemBrowserChannel = configured.systemBrowserChannel ?? "auto";
  const roxyBrowserProfileId = configured.roxyBrowserProfileId?.trim();
  const roxyBrowserDataDir = configured.roxyBrowserDataDir?.trim();
  const roxyBrowserAutoOpen = configured.roxyBrowserAutoOpen === true;
  const roxyBrowserApiHost = configured.roxyBrowserApiHost?.trim();
  const roxyBrowserApiKeyFile = configured.roxyBrowserApiKeyFile?.trim();
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (systemBrowserChannel !== "auto" && systemBrowserChannel !== "chrome" && systemBrowserChannel !== "msedge") {
    throw new Error("ChatGPT Web systemBrowserChannel must be auto, chrome, or msedge");
  }
  if (browserHost === "roxybrowser" && (!roxyBrowserProfileId || !roxyBrowserDataDir)) {
    throw new Error("RoxyBrowser host requires chatgptWeb.roxyBrowserProfileId and chatgptWeb.roxyBrowserDataDir");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    systemBrowserChannel,
    ...(roxyBrowserProfileId ? { roxyBrowserProfileId } : {}),
    ...(roxyBrowserDataDir ? { roxyBrowserDataDir: resolve(expandUserPath(roxyBrowserDataDir)) } : {}),
    roxyBrowserAutoOpen,
    ...(roxyBrowserApiHost ? { roxyBrowserApiHost } : {}),
    ...(roxyBrowserApiKeyFile ? { roxyBrowserApiKeyFile: resolve(expandUserPath(roxyBrowserApiKeyFile)) } : {}),
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();
  /** Conversation key for retained external runs; undefined means the run owns a distinct physical page. */
  private readonly activeRunConversationKeys = new Map<string, string | undefined>();
  private readonly externalTurnPages = new Map<string, Page>();
  private readonly retainedExternalPages = new Map<string, Page>();
  private readonly conversationTails = new Map<string, Promise<void>>();
  private readonly turnStages = new Map<string, string>();
  private roxyOpenedByAutomation = false;

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * Lexical/contenteditable may preserve runs of ASCII spaces by exposing some of them as NBSP
   * through DOM textContent. Treat that DOM-only representation as equivalent only when the
   * expected U+0020 belongs to a multi-space run. Single spaces, tabs, newlines, intentional
   * expected NBSP characters, and every other mutation remain exact and fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    const expectedUnit = expected[index];
    const observedUnit = observed[index];

    if (expectedUnit === observedUnit) return true;
    if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;

    return expected[index - 1] === " " || expected[index + 1] === " ";
  }

  private promptComparisonText(value: string): string {
    // Chromium/Lexical may canonicalize decomposed Unicode, drop the emoji/text presentation
    // selectors U+FE0E/U+FE0F, and expose contenteditable line breaks as LF even when an inserted
    // context fragment used CRLF/CR. These transformations preserve the textual instruction;
    // normalize only those representation-level differences. Do not strip ZWJ, spaces, tabs,
    // punctuation, line breaks themselves, or any ordinary code point.
    return value
      .replace(/\r\n?/gu, "\n")
      .normalize("NFC")
      .replace(/[\uFE0E\uFE0F]/gu, "");
  }

  private promptTextEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    const comparableExpected = this.promptComparisonText(expected);
    const comparableObserved = this.promptComparisonText(observed);
    if (comparableExpected.length !== comparableObserved.length) return false;

    for (let index = 0; index < comparableExpected.length; index += 1) {
      if (!this.promptCodeUnitEquivalent(comparableExpected, comparableObserved, index)) {
        return false;
      }
    }

    return true;
  }

  private promptEquivalentPrefixLength(
    expected: string,
    observed: string,
  ): number {
    const comparableExpected = this.promptComparisonText(expected);
    const comparableObserved = this.promptComparisonText(observed);
    const length = Math.min(comparableExpected.length, comparableObserved.length);

    let index = 0;
    while (
      index < length
      && this.promptCodeUnitEquivalent(comparableExpected, comparableObserved, index)
    ) {
      index += 1;
    }

    return index;
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    const retainedExternal = Boolean(
      turn.conversationKey
      && (this.config.browserHost === "roxybrowser" || this.config.browserHost === "system-browser"),
    );
    const requestedConversationKey = retainedExternal ? turn.conversationKey! : undefined;
    const slotPreparation = this.preparePhysicalTaskSurfaceSlot(requestedConversationKey);
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const start = () => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn);
    const execute = () => slotPreparation ? slotPreparation.then(start) : start();
    let run: Promise<string>;
    if (retainedExternal) {
      const key = turn.conversationKey!;
      const prior = this.conversationTails.get(key) ?? Promise.resolve();
      run = prior.then(execute);
      const tail = run.then(() => undefined, () => undefined);
      this.conversationTails.set(key, tail);
      void tail.finally(() => {
        if (this.conversationTails.get(key) === tail) this.conversationTails.delete(key);
      });
    } else {
      run = Promise.resolve().then(execute);
    }
    this.activeRuns.set(turn.traceId, run);
    this.activeRunConversationKeys.set(turn.traceId, requestedConversationKey);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
      this.activeRunConversationKeys.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  private preparePhysicalTaskSurfaceSlot(requestedConversationKey?: string): Promise<void> | undefined {
    for (const [key, page] of this.retainedExternalPages) {
      if (page.isClosed()) this.retainedExternalPages.delete(key);
    }
    const surfacePlan = chatGptPhysicalTaskSurfacePlan(
      this.retainedExternalPages.keys(),
      this.activeRunConversationKeys.values(),
      requestedConversationKey,
    );
    if (!surfacePlan.needsNewPhysicalSlot || surfacePlan.occupied < MAX_CHATGPT_BROWSER_TABS) return undefined;

    const evictionKey = chatGptRetainedSurfaceEvictionCandidate(
      this.retainedExternalPages.keys(),
      this.activeRunConversationKeys.values(),
      requestedConversationKey,
    );
    if (evictionKey) {
      const page = this.retainedExternalPages.get(evictionKey);
      this.retainedExternalPages.delete(evictionKey);
      if (!page || page.isClosed()) {
        console.info(`[chatgpt-web] released idle retained conversation ${evictionKey.slice(0, 17)} to free a browser slot`);
        return undefined;
      }
      return page.close().then(
        () => {
          console.info(`[chatgpt-web] released idle retained conversation ${evictionKey.slice(0, 17)} to free a browser slot`);
        },
        error => {
          if (!page.isClosed()) this.retainedExternalPages.set(evictionKey, page);
          throw new Error(
            `Could not release an idle retained ChatGPT surface before opening another: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    }

    return Promise.reject(new Error(
      `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns or retained task surfaces; all available slots are active`,
    ));
  }

  async releaseRetainedConversation(conversationKey: string): Promise<boolean> {
    for (;;) {
      const tail = this.conversationTails.get(conversationKey);
      if (!tail) break;
      await tail;
      if (this.conversationTails.get(conversationKey) === tail) break;
    }
    const page = this.retainedExternalPages.get(conversationKey);
    if (!page) return false;
    this.retainedExternalPages.delete(conversationKey);
    if (!page.isClosed()) await page.close().catch(() => {});
    return true;
  }

  verifyConnector(): Promise<string> {
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive());
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  private async releaseExternalMaintenancePage(): Promise<void> {
    if (this.config.browserHost !== "roxybrowser" && this.config.browserHost !== "system-browser") return;
    const page = this.page;
    this.page = undefined;
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(async () => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      const external = this.config.browserHost === "roxybrowser" || this.config.browserHost === "system-browser";
      if (external) {
        // Maintenance probes are intentionally ephemeral. Close any stale maintenance page from an
        // interrupted older operation, then honor the same five-physical-surface ceiling as turns.
        await this.releaseExternalMaintenancePage();
        const slotPreparation = this.preparePhysicalTaskSurfaceSlot(undefined);
        if (slotPreparation) await slotPreparation;
      }
      try {
        return await action();
      } finally {
        if (external) await this.releaseExternalMaintenancePage();
      }
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    const page = this.page;
    const retainedPages = [...this.retainedExternalPages.values()];
    this.retainedExternalPages.clear();
    this.conversationTails.clear();
    this.activeRunConversationKeys.clear();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    if ((this.config.browserHost === "system-browser" || this.config.browserHost === "roxybrowser") && page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    await Promise.allSettled(retainedPages.map(async retained => {
      if (!retained.isClosed()) await retained.close();
    }));
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    this.turnStages?.set(traceId, stage);
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
          controller.abort();
        }, timeoutMs);
      });
      const value = await Promise.race([action(controller.signal), timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      this.turnStages?.set(traceId, `${stage}:failed`);
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async minimizeExternalBrowserWindows(browser: Browser): Promise<void> {
    const session = await browser.newBrowserCDPSession();
    try {
      const targets = await session.send("Target.getTargets");
      const windowIds = new Set<number>();
      for (const target of targets.targetInfos ?? []) {
        if (target.type !== "page" || !target.targetId) continue;
        const window = await session.send("Browser.getWindowForTarget", { targetId: target.targetId }).catch(() => null);
        if (window && Number.isInteger(window.windowId)) windowIds.add(window.windowId);
      }
      for (const windowId of windowIds) {
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        }).catch(() => {});
      }
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async minimizeExternalBrowserPage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const session = await page.context().newCDPSession(page);
    try {
      const targetInfo = await session.send("Target.getTargetInfo");
      const targetId = targetInfo.targetInfo?.targetId;
      if (typeof targetId !== "string" || !targetId) return;
      const window = await session.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
      if (!window || !Number.isInteger(window.windowId)) return;
      await session.send("Browser.setWindowBounds", {
        windowId: window.windowId,
        bounds: { windowState: "minimized" },
      }).catch(() => {});
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async revealExternalBrowserPage(page: Page): Promise<void> {
    if (page.isClosed()) throw new Error("The external browser task page is already closed");
    const session = await page.context().newCDPSession(page);
    try {
      const targetInfo = await session.send("Target.getTargetInfo");
      const targetId = targetInfo.targetInfo?.targetId;
      if (typeof targetId === "string" && targetId) {
        const window = await session.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
        if (window && Number.isInteger(window.windowId)) {
          await session.send("Browser.setWindowBounds", {
            windowId: window.windowId,
            bounds: { windowState: "normal" },
          }).catch(() => {});
        }
        await session.send("Target.activateTarget", { targetId }).catch(() => {});
      }
      await page.bringToFront();
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private startRoxyPreviewLoop(page: Page, traceId: string): () => void {
    if (!this.config.browserHostDescriptorPath) return () => {};
    let stopped = false;
    let inFlight = false;
    let lastChannelWarningAt = 0;
    const publish = async () => {
      if (stopped || inFlight || page.isClosed()) return;
      inFlight = true;
      try {
        let dataUrl: string | null = null;
        try {
          const image = await page.screenshot({
            type: "jpeg",
            quality: 38,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });
          if (image.length <= 500_000) dataUrl = `data:image/jpeg;base64,${image.toString("base64")}`;
        } catch {
          // A transient navigation can invalidate one frame. Status still remains useful.
        }
        const preview = await notifyLauncherRoxyPreview(this.config.browserHostDescriptorPath!, {
          traceId,
          helperPid: process.pid,
          stage: this.turnStages.get(traceId) || "running",
          url: page.url().slice(0, 4096),
          status: "running",
          dataUrl,
        });
        if (preview.action === "take-control") {
          await this.revealExternalBrowserPage(page);
          console.info(`[chatgpt-web] RoxyBrowser manual control opened for ${traceId}`);
        }
      } catch (error) {
        const now = Date.now();
        if (now - lastChannelWarningAt >= 30_000) {
          lastChannelWarningAt = now;
          console.warn(
            `[chatgpt-web] RoxyBrowser live preview update failed for ${traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        inFlight = false;
      }
    };
    void publish();
    const timer = setInterval(() => void publish(), 1_000);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (this.config.browserHost === "system-browser" || this.config.browserHost === "roxybrowser") {
      const { browser, context } = await this.ensureManagedBrowser();
      this.page = this.config.browserHost === "roxybrowser" && this.roxyOpenedByAutomation
        ? await context.newPage()
        : await openSystemBrowserTaskWindow(browser, context);
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if ((this.config.browserHost === "system-browser" || this.config.browserHost === "roxybrowser") && this.browser && !this.browser.isConnected()) {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.managedBrowserReady = undefined;
      this.roxyOpenedByAutomation = false;
    }
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (this.config.browserHost === "system-browser") {
        const discovered = await discoverSystemBrowserEndpoint(this.config.systemBrowserChannel);
        const browser = await chromium.connectOverCDP(discovered.channel, { timeout: 30_000 });
        const context = browser.contexts()[0];
        if (!context) {
          await browser.close().catch(() => {});
          throw new Error(`Connected to ${discovered.channel} but no browser context is available`);
        }
        console.info(`[chatgpt-web] attached to system browser channel=${discovered.channel} endpoint=${discovered.endpoint}`);
        this.browser = browser;
        this.context = context;
        return { browser, context };
      }
      if (this.config.browserHost === "roxybrowser") {
        try {
          const discovered = await ensureRoxyBrowserEndpoint(
            this.config.roxyBrowserProfileId!,
            this.config.roxyBrowserDataDir!,
            {
              autoOpen: this.config.roxyBrowserAutoOpen,
              apiHost: this.config.roxyBrowserApiHost,
              apiKeyFile: this.config.roxyBrowserApiKeyFile,
            },
          );
          const browser = await chromium.connectOverCDP(discovered.endpoint, { timeout: 30_000 });
          const context = browser.contexts()[0];
          if (!context) {
            await browser.close().catch(() => {});
            throw new Error(`Connected to RoxyBrowser profile ${discovered.profileId} but no browser context is available`);
          }
          this.roxyOpenedByAutomation = discovered.openedByAutomation;
          if (discovered.openedByAutomation) {
            await this.minimizeExternalBrowserWindows(browser).catch(error => {
              console.warn(
                `[chatgpt-web] RoxyBrowser profile ${discovered.profileId} opened automatically but its window could not be minimized: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
          console.info(`[chatgpt-web] attached to RoxyBrowser profile=${discovered.profileId}`);
          this.browser = browser;
          this.context = context;
          return { browser, context };
        } catch (error) {
          if (error instanceof ChatGptWebAdapterError) throw error;
          throw new ChatGptWebAdapterError(
            error instanceof Error ? error.message : String(error),
            { status: 503, errorType: "server_error", code: "browser_unavailable", retryable: false },
          );
        }
      }
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { browser, context } = await this.ensureManagedBrowser();
    if (this.config.browserHost === "roxybrowser" && this.roxyOpenedByAutomation) {
      return await context.newPage();
    }
    if (this.config.browserHost === "system-browser" || this.config.browserHost === "roxybrowser") {
      return await openSystemBrowserTaskWindow(browser, context);
    }
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const composerEffortControls = composerForm
      .locator(CHATGPT_COMPOSER_EFFORT_CONTROL_SELECTOR)
      .filter({ visible: true });
    const headerModelControls = page
      .locator(CHATGPT_HEADER_MODEL_CONTROL_SELECTOR)
      .filter({ visible: true });
    const resolveVisibleEffortControl = async (): Promise<Locator | undefined> => {
      if (await composerEffortControls.count().catch(() => 0) > 0) return composerEffortControls.last();
      if (await headerModelControls.count().catch(() => 0) > 0) return headerModelControls.last();
      return undefined;
    };
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      if (await resolveVisibleEffortControl()) {
        throw new Error(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      await captureDiagnostic?.("luna-default-confirmed");
      return mode;
    }
    let currentEffort: Locator | undefined;
    const effortDeadline = Date.now() + 70_000;
    while (!currentEffort && Date.now() < effortDeadline) {
      await throwIfChatGptSessionFailureAlert(page);
      currentEffort = await resolveVisibleEffortControl();
      if (!currentEffort) await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (!currentEffort) {
      await throwIfChatGptSessionFailureAlert(page);
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    const effortMenu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
    const menuVisible = await effortMenu.isVisible().catch(() => false);
    const menuExpanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
    if (!menuVisible && menuExpanded !== "true") {
      await throwIfChatGptRateLimitDialog(page);
      await currentEffort.press("Enter");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(uiEffortIndex);
    const effortSlider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const waitAbort = new AbortController();
    let ready: "effort" | "slider" | "rate-limit" | "session-expired";
    try {
      ready = await Promise.race([
        effortChoice.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "effort" as const),
        effortSlider.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      if (ready === "effort") {
        const preferred = await preferChatGptEffortSlider("items", effortSlider);
        if (preferred === "slider") ready = "slider";
      }
      await captureDiagnostic?.(ready === "slider" ? "effort-slider-visible" : "effort-choice-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw new ChatGptWebAdapterError(
        `ChatGPT effort menu did not expose item index ${uiEffortIndex}`
        + `; item count: ${await effortChoices.count().catch(() => 0)}`,
        { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
      );
    } finally {
      waitAbort.abort();
    }
    if (ready === "slider") {
      let sliderState = parseChatGptEffortSliderState(
        await effortSlider.getAttribute("aria-valuemin"),
        await effortSlider.getAttribute("aria-valuemax"),
        await effortSlider.getAttribute("aria-valuenow"),
      );
      if (!sliderState) {
        throw new ChatGptWebAdapterError(
          "ChatGPT effort slider exposed an invalid ARIA range",
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const targetValue = sliderState.min + uiEffortIndex;
      if (targetValue > sliderState.max) {
        throw new ChatGptWebAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex}`
          + ` (min=${sliderState.min}; max=${sliderState.max})`,
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
      while (sliderState.value !== targetValue) {
        await throwIfChatGptRateLimitDialog(page);
        const direction = targetValue > sliderState.value ? 1 : -1;
        const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
        const previousValue = sliderState.value;
        await sliderControl.press(key);
        const changeDeadline = Date.now() + 5_000;
        do {
          sliderState = parseChatGptEffortSliderState(
            await effortSlider.getAttribute("aria-valuemin"),
            await effortSlider.getAttribute("aria-valuemax"),
            await effortSlider.getAttribute("aria-valuenow"),
          );
          if (!sliderState) throw new Error("ChatGPT effort slider lost its semantic ARIA state");
          if (sliderState.value !== previousValue) break;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
        } while (Date.now() < changeDeadline);
        if (sliderState.value !== previousValue + direction) {
          throw new Error(
            `ChatGPT effort slider did not move exactly one step with ${key}`
            + ` (before=${previousValue}; after=${sliderState.value})`,
          );
        }
      }
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    await throwIfChatGptRateLimitDialog(page);
    await effortChoice.press("Enter");
    await captureDiagnostic?.("effort-choice-activated");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") {
          await throwIfChatGptRateLimitDialog(page);
          await currentEffort.press("Enter");
        }
        await effortChoice.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }
      confirmed = await effortChoice.getAttribute("aria-checked");
      if (confirmed === "true") {
        await captureDiagnostic?.("effort-selected");
        await page.keyboard.press("Escape");
        return mode;
      }
      if (confirmed !== "false") {
        throw new Error(`ChatGPT effort item index ${uiEffortIndex} lost its semantic checked state`);
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${uiEffortIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed)})`,
    );
  }

  private async activeComposer(page: Page, timeoutMs = 30_000): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      count = await composers.count();
      if (count === 1) return composers.first();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  /** Put every browser operation on one fully hydrated Temporary Chat document. */
  private async prepareTemporaryChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.("temporary-chat-navigation-complete");
    }
    let composer: Locator;
    try {
      composer = await this.activeComposer(page);
    } catch {
      await throwIfChatGptLoggedOutSurface(page);
      throw new Error("ChatGPT Temporary Chat did not expose a usable composer");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    responseTurn: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn);
      const evidence = await this.currentSubmissionEvidence(
        page,
        userTurns,
        responseTurns,
        initialUserTurnCount,
        initialResponseTurnCount,
      );
      if (evidence) return evidence;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }

  private async currentSubmissionEvidence(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const [userTurnCount, assistantTurnCount, visibleStopButtonCount] = await Promise.all([
      userTurns.count(),
      responseTurns.count(),
      page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count(),
    ]);
    return chatGptSubmissionEvidence({
      initialUserTurnCount,
      userTurnCount,
      initialAssistantTurnCount: initialResponseTurnCount,
      assistantTurnCount,
      generationRunning: visibleStopButtonCount > 0,
    });
  }

  private async captureSubmissionBaseline(page: Page): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const [initialUserTurnCount, initialResponseTurnCount] = await Promise.all([
      userTurns.count(),
      responseTurns.count(),
    ]);
    return { userTurns, responseTurns, initialUserTurnCount, initialResponseTurnCount };
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence> {
    const composer = await this.activeComposer(page);
    const sendButton = composer.locator("xpath=ancestor::form[1]").getByTestId("send-button");
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    if (!await sendButton.isEnabled()) {
      throw new Error("ChatGPT send button is disabled after the complete prompt was attached");
    }
    await settleChatGptUi();
    await captureDiagnostic?.("send-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await sendButton.press("Enter");
    const responseTurn = baseline.responseTurns.nth(baseline.initialResponseTurnCount);
    return await this.waitForSubmissionAccepted(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      responseTurn,
      baseline.initialUserTurnCount,
      baseline.initialResponseTurnCount,
      signal,
    );
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    responseTurn: Locator,
    stage: ChatGptWebMultipartStage,
    deadline: number | undefined,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const completionTracker = new ChatGptCompletionTracker();
    const domHealthTracker = new ChatGptTurnDomHealthTracker();
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn);
      const snapshot = await this.responseDomSnapshot(responseTurn);
      const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
      });
      if (domError) throw new Error(domError);
      if (completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
      })) {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            `ChatGPT Bigger Context stage returned ${actual.length.toLocaleString("en-US")} characters instead of its exact acknowledgement. The staged task was not committed and will not be retried automatically.`,
            { status: 502, errorType: "server_error", code: "multipart_protocol_violation", retryable: false },
          );
        }
        return;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
  }

  private async attachedPromptText(page: Page): Promise<string> {
    const composer = await this.activeComposer(page);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000 });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(prompt, observed)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ hasText: this.config.appName, visible: true });
  }

  private async connectorIsSelected(composer: Locator): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await selected.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-keyword"))
    ));
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private connectorMentionRows(page: Page): Locator {
    // ChatGPT's unified composer reuses `.__menu-item` across the sidebar, attachment menus,
    // plugin search, and other navigation surfaces. Connector discovery must stay scoped to the
    // currently visible composer popover or unrelated rows can be mistaken for app-catalog evidence.
    return page
      .locator(".popover")
      .filter({ visible: true })
      .last()
      .locator('.__menu-item[tabindex="0"]');
  }

  private async connectorMentionRowTitles(menuRows: Locator): Promise<string[]> {
    const texts = await menuRows.filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(menuRows: Locator, triggerAttempts: number): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
      return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
        + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
        + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; create a connector with that exact name before retrying`
      + `; visible rows: ${titles.map(title => JSON.stringify(title)).join(", ")}`;
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
  ): Promise<Locator> {
    let composer = await this.activeComposer(page);
    await composer.fill("");
    if (await this.connectorIsSelected(composer)) {
      await captureDiagnostic?.("connector-already-selected");
      return composer;
    }

    const menuRows = this.connectorMentionRows(page);
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const menuDeadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    let firstMenuCaptured = false;
    for (;;) {
      triggerAttempts += 1;
      composer = await this.activeComposer(page);
      await composer.fill("");
      await composer.focus();
      await settleChatGptUi();
      await composer.pressSequentially(`@${this.config.appName}`, { delay: 25 });
      if (!firstMenuCaptured) {
        firstMenuCaptured = true;
        await captureDiagnostic?.("connector-mention-triggered");
      }
      try {
        await appResult.waitFor({
          state: "visible",
          timeout: Math.min(2_500, Math.max(1, menuDeadline - Date.now())),
        });
        await captureDiagnostic?.("connector-menu-visible");
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        const visibleRows = await this.connectorMentionRowTitles(menuRows);
        const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
          && (
            visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
            || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name))
          );
        if (knownIdentityMismatch) {
          await captureDiagnostic?.("connector-menu-missing");
          throw new Error(await this.connectorMentionFailure(menuRows, triggerAttempts));
        }
        if (Date.now() >= menuDeadline) {
          if (catalogRefreshAvailable && visibleRows.length > 0) {
            if (!visibleRows.includes(this.config.appName)) {
              throw new ChatGptConnectorCatalogStaleError(
                this.config.appName,
                visibleRows,
                triggerAttempts,
              );
            }
          }
          await captureDiagnostic?.("connector-menu-missing");
          throw new Error(await this.connectorMentionFailure(menuRows, triggerAttempts));
        }
      }
    }
    if (await appResult.count() !== 1) {
      throw new Error(
        `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
        + `; visible rows: ${(await this.connectorMentionRowTitles(menuRows)).map(title => JSON.stringify(title)).join(", ")}`,
      );
    }
    // Hidden launcher maintenance keeps a 1x1 Chromium viewport, so pointer activation cannot
    // reach this menu. Unlike the old unguarded composer Enter path, require the exact row to own
    // ChatGPT's keyboard highlight first; otherwise move the menu highlight until it does. Keep
    // focus on the composer, activate through the menu's real keyboard owner, then prove the exact
    // selected connector pill below.
    const rowHighlighted = async () => await appResult.getAttribute("data-highlighted") !== null;
    if (!await rowHighlighted()) {
      const visibleRowCount = await menuRows.filter({ visible: true }).count();
      for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
        await page.keyboard.press("ArrowDown");
      }
    }
    if (!await rowHighlighted()) {
      throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
    }
    await page.keyboard.press("Enter");
    await captureDiagnostic?.("connector-choice-activated");
    // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
    // again instead of returning the pre-selection locator, otherwise the real turn can focus a
    // detached/hidden editor even though verification just succeeded.
    const selectedComposer = await this.activeComposer(page);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    await selectedConnector.waitFor({ state: "visible", timeout: 10_000 });
    if (!await this.connectorIsSelected(selectedComposer)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    }
    await captureDiagnostic?.("connector-selected");
    return selectedComposer;
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    reuseConnector = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    if (!localTools || reuseConnector) {
      const composer = await this.activeComposer(page);
      // ChatGPT clears the composer plugin pill after a sent message, but the same un-navigated
      // conversation remains bound to that connector. A retained continuation therefore inserts
      // the next prompt directly instead of re-mentioning the app or requiring the transient pill.
      // Any real connector loss still fails closed when the next MCP capability is actually used.
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text in one CDP Input.insertText command.
      await composer.fill("");
      await composer.focus();
      await this.insertPromptText(page, prompt, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
      return;
    }
    const selectedComposer = await this.selectConnector(
      page,
      captureDiagnostic,
      catalogRefreshAvailable,
    );
    await selectedComposer.focus();
    await page.keyboard.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY);
    await this.insertPromptText(page, ` ${prompt}`, abortSignal);
    await this.assertPromptAttached(page, prompt, abortSignal);
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const before = await this.currentSubmissionEvidence(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      baseline.initialUserTurnCount,
      baseline.initialResponseTurnCount,
    );
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${before} after compaction prompt attachment failed; refusing a duplicate submission`,
      );
    }

    const composer = await this.activeComposer(page);
    await composer.fill("");
    await composer.focus();
    await settleChatGptUi();
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      baseline.initialUserTurnCount,
      baseline.initialResponseTurnCount,
    );
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${after} while resetting a failed compaction prompt; refusing a duplicate submission`,
      );
    }
    const observed = await this.attachedPromptText(page);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    reuseConnector = false,
  ): Promise<void> {
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          reuseConnector,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(
          page,
          baseline.userTurns,
          baseline.responseTurns,
          baseline.initialUserTurnCount,
          baseline.initialResponseTurnCount,
        );
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            `${error.message}; ChatGPT exposed ${evidence}, so the bridge refused to insert or send the compaction prompt again`,
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal);
      }
    }
  }

  private async reanchorPromptCaret(page: Page, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page);
    await composer.focus();
    const anchored = await composer.evaluate(async element => {
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const editableRootNodes = [...element.childNodes].filter(node => (
        node.nodeType === Node.TEXT_NODE
          ? (node.textContent ?? "").length > 0
          : node instanceof Element && !node.matches(ignoredSelector)
      ));
      const finalRootNode = editableRootNodes[editableRootNodes.length - 1];
      if (!finalRootNode) return false;

      const textNodes: Text[] = [];
      const collectTextNodes = (node: Node): void => {
        if (node instanceof Element && node.matches(ignoredSelector)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if ((node.textContent ?? "").length > 0) textNodes.push(node as Text);
          return;
        }
        for (const child of node.childNodes) collectTextNodes(child);
      };
      collectTextNodes(finalRootNode);
      const lastTextNode = textNodes[textNodes.length - 1];
      const cursorTarget = finalRootNode instanceof Element
        ? finalRootNode.querySelector("[data-inline-selection-pill-cursor-target]")
        : null;

      let targetNode: Node;
      let targetOffset: number;
      const cursorFollowsText = lastTextNode && cursorTarget
        ? (lastTextNode.compareDocumentPosition(cursorTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false;
      if (cursorTarget?.parentNode && (!lastTextNode || cursorFollowsText)) {
        targetNode = cursorTarget.parentNode;
        targetOffset = [...targetNode.childNodes].indexOf(cursorTarget);
      } else if (lastTextNode) {
        targetNode = lastTextNode;
        targetOffset = lastTextNode.data.length;
      } else if (finalRootNode instanceof Element && !["AREA", "BR", "HR", "IMG", "INPUT"].includes(finalRootNode.tagName)) {
        targetNode = finalRootNode;
        targetOffset = finalRootNode.childNodes.length;
      } else {
        return false;
      }

      const selection = window.getSelection();
      if (!selection) return false;
      const selectionIsExact = (): boolean => selection.isCollapsed
        && selection.anchorNode === targetNode
        && selection.anchorOffset === targetOffset
        && selection.focusNode === targetNode
        && selection.focusOffset === targetOffset;
      if (!selectionIsExact()) {
        const range = document.createRange();
        range.setStart(targetNode, targetOffset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      // BrowserHost disables background throttling for active turn pages. One frame lets Lexical
      // apply any selection observer before we accept the exact node-and-offset postcondition.
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
      return selectionIsExact();
    }, undefined, { timeout: 20_000 });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!anchored) {
      throw new Error("ChatGPT composer could not re-anchor the prompt caret at the document end");
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      throwIfPromptAttachmentAborted(abortSignal);
      const end = promptInsertChunkEnd(text, offset);
      const chunk = text.slice(offset, end);
      const previousPrefix = text.slice(0, offset).trimStart();
      const expectedPrefix = text.slice(0, end).trimStart();
      let retriedNoop = false;

      for (;;) {
        await page.keyboard.insertText(chunk);
        throwIfPromptAttachmentAborted(abortSignal);
        try {
          // Verify every irreversible native edit, including the final chunk. ChatGPT's Lexical
          // surface can occasionally accept Input.insertText while committing none of that chunk.
          await this.waitForPromptChunkAttached(page, expectedPrefix, abortSignal);
          break;
        } catch (error) {
          if (retriedNoop || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
          const observed = await this.attachedPromptText(page);
          throwIfPromptAttachmentAborted(abortSignal);
          // A retry is safe only when the failed native edit was a proven no-op. Any partial,
          // duplicated, or rewritten chunk remains fail-closed because appending again could
          // silently corrupt the Codex context.
          if (!this.promptTextEquivalent(previousPrefix, observed)) throw error;
          retriedNoop = true;
          await this.reanchorPromptCaret(page, abortSignal);
        }
      }

      if (end < text.length) {
        // Lexical can rebuild the active block after an exact commit and move its native selection.
        // Re-anchor only after the verified prefix is stable, before the next irreversible edit.
        await this.reanchorPromptCaret(page, abortSignal);
      }
      offset = end;
    }
  }

  private async waitForPromptChunkAttached(
    page: Page,
    expected: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    let observed = "";
    do {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(expected, observed)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    } while (Date.now() < deadline);
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(expected, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not commit a complete prompt insertion chunk`
      + ` (expectedChars=${expected.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private async verifyConnectorExclusive(): Promise<string> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    // Connector verification is a catalog check, not a synthetic tool call. ChatGPT has changed
    // the DOM used for the selected connector pill more than once, while the exact @-mention menu
    // remains the user-visible source of truth for whether the connector is available. Verify the
    // exact row there and avoid treating a cosmetic selected-pill change as a broken MCP runtime.
    const menuRows = this.connectorMentionRows(page);
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const deadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    for (;;) {
      triggerAttempts += 1;
      const composer = await this.activeComposer(page);
      await composer.fill("");
      await composer.focus();
      await settleChatGptUi();
      await composer.pressSequentially(`@${this.config.appName}`, { delay: 25 });
      try {
        await appResult.waitFor({
          state: "visible",
          timeout: Math.min(2_500, Math.max(1, deadline - Date.now())),
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        if (Date.now() >= deadline) {
          throw new Error(await this.connectorMentionFailure(menuRows, triggerAttempts));
        }
      }
    }
    if (await appResult.count() !== 1) {
      throw new Error(
        `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
        + `; visible rows: ${(await this.connectorMentionRowTitles(menuRows)).map(title => JSON.stringify(title)).join(", ")}`,
      );
    }
    const composer = await this.activeComposer(page);
    await composer.fill("");
    return this.config.appName;
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(
    page: Page,
    files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
  ): Promise<void> {
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(responseTurn: Locator): Promise<ChatGptResponseDomSnapshot> {
    const snapshot = await responseTurn.evaluate((element, completionActionSelector) => {
      const root = element as HTMLElement;
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(renderedInDom);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedInDom);
      const commentaryRoots = allMarkdownRoots.filter(candidate => (
        candidate.closest("[data-streaming-response-status]") !== null
        || streamingStatusContainers.some(status => (
          Boolean(candidate.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
        ))
      ));
      const renderedRoots = allMarkdownRoots.filter(candidate => (
        !commentaryRoots.includes(candidate)
      ));
      const markdownSegments = renderedRoots.flatMap((markdownRoot, rootIndex) => {
        const rootIsComplete = rootIndex < renderedRoots.length - 1;
        const hasDirectText = [...markdownRoot.childNodes].some(node => (
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
        ));
        const children = [...markdownRoot.children] as HTMLElement[];
        if (hasDirectText || children.length === 0) {
          return markdownRoot.innerHTML.trim() ? [{
            key: `${rootIndex}:root`,
            html: markdownRoot.innerHTML,
            text: markdownRoot.innerText.trim(),
            streamable: rootIsComplete,
          }] : [];
        }

        return children.flatMap((child, childIndex) => {
          const tag = child.tagName.toLowerCase();
          const childIsComplete = rootIsComplete || childIndex < children.length - 1;
          const listItems = tag === "ol" || tag === "ul"
            ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
            : [];
          if (listItems.length === 0) {
            return [{
              key: `${rootIndex}:${childIndex}:${tag}`,
              html: child.outerHTML,
              text: child.innerText.trim(),
              streamable: childIsComplete,
            }];
          }

          const group = `${rootIndex}:${childIndex}:${tag}`;
          const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
          return listItems.map((item, itemIndex) => {
            const shell = child.cloneNode(false) as HTMLElement;
            shell.removeAttribute("data-is-last-node");
            if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
              shell.setAttribute("start", String(orderedStart + itemIndex));
            }
            shell.append(item.cloneNode(true));
            return {
              key: `${rootIndex}:${childIndex}:${tag}:${itemIndex}`,
              html: shell.outerHTML,
              text: item.innerText.trim(),
              group,
              streamable: childIsComplete || itemIndex < listItems.length - 1,
            };
          });
        });
      });
      const rendered = renderedRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
          .filter(renderedInDom)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        return candidate.closest<HTMLElement>("button") ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? { complete: index < blocks.length - 1 } : {}),
      }));
      return {
        responsePresent: true,
        visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
        fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
        markdownSegments,
        completionActionVisible: completionAction !== undefined,
        traceBlocks,
      };
    }, CHATGPT_COMPLETION_ACTION_SELECTOR, { timeout: 2_000 }).catch(() => {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
      }
      return absentResponseDomSnapshot();
    });
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: candidate.innerText.trim().length,
          }));
        return {
          textChars: root.innerText.trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: candidate.innerText.trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const externalHost: LauncherExternalBrowserHost | undefined = this.config.browserHost === "roxybrowser"
      || this.config.browserHost === "system-browser"
      ? this.config.browserHost
      : undefined;
    const launcherControlAvailable = Boolean(
      this.config.browserHostDescriptorPath
      && (this.config.browserHost === "launcher" || externalHost),
    );
    if (!launcherControlAvailable) return this.runBrowserTurn(turn);

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(externalHost ? { externalHost } : {}),
    }).catch(error => {
      if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
      throw error;
    });
    const surfaceId = lease.surfaceId;
    if (!externalHost && !surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
        ...(externalHost ? { externalHost } : {}),
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).then(async heartbeat => {
        if (heartbeat.action !== "take-control") return;
        const page = this.externalTurnPages.get(turn.traceId);
        if (!page) throw new Error("RoxyBrowser task page is not ready for manual control");
        await this.revealExternalBrowserPage(page);
        console.info(`[chatgpt-web] RoxyBrowser manual control opened for ${turn.traceId}`);
      }).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      return await this.runBrowserTurn(turn, surfaceId, undefined, {
        externalHost,
        previewEnabled: externalHost === "roxybrowser" && lease.previewEnabled === true,
      });
    } catch (error) {
      originalError = error;
      terminal = (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
          ...(externalHost ? { externalHost } : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
          throw controlError;
        }
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    launcherExternal?: { externalHost?: LauncherExternalBrowserHost; previewEnabled?: boolean },
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, turn.capabilities);
    const externalRetention = Boolean(
      turn.conversationKey
      && (this.config.browserHost === "roxybrowser" || this.config.browserHost === "system-browser"),
    );
    let retainedPage = externalRetention ? this.retainedExternalPages.get(turn.conversationKey!) : undefined;
    if (retainedPage?.isClosed()) {
      this.retainedExternalPages.delete(turn.conversationKey!);
      retainedPage = undefined;
    } else if (retainedPage && turn.conversationKey) {
      this.retainedExternalPages.delete(turn.conversationKey);
      this.retainedExternalPages.set(turn.conversationKey, retainedPage);
    }
    const reuseConversation = Boolean(retainedPage);
    if (turn.requireRetainedConversation && !reuseConversation) {
      throw chatGptRetainedConversationUnavailableError();
    }
    const prepare = reuseConversation ? turn.prepareResume : turn.prepare;
    if (!prepare) {
      throw new Error("A retained ChatGPT conversation has no canonical continuation prompt");
    }
    const prepared = await prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
    );
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    let stopRoxyPreview: (() => void) | undefined;
    let completed = false;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const multipartTransactionId = prepared.multipart
        ? `ctx_${randomUUID().replaceAll("-", "")}`
        : undefined;
      const multipartStages = prepared.multipart && multipartTransactionId
        ? prepared.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
          payload,
          multipartTransactionId,
          index + 1,
          prepared.multipart!.parts.length,
        ))
        : undefined;
      const multipartFinalPrompt = prepared.multipart && multipartTransactionId
        ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
        : undefined;
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      const maxMessageChars = compiledChatGptWebMaxMessageChars(prepared);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map(stage => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map(stage => stage.text.length))
        : undefined;
      const stagingMode = multipartStages
        ? resolveChatGptWebMultipartStagingMode(
          turn.modelId,
          turn.capabilities,
          requestedMode.effort,
          maxStageMessageTokens!,
          maxStageChars!,
        )
        : requestedMode;
      if (prepared.multipart) {
        assertChatGptWebMultipartInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          turn.capabilities,
          maxMessageChars,
          prepared.multipart.parts.length,
          multipartStages
            && multipartFinalPrompt
            && maxStageMessageTokens !== undefined
            && maxStageChars !== undefined ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: estimateTokens(multipartFinalPrompt, turn.modelId),
            finalMessageChars: multipartFinalPrompt.length,
          } : undefined,
        );
      } else {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          turn.capabilities,
          maxMessageChars,
        );
      }
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
        if (retainedPage) return retainedPage;
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId && !reuseConversation) managedPage = page;
      diagnosticPage = page;
      if (launcherExternal?.externalHost === "roxybrowser") {
        this.externalTurnPages.set(turn.traceId, page);
        if (this.roxyOpenedByAutomation) {
          await this.minimizeExternalBrowserPage(page).catch(error => {
            console.warn(
              `[chatgpt-web] RoxyBrowser task page could not be minimized for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        if (launcherExternal.previewEnabled) stopRoxyPreview = this.startRoxyPreviewLoop(page, turn.traceId);
      }
      await diagnostics.capture(page, reuseConversation ? "browser-page-retained" : "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.multipart ? `multipart-${prepared.multipart.parts.length}` : "inline"}, retained=${reuseConversation}, maxMessageChars=${maxMessageChars}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareTemporaryChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
          ),
        );
      }
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          stagingMode.effort,
          turn.capabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
        )
      ));
      await diagnostics.capture(page, "effort-selection-complete");

      if (prepared.multipart && multipartStages && multipartTransactionId && multipartFinalPrompt) {
        for (let index = 0; index < multipartStages.length; index += 1) {
          const stage = multipartStages[index]!;
          const stageBaseline = await this.captureSubmissionBaseline(page);
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            stageSignal => this.attachPrompt(
              page,
              stage.text,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);
          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.send,
            stageSignal => this.sendAttachedPrompt(
              page,
              stageBaseline,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
          );
          const responseTurn = stageBaseline.responseTurns.nth(stageBaseline.initialResponseTurnCount);
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart.parts.length} submission accepted evidence=${evidence}`,
          );
          await this.waitForMultipartAcknowledgement(
            page,
            responseTurn,
            stage,
            deadline,
            turn.abortSignal,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
        }
        if (mode.effort !== requestedMode.effort) {
          mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              turn.capabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
            ),
          );
          await diagnostics.capture(page, "final-part-effort-selected");
        }
      }

      const submissionBaseline = await this.captureSubmissionBaseline(page);
      const finalPrompt = multipartFinalPrompt ?? prepared.text;
      // A retained conversation already proved its connector binding. Multipart staging also
      // consumes the same conversation, so catalog refresh must not reload away acknowledged parts.
      let catalogRefreshAvailable = requestedMode.connectorTools && !reuseConversation && !prepared.multipart;
      for (;;) {
        try {
          await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, (stageSignal) => {
            const promptAbortSignal = turn.abortSignal
              ? AbortSignal.any([stageSignal, turn.abortSignal])
              : stageSignal;
            return this.attachPromptWithCompactionRetry(
              page,
              finalPrompt,
              mode.connectorTools,
              turn.compaction === true,
              submissionBaseline,
              checkpoint => diagnostics.capture(page, checkpoint),
              promptAbortSignal,
              catalogRefreshAvailable,
              reuseConversation,
            );
          });
          break;
        } catch (error) {
          if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
          catalogRefreshAvailable = false;
          await diagnostics.capture(page, "connector-catalog-stale");
          await this.runStage(
            turn.traceId,
            "connector_catalog_refresh",
            browserStageTimeouts.temporaryChatPreparation,
            async () => {
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await this.prepareTemporaryChatSurface(
                page,
                checkpoint => diagnostics.capture(page, checkpoint),
              );
            },
          );
          await diagnostics.capture(page, "connector-catalog-refreshed");
        }
      }
      await diagnostics.capture(page, "prompt-attachment-complete");
      const promptFiles = chatGptPromptFilePayloads(prepared);
      const promptFileBytes = promptFiles.reduce((total, file) => total + file.buffer.length, 0);
      const fileAttachmentTimeoutMs = chatGptFileAttachmentTimeoutMs(promptFiles.length, promptFileBytes);
      await this.runStage(turn.traceId, "file_attachment", fileAttachmentTimeoutMs, () => (
        this.attachFiles(page, promptFiles)
      ));
      await diagnostics.capture(page, "file-attachment-complete");
      const sendTimeoutMs = chatGptSendStageTimeoutMs(promptFiles.length, promptFileBytes);
      if (promptFiles.length > 0) {
        console.info(
          `[chatgpt-web] browser turn ${turn.traceId} attachment budget images=${promptFiles.length}`
          + ` bytes=${promptFileBytes} uploadTimeoutMs=${fileAttachmentTimeoutMs} sendTimeoutMs=${sendTimeoutMs}`,
        );
      }
      const responseTurn = submissionBaseline.responseTurns.nth(submissionBaseline.initialResponseTurnCount);
      const finalEvidence = await this.runStage(turn.traceId, "send", sendTimeoutMs, stageSignal => (
        this.sendAttachedPrompt(page, submissionBaseline, checkpoint => diagnostics.capture(page, checkpoint), stageSignal)
      ));
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalEvidence}`);
      await diagnostics.capture(page, "send-accepted");

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      const sentAt = Date.now();
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownBuffer = new ChatGptMarkdownBuffer();
      const checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
      const completionTracker = new ChatGptCompletionTracker();
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
      let completionFenceRevision: number | undefined;
      for (;;) {
        if (page.isClosed()) {
          throw chatGptBrowserTabClosedError();
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptTerminalErrorAlert(responseTurn);

        if (mode.connectorTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const snapshot = await this.responseDomSnapshot(responseTurn);
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (turn.externalProgress
          && externalProgressSnapshot
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            snapshot.visibleText,
          );
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
        if (!snapshot.responsePresent && externalProgressLive) {
          domHealthTracker.clearMissingResponse();
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          // Tool-capable turns may replace provisional Markdown between MCP calls. Keep
          // commentary/reasoning live, but defer irreversible final-answer deltas until ChatGPT
          // exposes terminal completion evidence. Browser-only turns keep the existing streaming path.
          const textDelta = markdownBuffer.observe(
            snapshot.markdownSegments,
            Date.now(),
            !mode.localTools,
          );
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
          const completionReady = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            externalToolCallsInFlight,
          });
          if (!completionReady) completionFenceRevision = undefined;
          if (completionReady) {
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                const revision = await turn.completionFence.begin();
                if (revision === undefined) {
                  await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                  continue;
                }
                completionFenceRevision = revision;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
              if (!await turn.completionFence.commit(completionFenceRevision)) {
                completionFenceRevision = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
            }
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = markdownBuffer.finish();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = turn.capabilities.localToolTransport === "responses"
                ? selectDirectToolBridgeTransportText(final.markdown, snapshot.visibleText)
                : final.markdown;
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-30s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
      }

      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      completed = true;
      if (externalRetention && turn.retainConversation && turn.conversationKey && !page.isClosed()) {
        this.retainedExternalPages.set(turn.conversationKey, page);
      }
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length}, retained=${externalRetention && turn.retainConversation})`);
      return finalText;
    } catch (error) {
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      stopRoxyPreview?.();
      this.externalTurnPages.delete(turn.traceId);
      this.turnStages.delete(turn.traceId);
      prepared.release();
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else {
        const shouldRetain = completed
          && externalRetention
          && turn.retainConversation === true
          && turn.conversationKey !== undefined
          && diagnosticPage !== undefined
          && !diagnosticPage.isClosed();
        if (!shouldRetain && turn.conversationKey && this.retainedExternalPages.get(turn.conversationKey) === diagnosticPage) {
          this.retainedExternalPages.delete(turn.conversationKey);
        }
        const pageToClose = shouldRetain
          ? undefined
          : managedPage ?? (reuseConversation ? diagnosticPage : undefined);
        if (pageToClose && !pageToClose.isClosed()) {
          await pageToClose.close().catch(error => {
            console.error(
              `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }
    }
  }
}
