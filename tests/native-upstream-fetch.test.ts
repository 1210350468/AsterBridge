import { expect, test } from "bun:test";
import { createNativeUpstreamFetch, resolveNativeUpstreamProxy } from "../src/native-upstream-fetch";

test("prefers explicit HTTPS proxy environment configuration", () => {
  const proxy = resolveNativeUpstreamProxy({
    environment: {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:8080",
    },
    platform: "win32",
    readWindowsInternetSetting: () => "0x0",
  });

  expect(proxy).toBe("http://127.0.0.1:7890");
});

test("falls back to enabled Windows WinINET proxy", () => {
  const proxy = resolveNativeUpstreamProxy({
    environment: {},
    platform: "win32",
    readWindowsInternetSetting: name => name === "ProxyEnable" ? "0x1" : "127.0.0.1:10809",
  });

  expect(proxy).toBe("http://127.0.0.1:10809");
});

test("selects the HTTPS entry from a per-protocol Windows proxy", () => {
  const proxy = resolveNativeUpstreamProxy({
    environment: {},
    platform: "win32",
    readWindowsInternetSetting: name => name === "ProxyEnable"
      ? "0x1"
      : "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
  });

  expect(proxy).toBe("http://127.0.0.1:7891");
});

test("can disable Bun's default fetch timeout only for long-running native calls", async () => {
  let observedInit: (RequestInit & { proxy?: string; timeout?: number | false }) | undefined;
  const fetchUpstream = createNativeUpstreamFetch({
    environment: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    platform: "linux",
    disableDefaultFetchTimeout: true,
    fetchImpl: async (_request, init) => {
      observedInit = init;
      return Response.json({ ok: true });
    },
  });

  const response = await fetchUpstream(new Request("https://chatgpt.com/backend-api/codex/images/edits"));
  expect(response.status).toBe(200);
  expect(observedInit?.proxy).toBe("http://127.0.0.1:7890");
  expect(observedInit?.timeout).toBe(false);
});

test("ordinary native fetches keep Bun's bounded default timeout", async () => {
  let observedInit: (RequestInit & { proxy?: string; timeout?: number | false }) | undefined;
  const fetchUpstream = createNativeUpstreamFetch({
    environment: {},
    platform: "linux",
    fetchImpl: async (_request, init) => {
      observedInit = init;
      return Response.json({ ok: true });
    },
  });

  await fetchUpstream(new Request("https://chatgpt.com/backend-api/codex/models"));
  expect(observedInit?.timeout).toBeUndefined();
});

test("does not use disabled or non-Windows system proxy settings", () => {
  expect(resolveNativeUpstreamProxy({
    environment: {},
    platform: "win32",
    readWindowsInternetSetting: name => name === "ProxyEnable" ? "0x0" : "127.0.0.1:10809",
  })).toBeUndefined();

  expect(resolveNativeUpstreamProxy({
    environment: {},
    platform: "linux",
    readWindowsInternetSetting: () => "0x1",
  })).toBeUndefined();
});
