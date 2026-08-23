import { expect, test } from "bun:test";
import { resolveNativeUpstreamProxy } from "../src/native-upstream-fetch";

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
