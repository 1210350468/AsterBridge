/**
 * Remote compaction v2 support for ROUTED providers.
 *
 * Codex decides "this provider supports remote compaction" by provider name (built-in `OpenAI`),
 * and Design B points that provider at this proxy — so Codex sends remote compaction v2 requests
 * for EVERY routed model. The request is a normal /responses call whose input ends with
 * `{"type":"compaction_trigger"}`; codex-rs `collect_compaction_output` then requires the stream
 * to carry EXACTLY ONE `{"type":"compaction","encrypted_content":...}` output item
 * (compact_remote_v2.rs) or it fatals with "expected exactly one compaction output item".
 *
 * Routed models cannot produce OpenAI's encrypted blob, so the proxy runs the model as a plain
 * summarizer and wraps the summary text in a transparent envelope: `ocx1:` + base64(utf8 summary).
 * Codex stores the item and replays it in later input; the parser decodes our envelope back into
 * plain text for routed models. Real OpenAI-encrypted blobs (no `ocx1:` prefix) are opaque —
 * routed models get a short "history was compacted" note instead.
 */

import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../chatgpt-web-models";
import { estimateTokens } from "../lib/token-estimate";

export const BRIDGE_COMPACTION_PREFIX = "ocx1:";

/** Mirrors codex-rs core/templates/compact/prompt.md (the local-compaction instruction). */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** Mirrors codex-rs core/templates/compact/summary_prefix.md (framing for a replayed summary). */
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";

/** Codex v1 uses one newline after the prefix; the transparent v2 replay uses two. */
export function isReadableCompactionSummaryText(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${SUMMARY_PREFIX}\n`);
}

export function encodeCompactionSummary(summary: string): string {
  return BRIDGE_COMPACTION_PREFIX + Buffer.from(summary, "utf-8").toString("base64");
}

/** Decode an `ocx1:` envelope; returns null for real (OpenAI-encrypted) blobs or garbage. */
export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(BRIDGE_COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(encryptedContent.slice(BRIDGE_COMPACTION_PREFIX.length), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Render a replayed compaction item as plain user-visible text for a routed model. */
export function compactionItemToText(encryptedContent: string | undefined): string {
  const decoded = typeof encryptedContent === "string" ? decodeCompactionSummary(encryptedContent) : null;
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

/**
 * Remote compaction v1 (`POST /responses/compact`, unary) — codex-rs installs the returned
 * `{"output":[ResponseItem...]}` as the REPLACEMENT history (compact_remote.rs
 * process_compacted_history). Mirror codex-rs local `build_compacted_history`: recent real user
 * messages within a token budget, then one user message `SUMMARY_PREFIX\n<summary>`. Plain user
 * message items parse as real user messages on the codex side (event_mapping parse_user_message);
 * contextual wrappers are filtered there, and v2-style `compaction` items are NOT expected here.
 */

/** codex-rs compact.rs COMPACT_USER_MESSAGE_MAX_TOKENS = 20k tokens. */
export const COMPACT_V1_MAX_RETAINED_HISTORY_TOKENS = 20_000;
/**
 * Installed Codex 0.149/0.150 turns with the normal AsterBridge system/developer/skills/plugins
 * surface consume roughly 17k tokens before retained user history. Keep that measured floor even
 * when a compact request omits some stable harness material from its wire body; requests that do
 * expose more instructions/tools reserve their larger measured cost instead.
 */
export const COMPACT_V1_MIN_STABLE_HARNESS_RESERVE_TOKENS = 17_000;
/** Leave room for the first useful post-compact turn instead of compacting directly onto the gate. */
export const COMPACT_V1_MIN_POST_COMPACT_HEADROOM_TOKENS = 6_000;
const COMPACT_V1_POST_COMPACT_HEADROOM_FRACTION = 0.10;
const COMPACT_V1_REPLACEMENT_STRUCTURE_RESERVE_TOKENS = 512;
const COMPACT_V1_IMAGE_RESERVE_TOKENS = 4_096;
const COMPACT_V1_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;

export interface CompactV1BudgetPlan {
  autoCompactTokenLimit: number;
  stableHarnessReserveTokens: number;
  postCompactHeadroomTokens: number;
  summaryTokens: number;
  structureReserveTokens: number;
  retainedHistoryTokenBudget: number;
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * Estimate stable context that Codex will re-inject around the compacted replacement history.
 * Hidden ChatGPT/Codex-Native product state is always reserved; visible instructions, developer /
 * system items and tool schemas are added when the compact wire exposes them. The measured 17k
 * floor prevents an apparently sparse compact request from under-reserving the actual harness.
 */
export function estimateCompactV1StableHarnessTokens(request: Record<string, unknown>): number {
  let measured = CHATGPT_WEB_PLATFORM_RESERVE_TOKENS;
  if (typeof request.instructions === "string" && request.instructions.length > 0) {
    measured += estimateTokens(request.instructions);
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    measured += estimateJsonTokens(request.tools);
  }
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (rec.role === "system" || rec.role === "developer") {
        measured += estimateJsonTokens(rec.content ?? rec);
      }
      if (rec.type === "additional_tools" && Array.isArray(rec.tools)) {
        measured += estimateJsonTokens(rec.tools);
      }
    }
  }
  return Math.max(COMPACT_V1_MIN_STABLE_HARNESS_RESERVE_TOKENS, measured);
}

/**
 * Plan the replacement-history budget against the routed model's real automatic-compaction gate.
 * The summary and stable harness are non-negotiable; only recent historical user material may use
 * the remainder. This prevents a successful compact from immediately crossing the same threshold
 * again as soon as Codex re-installs its system/skills/plugins context.
 */
export function planCompactV1Budget(
  autoCompactTokenLimit: number,
  summary: string,
  request: Record<string, unknown>,
): CompactV1BudgetPlan {
  if (!Number.isSafeInteger(autoCompactTokenLimit) || autoCompactTokenLimit <= 0) {
    throw new Error("autoCompactTokenLimit must be a positive integer");
  }
  const stableHarnessReserveTokens = estimateCompactV1StableHarnessTokens(request);
  const postCompactHeadroomTokens = Math.max(
    COMPACT_V1_MIN_POST_COMPACT_HEADROOM_TOKENS,
    Math.ceil(autoCompactTokenLimit * COMPACT_V1_POST_COMPACT_HEADROOM_FRACTION),
  );
  const summaryTokens = estimateTokens(`${SUMMARY_PREFIX}\n${summary}`);
  const available = autoCompactTokenLimit
    - stableHarnessReserveTokens
    - postCompactHeadroomTokens
    - summaryTokens
    - COMPACT_V1_REPLACEMENT_STRUCTURE_RESERVE_TOKENS;
  return {
    autoCompactTokenLimit,
    stableHarnessReserveTokens,
    postCompactHeadroomTokens,
    summaryTokens,
    structureReserveTokens: COMPACT_V1_REPLACEMENT_STRUCTURE_RESERVE_TOKENS,
    retainedHistoryTokenBudget: Math.max(
      0,
      Math.min(COMPACT_V1_MAX_RETAINED_HISTORY_TOKENS, available),
    ),
  };
}

type CompactMessageItem = Record<string, unknown>;

interface CompactContentBlock extends Record<string, unknown> {
  type?: string;
  text?: string;
  image_url?: string;
}

/**
 * Codex can persist unavailable historical images as a one-pixel PNG. Replaying that sentinel as
 * a real attachment produces an opaque black tile in ChatGPT and consumes one attachment slot,
 * but carries no visual information. Treat every 1x1 PNG data URL as non-semantic transport state.
 */
export function isOnePixelPngDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return false;
  try {
    const png = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
    return png.length >= 24
      && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1
      && png.readUInt32BE(20) === 1;
  } catch {
    return false;
  }
}

/**
 * Extract original user message items from a Responses `input` array.
 *
 * Keeping the original item metadata matters: Codex uses it after `/responses/compact` to
 * distinguish real user turns from contextual user-role wrappers. Images remain structured
 * `input_image` blocks so the browser adapter can upload them as attachments; their data URL is
 * never copied into the textual ChatGPT transport envelope.
 */
export function extractCompactUserMessages(input: unknown): CompactMessageItem[] {
  if (!Array.isArray(input)) return [];
  const out: CompactMessageItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as CompactMessageItem & { type?: string; role?: string; content?: unknown };
    if (rec.type !== undefined && rec.type !== "message") continue;
    if (rec.role !== "user") continue;
    out.push(structuredClone(rec));
  }
  return out;
}

function compactUserMessageItem(text: string): CompactMessageItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function compactContentBlocks(item: CompactMessageItem): CompactContentBlock[] {
  if (typeof item.content === "string") {
    return [{ type: "input_text", text: item.content }];
  }
  if (!Array.isArray(item.content)) return [];
  return item.content
    .filter((block): block is CompactContentBlock => Boolean(block && typeof block === "object" && !Array.isArray(block)))
    .map(block => structuredClone(block));
}

function textBlock(block: CompactContentBlock): boolean {
  return (block.type === "input_text" || block.type === "text") && typeof block.text === "string";
}

function imageBlock(block: CompactContentBlock): boolean {
  return block.type === "input_image"
    && typeof block.image_url === "string"
    && !isOnePixelPngDataUrl(block.image_url);
}

function imageReserveTokens(block: CompactContentBlock): number {
  return block.detail === "original"
    ? COMPACT_V1_ORIGINAL_IMAGE_RESERVE_TOKENS
    : COMPACT_V1_IMAGE_RESERVE_TOKENS;
}

function suffixWithinTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= tokenBudget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    let mid = Math.floor((low + high) / 2);
    if (mid > 0) {
      const code = text.charCodeAt(mid);
      if (code >= 0xDC00 && code <= 0xDFFF) mid -= 1;
    }
    const candidate = text.slice(mid);
    if (estimateTokens(candidate) > tokenBudget) low = Math.max(mid + 1, low + 1);
    else high = mid;
  }
  let start = Math.min(low, text.length);
  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xDC00 && code <= 0xDFFF) start += 1;
  }
  let candidate = text.slice(start);
  while (candidate.length > 0 && estimateTokens(candidate) > tokenBudget) {
    start += text.codePointAt(start)! > 0xFFFF ? 2 : 1;
    candidate = text.slice(start);
  }
  return candidate;
}

export interface CompactV1OutputOptions {
  maxImages?: number;
  /**
   * When provided, text and images share this model-aware token budget. Without it the helper keeps
   * the historical Codex-compatible 20k text budget and the independent ten-image cap.
   */
  retainedHistoryTokenBudget?: number;
}

/**
 * Build the v1 compact replacement history.
 *
 * Production callers pass a model-aware retained-history budget. Text is counted with the GPT-5
 * tokenizer and retained images consume the same budget using the browser input estimator's image
 * reserves, so a successful compact cannot immediately refill a small routed context window.
 */
function selectCompactV1UserMessages(
  userMessages: CompactMessageItem[],
  options: CompactV1OutputOptions = {},
): CompactMessageItem[] {
  const selected: CompactMessageItem[] = [];
  const maxImages = options.maxImages ?? 10;
  const sharedTokenBudget = options.retainedHistoryTokenBudget;
  let remainingTokens = sharedTokenBudget ?? COMPACT_V1_MAX_RETAINED_HISTORY_TOKENS;
  let retainedImages = 0;
  for (let i = userMessages.length - 1; i >= 0 && (remainingTokens > 0 || (sharedTokenBudget === undefined && retainedImages < maxImages)); i--) {
    const message = structuredClone(userMessages[i]!);
    const blocks = compactContentBlocks(message);
    const retainedReversed: CompactContentBlock[] = [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      if (imageBlock(block)) {
        if (retainedImages < maxImages) {
          const cost = sharedTokenBudget === undefined ? 0 : imageReserveTokens(block);
          if (cost <= remainingTokens) {
            retainedImages += 1;
            remainingTokens -= cost;
            retainedReversed.push(block);
          }
        }
        continue;
      }
      if (!textBlock(block) || remainingTokens === 0) continue;
      const text = block.text!;
      const textTokens = estimateTokens(text);
      if (textTokens <= remainingTokens) {
        remainingTokens -= textTokens;
        retainedReversed.push({ ...block, type: "input_text", text });
      } else {
        const suffix = suffixWithinTokenBudget(text, remainingTokens);
        if (suffix.length > 0) {
          remainingTokens -= estimateTokens(suffix);
          retainedReversed.push({ ...block, type: "input_text", text: suffix });
        }
      }
    }
    const content = retainedReversed.reverse();
    if (content.length > 0) {
      message.type = "message";
      message.role = "user";
      message.content = content;
      selected.push(message);
    }
  }
  selected.reverse();
  return selected;
}

export function buildCompactV1Output(
  userMessages: CompactMessageItem[],
  summary: string,
  options: CompactV1OutputOptions = {},
): CompactMessageItem[] {
  // codex-rs compact.rs uses "{SUMMARY_PREFIX}\n{summary}" (single newline) and detects stored
  // summaries by that exact prefix — keep the same shape.
  const summaryText = summary.trim().length > 0 ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  return [...selectCompactV1UserMessages(userMessages, options), compactUserMessageItem(summaryText)];
}

/**
 * Bridge a modern native `compaction_trigger` result back into the legacy compact endpoint shape.
 * The official opaque compaction item remains authoritative; AsterBridge only supplies the same
 * bounded recent-user prefix used by routed Web v1 compaction so an old Codex client never needs
 * the retired upstream `/responses/compact` endpoint.
 */
export function buildNativeCompactV1Output(
  userMessages: CompactMessageItem[],
  compactionItem: CompactMessageItem,
  options: CompactV1OutputOptions = {},
): CompactMessageItem[] {
  if (compactionItem.type !== "compaction" && compactionItem.type !== "context_compaction") {
    throw new Error("Native compact fallback requires an official compaction output item");
  }
  return [...selectCompactV1UserMessages(userMessages, options), structuredClone(compactionItem)];
}
