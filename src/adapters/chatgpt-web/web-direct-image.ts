import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  assertAuthenticatedChatGptPage,
} from "../../chatgpt-session";
import { ensureRoxyBrowserEndpoint } from "../../roxy-browser-host";
import { discoverSystemBrowserEndpoint, openSystemBrowserTaskWindow } from "../../system-browser-host";
import type { BrokerToolResult } from "./turn-broker";
import type { ChatGptTurnEnvironment } from "./environment";

const CHATGPT_NORMAL_CHAT_URL = "https://chatgpt.com/";
const WEB_DIRECT_IMAGE_TIMEOUT_MS = 300_000;
const WEB_DIRECT_IMAGE_POLL_MS = 750;
const MAX_REFERENCE_IMAGES = 5;

interface BrowserFetchImageResult {
  status: number;
  contentType: string;
  base64: string;
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

function normalizedReferencePaths(args: Record<string, unknown>): string[] {
  const raw = args.referenced_image_paths;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some(value => typeof value !== "string")) {
    throw new Error("Web Direct image generation requires referenced_image_paths to be an array of local paths");
  }
  if (raw.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Web Direct image generation supports at most ${MAX_REFERENCE_IMAGES} explicit reference images`);
  }
  const paths = raw.map(value => value.trim()).filter(Boolean);
  if (paths.some(path => !isAbsolute(path))) {
    throw new Error("Web Direct image generation requires absolute reference-image paths");
  }
  return paths;
}

export function webDirectImageRequestSupported(args: Record<string, unknown>): boolean {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) return false;
  const explicitReferences = Array.isArray(args.referenced_image_paths)
    && args.referenced_image_paths.some(value => typeof value === "string" && value.trim().length > 0);
  const historyReferences = typeof args.num_last_images_to_include === "number"
    && Number.isFinite(args.num_last_images_to_include)
    && args.num_last_images_to_include > 0;
  // The browser path can upload explicit local files exactly. It cannot safely infer which historical
  // Codex image files correspond to num_last_images_to_include, so never silently drop that intent.
  return explicitReferences || !historyReferences;
}

async function connectImageBrowser(
  environment: ChatGptTurnEnvironment,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const image = environment.imageGeneration;
  if (!image) throw new Error("Web Direct image generation is missing browser configuration");
  if (image.browserHost === "roxybrowser") {
    if (!image.roxyBrowserProfileId || !image.roxyBrowserDataDir) {
      throw new Error("Web Direct image generation requires the configured RoxyBrowser profile and data directory");
    }
    const endpoint = await ensureRoxyBrowserEndpoint(
      image.roxyBrowserProfileId,
      image.roxyBrowserDataDir,
      {
        autoOpen: image.roxyBrowserAutoOpen === true,
        apiHost: image.roxyBrowserApiHost,
        apiKeyFile: image.roxyBrowserApiKeyFile,
      },
    );
    const browser = await chromium.connectOverCDP(endpoint.endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error("Web Direct image generation connected to RoxyBrowser but found no browser context");
    }
    return { browser, context, page: await context.newPage() };
  }
  if (image.browserHost === "system-browser") {
    const endpoint = await discoverSystemBrowserEndpoint(image.systemBrowserChannel ?? "auto");
    const browser = await chromium.connectOverCDP(endpoint.endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error("Web Direct image generation connected to the system browser but found no browser context");
    }
    return { browser, context, page: await openSystemBrowserTaskWindow(browser, context) };
  }
  throw new Error("Web Direct image generation currently requires RoxyBrowser or the system browser");
}

async function browserFetchImage(page: Page, src: string): Promise<BrowserFetchImageResult> {
  return await page.evaluate(async source => {
    const response = await fetch(source, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`generated image download returned HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "image/png",
      base64: btoa(binary),
    };
  }, src);
}

async function waitForGeneratedImage(page: Page, initialAssistantTurns: number): Promise<{ src: string; text: string }> {
  const deadline = Date.now() + WEB_DIRECT_IMAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const turns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const count = await turns.count().catch(() => 0);
    if (count > initialAssistantTurns) {
      const turn = turns.nth(count - 1);
      const text = (await turn.innerText().catch(() => "")).trim();
      const stopped = !await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).isVisible().catch(() => false);
      const completed = await turn.locator(CHATGPT_COMPLETION_ACTION_SELECTOR).count().catch(() => 0) > 0;
      if (stopped && completed) {
        const candidates = await turn.locator("img").evaluateAll(elements => elements
          .map(element => {
            const image = element as HTMLImageElement;
            return {
              src: image.src,
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
          })
          .filter(candidate => candidate.src.startsWith("https://") && candidate.width >= 256 && candidate.height >= 256)
          .sort((left, right) => (right.width * right.height) - (left.width * left.height)));
        if (candidates[0]?.src) return { src: candidates[0].src, text };
        if (text) {
          throw new Error(`ChatGPT Web Direct completed without a generated image: ${text.slice(0, 500)}`);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, WEB_DIRECT_IMAGE_POLL_MS));
  }
  throw new Error(`ChatGPT Web Direct image generation did not finish within ${WEB_DIRECT_IMAGE_TIMEOUT_MS}ms`);
}

function outputPath(environment: ChatGptTurnEnvironment, mimeType: string): string {
  const safeThread = environment.imageGeneration?.threadId?.replace(/[^A-Za-z0-9_-]/g, "") || "web-direct";
  const directory = join(homedir(), ".codex", "generated_images", safeThread);
  mkdirSync(directory, { recursive: true });
  const extension = mimeType.includes("jpeg") ? ".jpg" : mimeType.includes("webp") ? ".webp" : ".png";
  return join(directory, `asterbridge-web-${randomUUID()}${extension}`);
}

export async function generateImageViaChatGptWeb(
  environment: ChatGptTurnEnvironment,
  args: Record<string, unknown>,
): Promise<BrokerToolResult> {
  if (!webDirectImageRequestSupported(args)) {
    throw new Error("Web Direct cannot preserve num_last_images_to_include without explicit referenced_image_paths; use Codex Tool for this image request");
  }
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("Web Direct image generation requires a non-empty prompt");
  const referencePaths = normalizedReferencePaths(args);
  const startedAt = Date.now();
  const { browser, page } = await connectImageBrowser(environment);
  try {
    await page.goto(CHATGPT_NORMAL_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await assertAuthenticatedChatGptPage(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    if (referencePaths.length > 0) {
      const files = referencePaths.map(path => ({
        name: path.split(/[\\/]/).at(-1) || "reference.png",
        mimeType: imageMimeType(path),
        buffer: readFileSync(path),
      }));
      const input = page.locator('input[data-testid="upload-photos-input"]');
      await input.waitFor({ state: "attached", timeout: 20_000 });
      await input.setInputFiles(files);
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    }
    const initialAssistantTurns = await page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR).count();
    await composer.fill(prompt);
    const send = composerForm.getByTestId("send-button");
    await send.waitFor({ state: "visible", timeout: 30_000 });
    const readyDeadline = Date.now() + 60_000;
    while (!await send.isEnabled().catch(() => false)) {
      if (Date.now() >= readyDeadline) {
        throw new Error("ChatGPT Web Direct attachments did not become ready to send");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await send.click();
    const generated = await waitForGeneratedImage(page, initialAssistantTurns);
    const fetched = await browserFetchImage(page, generated.src);
    if (fetched.status !== 200 || !fetched.contentType.startsWith("image/")) {
      throw new Error(`Web Direct generated-image response is invalid (${fetched.status} ${fetched.contentType})`);
    }
    const path = outputPath(environment, fetched.contentType);
    const bytes = Buffer.from(fetched.base64, "base64");
    writeFileSync(path, bytes);
    console.info(`[asterbridge:image] provider=web-direct durationMs=${Date.now() - startedAt} status=200 bytes=${bytes.length}`);
    const normalizedPath = path.replaceAll("\\", "/");
    return {
      content: [
        {
          type: "text",
          text: `AsterBridge authoritative status for this image-generation invocation: SUCCESS via Web Direct. The generated image was saved to ${normalizedPath}. This current success supersedes earlier image-generation failures. In the final answer, display the generated image using this exact absolute local Markdown path: ![Generated image](${normalizedPath})`,
        },
        { type: "image", data: fetched.base64, mimeType: fetched.contentType },
      ],
      structuredContent: {
        provider: "web-direct",
        succeeded: true,
        path: normalizedPath,
        mimeType: fetched.contentType,
        bytes: bytes.length,
      },
      _meta: {
        asterbridge: {
          category: "image_generation_success",
          provider: "web-direct",
          authoritative: true,
          succeeded: true,
        },
      },
    };
  } catch (error) {
    console.warn(`[asterbridge:image] provider=web-direct durationMs=${Date.now() - startedAt} status=failed error=${error instanceof Error ? error.message : String(error)}`);
    return {
      content: [{
        type: "text",
        text: `AsterBridge authoritative status for this Web Direct image-generation invocation: FAILED. ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
      _meta: {
        asterbridge: {
          category: "image_web_direct_failure",
          provider: "web-direct",
          authoritative: true,
          retryable: true,
        },
      },
    };
  } finally {
    await page.close().catch(() => {});
    // connectOverCDP close disconnects this Playwright client; it does not close the external browser profile.
    await browser.close().catch(() => {});
  }
}
