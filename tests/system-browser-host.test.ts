import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import {
  discoverSystemBrowserEndpoint,
  openSystemBrowserTaskWindow,
  parseDevToolsActivePort,
  systemBrowserUserDataDir,
} from "../src/system-browser-host";

test("parses Chrome DevToolsActivePort metadata", () => {
  expect(parseDevToolsActivePort("9222\n/devtools/browser/abcdef\n")).toEqual({
    port: 9222,
    path: "/devtools/browser/abcdef",
  });
  expect(parseDevToolsActivePort("not-a-port\n/devtools/browser/x\n")).toBeUndefined();
  expect(parseDevToolsActivePort("70000\n/devtools/browser/x\n")).toBeUndefined();
  expect(parseDevToolsActivePort("9222\nnot-a-path\n")).toBeUndefined();
});

test("resolves standard Chrome and Edge user-data roots on Windows", () => {
  const environment = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" };
  expect(systemBrowserUserDataDir("chrome", "win32", environment, "C:\\Users\\tester")).toBe(
    "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  expect(systemBrowserUserDataDir("msedge", "win32", environment, "C:\\Users\\tester")).toBe(
    "C:\\Users\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data",
  );
});

async function listenLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test TCP server has no numeric address");
  return { server, port: address.port };
}

test("auto mode selects the most recently enabled Chrome or Edge debugging session", async () => {
  const root = join(tmpdir(), `codex-system-browser-${crypto.randomUUID()}`);
  const chrome = join(root, ".config", "google-chrome");
  const edge = join(root, ".config", "microsoft-edge");
  mkdirSync(chrome, { recursive: true });
  mkdirSync(edge, { recursive: true });
  const chromeListener = await listenLoopback();
  const edgeListener = await listenLoopback();
  try {
    writeFileSync(join(chrome, "DevToolsActivePort"), `${chromeListener.port}\n/devtools/browser/chrome\n`);
    const waitUntil = Date.now() + 15;
    while (Date.now() < waitUntil) {}
    writeFileSync(join(edge, "DevToolsActivePort"), `${edgeListener.port}\n/devtools/browser/edge\n`);
    const result = await discoverSystemBrowserEndpoint("auto", {
      platform: "linux",
      homeDirectory: root,
    });
    expect(result.channel).toBe("msedge");
    expect(result.endpoint).toBe(`ws://127.0.0.1:${edgeListener.port}/devtools/browser/edge`);
  } finally {
    chromeListener.server.close();
    edgeListener.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("system-browser turns open an isolated top-level window in the attached main profile", async () => {
  let createdUrl = "";
  let detached = false;
  let targetOptions: Record<string, unknown> | undefined;
  const page = { url: () => createdUrl };
  const browser = {
    newBrowserCDPSession: async () => ({
      send: async (method: string, options: Record<string, unknown>) => {
        expect(method).toBe("Target.createTarget");
        targetOptions = options;
        createdUrl = String(options.url);
        return { targetId: "task-window" };
      },
      detach: async () => { detached = true; },
    }),
  };
  const context = {
    waitForEvent: async (event: string, options: { predicate: (candidate: typeof page) => boolean }) => {
      expect(event).toBe("page");
      while (!createdUrl) await Promise.resolve();
      expect(options.predicate(page)).toBeTrue();
      return page;
    },
  };

  const opened = await openSystemBrowserTaskWindow(browser as never, context as never);
  expect(opened).toBe(page as never);
  expect(targetOptions?.newWindow).toBeTrue();
  expect(targetOptions?.background).toBeTrue();
  expect(String(targetOptions?.url)).toStartWith("about:blank#codex-web-gpt-");
  expect(detached).toBeTrue();
});

test("system browser discovery fails with actionable remote-debugging instructions", async () => {
  const root = join(tmpdir(), `codex-system-browser-missing-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    await expect(discoverSystemBrowserEndpoint("chrome", {
      platform: "win32",
      environment: { LOCALAPPDATA: root },
      homeDirectory: root,
    })).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging.*Allow remote debugging/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
