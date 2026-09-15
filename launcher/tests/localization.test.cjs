const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");
const appSource = read("launcher", "src", "App.tsx");

function loadI18nModule() {
  const source = read("launcher", "src", "i18n.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

test("Chinese launcher runtime messages localize connector verification and successful doctor checks", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("zh-CN");
  assert.equal(localizeRuntimeMessage(copy, "Checking ChatGPT connector", undefined, "zh-CN"), "正在检查 ChatGPT 连接器");
  assert.equal(localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:17841", "proxy", "zh-CN"), "Responses 代理在 127.0.0.1:17841 上运行正常");
  assert.equal(localizeRuntimeMessage(copy, "Pinned openai/tunnel-client binary is installed", "tunnel-binary", "zh-CN"), "已安装固定版本的 openai/tunnel-client 二进制文件");
  assert.equal(localizeRuntimeMessage(copy, "Tunnel runtime key is stored privately", "tunnel-key", "zh-CN"), "隧道运行时密钥已安全存储");
  assert.equal(localizeRuntimeMessage(copy, "Launcher owns the tunnel runtime", "tunnel-service", "zh-CN"), "启动器正在管理隧道运行时");
  assert.equal(localizeRuntimeMessage(copy, "Tunnel runtime reports healthy and ready", "tunnel-runtime", "zh-CN"), "隧道运行正常，可以使用");
  assert.equal(localizeRuntimeMessage(copy, 'ChatGPT connector "Codex Native3" is available', "connector", "zh-CN"), "ChatGPT 连接器“Codex Native3”可用");
});

test("runtime localization preserves literal connector names and unknown diagnostics", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("zh-CN");
  for (const connectorName of ["Codex Native3", "Native $&", "Native $'", "Native $`", 'Native "quoted"', "Native \\path"]) {
    const message = `ChatGPT connector ${JSON.stringify(connectorName)} is available`;
    assert.equal(localizeRuntimeMessage(copy, message, "connector", "zh-CN"), `ChatGPT 连接器“${connectorName}”可用`);
  }
  assert.equal(localizeRuntimeMessage(copy, "Tunnel runtime is not ready", "tunnel-runtime", "zh-CN"), "Tunnel runtime is not ready");
  assert.equal(localizeRuntimeMessage(copy, "Unexpected connector diagnostic", "connector", "zh-CN"), "Unexpected connector diagnostic");
  assert.equal(localizeRuntimeMessage(copyFor("en"), "Checking ChatGPT connector", undefined, "en"), "Checking ChatGPT connector");
});

test("launcher UI localizes only successful runtime status and MCP verification progress", () => {
  assert.match(appSource, /localizeRuntimeMessage\(copy, operation\.message, undefined, language\)/);
  assert.match(
    appSource,
    /check\.status === "ok"\s*\?\s*localizeRuntimeMessage\(copy, check\.message, check\.id, language\)\s*:\s*check\.message/,
  );
});
