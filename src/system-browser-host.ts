import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

export type SystemBrowserChannel = "auto" | "chrome" | "msedge";

export interface SystemBrowserEndpoint {
  channel: Exclude<SystemBrowserChannel, "auto">;
  userDataDir: string;
  endpoint: string;
  discoveredAtMs: number;
}

export function systemBrowserUserDataDir(
  channel: Exclude<SystemBrowserChannel, "auto">,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string | undefined {
  if (channel === "chrome") {
    if (platform === "win32") {
      return join(environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"), "Google", "Chrome", "User Data");
    }
    if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", "Google", "Chrome");
    if (platform === "linux") return join(homeDirectory, ".config", "google-chrome");
    return undefined;
  }
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"), "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", "Microsoft Edge");
  if (platform === "linux") return join(homeDirectory, ".config", "microsoft-edge");
  return undefined;
}

export function parseDevToolsActivePort(contents: string): { port: number; path: string } | undefined {
  const lines = contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return undefined;
  const port = Number.parseInt(lines[0]!, 10);
  const path = lines[1]!;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !path.startsWith("/")) return undefined;
  return { port, path };
}

async function loopbackPortIsOpen(port: number): Promise<boolean> {
  return await new Promise(resolveOpen => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export async function openSystemBrowserTaskWindow(
  browser: Browser,
  context: BrowserContext,
): Promise<Page> {
  const session = await browser.newBrowserCDPSession();
  const markerUrl = `about:blank#codex-web-gpt-${randomUUID()}`;
  try {
    const pagePromise = context.waitForEvent("page", {
      predicate: page => page.url() === markerUrl,
      timeout: 15_000,
    });
    const [, page] = await Promise.all([
      session.send("Target.createTarget", {
        url: markerUrl,
        newWindow: true,
        background: true,
      }),
      pagePromise,
    ]);
    return page;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function discoverSystemBrowserEndpoint(
  channel: SystemBrowserChannel = "auto",
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): Promise<SystemBrowserEndpoint> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const channels: Array<Exclude<SystemBrowserChannel, "auto">> = channel === "auto"
    ? ["chrome", "msedge"]
    : [channel];
  const found: SystemBrowserEndpoint[] = [];

  for (const candidate of channels) {
    const userDataDir = systemBrowserUserDataDir(candidate, platform, environment, homeDirectory);
    if (!userDataDir) continue;
    const portFile = join(userDataDir, "DevToolsActivePort");
    let parsed: ReturnType<typeof parseDevToolsActivePort>;
    let discoveredAtMs = 0;
    try {
      parsed = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
      discoveredAtMs = statSync(portFile).mtimeMs;
    } catch {
      continue;
    }
    if (!parsed || !await loopbackPortIsOpen(parsed.port)) continue;
    found.push({
      channel: candidate,
      userDataDir,
      endpoint: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
      discoveredAtMs,
    });
  }

  if (found.length === 0) {
    const target = channel === "auto" ? "Chrome or Edge" : channel === "chrome" ? "Chrome" : "Edge";
    const inspectUrl = channel === "msedge" ? "edge://inspect/#remote-debugging" : "chrome://inspect/#remote-debugging";
    throw new Error(
      `${target} main-browser debugging is not enabled. Open ${inspectUrl} in the browser, enable `
      + '"Allow remote debugging for this browser instance", approve the connection prompt, then retry.',
    );
  }

  found.sort((a, b) => b.discoveredAtMs - a.discoveredAtMs);
  return found[0]!;
}
