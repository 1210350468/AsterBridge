import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRoxyBrowserEndpoint,
  parseRoxyDevToolsActivePort,
  probeRoxyBrowserLocalApi,
  roxyBrowserProfileDir,
  validateRoxyBrowserApiHost,
  validateRoxyBrowserProfileId,
} from "../src/roxy-browser-host";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roxy-browser-host-"));
  tempRoots.push(root);
  return root;
}

describe("RoxyBrowser host", () => {
  test("accepts an opaque safe profile id", () => {
    expect(validateRoxyBrowserProfileId("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
  });

  test("rejects profile ids that could escape the data directory", () => {
    expect(() => validateRoxyBrowserProfileId("../profile")).toThrow();
    expect(() => validateRoxyBrowserProfileId("profile\\child")).toThrow();
  });

  test("accepts only a loopback RoxyBrowser Local API origin", () => {
    expect(validateRoxyBrowserApiHost("http://127.0.0.1:50000/")).toBe("http://127.0.0.1:50000");
    expect(() => validateRoxyBrowserApiHost("https://127.0.0.1:50000")).toThrow();
    expect(() => validateRoxyBrowserApiHost("http://localhost:50000")).toThrow();
    expect(() => validateRoxyBrowserApiHost("http://192.168.1.5:50000")).toThrow();
  });

  test("parses Chromium DevToolsActivePort contents", () => {
    expect(parseRoxyDevToolsActivePort("63801\r\n/devtools/browser/abc-123\r\n")).toEqual({
      port: 63801,
      path: "/devtools/browser/abc-123",
    });
    expect(parseRoxyDevToolsActivePort("0\n/devtools/browser/x\n")).toBeUndefined();
    expect(parseRoxyDevToolsActivePort("63801\n/devtools/page/x\n")).toBeUndefined();
  });

  test("resolves a profile directory below the configured root", () => {
    const profile = roxyBrowserProfileDir("C:/RoxyData", "profile_12345678");
    expect(profile.replaceAll("\\", "/")).toEndWith("/RoxyData/profile_12345678");
  });

  test("a closed profile fails with an actionable message instead of a raw CDP error", async () => {
    const root = tempRoot();
    await expect(ensureRoxyBrowserEndpoint("profile_12345678", root)).rejects.toThrow(
      /is not open.*Open this profile in RoxyBrowser.*automatic RoxyBrowser profile startup/s,
    );
  });

  test("Local API health probing authenticates without opening a profile", async () => {
    const root = tempRoot();
    const keyPath = join(root, "roxy-api.key");
    writeFileSync(keyPath, "private-test-key\n");
    const requests: Array<{ url: string; token: string | undefined }> = [];
    const apiServer = createHttpServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        token: Array.isArray(request.headers.token) ? request.headers.token[0] : request.headers.token,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("test API server has no TCP address");
    try {
      await probeRoxyBrowserLocalApi(`http://127.0.0.1:${address.port}`, keyPath);
      expect(requests).toEqual([{ url: "/health", token: "private-test-key" }]);
    } finally {
      await new Promise<void>(resolve => apiServer.close(() => resolve()));
    }
  });

  test("automatic startup opens a closed profile through the loopback Local API then discovers CDP", async () => {
    const root = tempRoot();
    const profileId = "profile_12345678";
    const profileDir = join(root, profileId);
    mkdirSync(profileDir, { recursive: true });
    const keyPath = join(root, "roxy-api.key");
    writeFileSync(keyPath, "private-test-key\n");

    const cdpServer = createNetServer();
    await new Promise<void>((resolve, reject) => {
      cdpServer.once("error", reject);
      cdpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const cdpAddress = cdpServer.address();
    if (!cdpAddress || typeof cdpAddress === "string") throw new Error("test CDP server has no TCP address");

    const requests: Array<{ method: string; url: string; token: string | undefined; body: string }> = [];
    const apiServer = createHttpServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          token: Array.isArray(request.headers.token) ? request.headers.token[0] : request.headers.token,
          body,
        });
        if (request.url === "/browser/open") {
          writeFileSync(join(profileDir, "DevToolsActivePort"), `${cdpAddress.port}\n/devtools/browser/mock-roxy\n`);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 0, data: {} }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("test API server has no TCP address");

    try {
      const endpoint = await ensureRoxyBrowserEndpoint(profileId, root, {
        autoOpen: true,
        apiHost: `http://127.0.0.1:${apiAddress.port}`,
        apiKeyFile: keyPath,
        openTimeoutMs: 2_000,
      });
      expect(endpoint.endpoint).toBe(`ws://127.0.0.1:${cdpAddress.port}/devtools/browser/mock-roxy`);
      expect(endpoint.openedByAutomation).toBe(true);
      expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
        "GET /health",
        "POST /browser/open",
      ]);
      expect(requests.every(request => request.token === "private-test-key")).toBe(true);
      expect(JSON.parse(requests[1]!.body)).toEqual({ dirId: profileId, args: [] });
    } finally {
      await new Promise<void>(resolve => apiServer.close(() => resolve()));
      await new Promise<void>(resolve => cdpServer.close(() => resolve()));
    }
  });
});
