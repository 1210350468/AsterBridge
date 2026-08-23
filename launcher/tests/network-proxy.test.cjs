const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyNetworkProxyEnvironment,
  normalizeProxyUrl,
  selectWindowsProxy,
} = require("../electron/network-proxy.cjs");

test("custom proxy accepts host:port shorthand and keeps local services out of the proxy", () => {
  const target = {};
  const result = applyNetworkProxyEnvironment({
    mode: "custom",
    customUrl: "127.0.0.1:7890",
    target,
    baseEnvironment: {},
    platform: "linux",
  });
  assert.equal(result.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(target.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(target.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.match(target.NO_PROXY, /127\.0\.0\.1/);
  assert.match(target.NO_PROXY, /localhost/);
  assert.match(target.NO_PROXY, /::1/);
});

test("automatic proxy prefers inherited environment before the Windows system proxy", () => {
  const target = {};
  const result = applyNetworkProxyEnvironment({
    mode: "auto",
    target,
    baseEnvironment: { HTTPS_PROXY: "http://127.0.0.1:10809" },
    platform: "win32",
    readSetting: () => {
      throw new Error("registry should not be needed");
    },
  });
  assert.equal(result.source, "environment");
  assert.equal(target.HTTPS_PROXY, "http://127.0.0.1:10809");
});

test("automatic proxy skips unsupported SOCKS environment values and keeps searching", () => {
  const target = {};
  const result = applyNetworkProxyEnvironment({
    mode: "auto",
    target,
    baseEnvironment: {
      ALL_PROXY: "socks5://127.0.0.1:1080",
      HTTP_PROXY: "http://127.0.0.1:7890",
    },
    platform: "linux",
  });
  assert.equal(result.source, "environment");
  assert.equal(result.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(target.HTTPS_PROXY, "http://127.0.0.1:7890");
});

test("automatic proxy imports the Windows system proxy for child runtimes", () => {
  const values = { ProxyEnable: "0x1", ProxyServer: "http=127.0.0.1:7890;https=127.0.0.1:7891" };
  const target = {};
  const result = applyNetworkProxyEnvironment({
    mode: "auto",
    target,
    baseEnvironment: {},
    platform: "win32",
    readSetting: (name) => values[name],
  });
  assert.equal(result.source, "windows-system");
  assert.equal(result.proxyUrl, "http://127.0.0.1:7891");
  assert.equal(target.HTTPS_PROXY, "http://127.0.0.1:7891");
});

test("direct mode clears inherited proxy variables without proxying loopback", () => {
  const target = {};
  const baseEnvironment = {
    HTTPS_PROXY: "http://proxy.example:8080",
    ALL_PROXY: "http://proxy.example:8080",
    NO_PROXY: "example.internal",
  };
  const result = applyNetworkProxyEnvironment({ mode: "direct", target, baseEnvironment, platform: "linux" });
  assert.equal(result.source, "direct");
  assert.equal(target.HTTPS_PROXY, undefined);
  assert.equal(target.ALL_PROXY, undefined);
  assert.match(target.NO_PROXY, /example\.internal/);
  assert.match(target.NO_PROXY, /127\.0\.0\.1/);
});

test("proxy validation rejects unsupported schemes and Windows mappings choose HTTPS first", () => {
  assert.throws(() => normalizeProxyUrl("socks5://127.0.0.1:1080"), /HTTP or HTTPS/);
  assert.equal(
    selectWindowsProxy("http=127.0.0.1:7890;https=127.0.0.1:7891"),
    "http://127.0.0.1:7891",
  );
});
