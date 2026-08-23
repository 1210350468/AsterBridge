import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const required = [
  "README.md",
  "README.zh-CN.md",
  "docs/quick-start.md",
  "docs/quick-start.zh-CN.md",
  "docs/troubleshooting.md",
  "docs/troubleshooting.zh-CN.md",
  "docs/release-validation.md",
];

for (const relative of required) {
  if (!existsSync(join(root, relative))) throw new Error(`Required user documentation is missing: ${relative}`);
}

const configSource = readFileSync(join(root, "src", "config.ts"), "utf8");
const connectorMatch = configSource.match(/CHATGPT_CONNECTOR_NAME\s*=\s*"([^"]+)"/);
if (!connectorMatch) throw new Error("Could not determine CHATGPT_CONNECTOR_NAME from src/config.ts");
const connectorName = connectorMatch[1]!;
const productName = "AsterBridge";
const repositorySlug = "1210350468/AsterBridge";
const repositoryUrl = `https://github.com/${repositorySlug}`;

for (const relative of ["README.md", "README.zh-CN.md", "docs/quick-start.md", "docs/quick-start.zh-CN.md"]) {
  const text = readFileSync(join(root, relative), "utf8");
  if (!text.includes(connectorName)) {
    throw new Error(`${relative} does not mention the current connector identity ${JSON.stringify(connectorName)}`);
  }
}

const readme = readFileSync(join(root, "README.md"), "utf8");
const readmeZh = readFileSync(join(root, "README.zh-CN.md"), "utf8");
const launcherManifest = JSON.parse(readFileSync(join(root, "launcher", "package.json"), "utf8")) as { build?: { productName?: string } };
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  repository?: { url?: string };
  homepage?: string;
  bugs?: { url?: string };
};
if (launcherManifest.build?.productName !== productName) {
  throw new Error(`Launcher productName must remain ${productName}`);
}
if (!readme.includes(`<h1 align="center">${productName}</h1>`)
  || !readmeZh.includes(`<h1 align="center">${productName} · 星桥</h1>`)) {
  throw new Error("README branding is out of sync with the launcher product name");
}
if (rootManifest.repository?.url !== `git+${repositoryUrl}.git`
  || rootManifest.homepage !== `${repositoryUrl}#readme`
  || rootManifest.bugs?.url !== `${repositoryUrl}/issues`) {
  throw new Error(`Root package metadata must point to ${repositorySlug}`);
}
for (const relative of [
  "README.md",
  "README.zh-CN.md",
  "docs/quick-start.md",
  "docs/quick-start.zh-CN.md",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  "launcher/electron/main.cjs",
  "launcher/electron/update.cjs",
  "scripts/install-launcher.ps1",
  "scripts/install-launcher.sh",
]) {
  const text = readFileSync(join(root, relative), "utf8");
  if (!text.includes(repositorySlug)) {
    throw new Error(`${relative} must point to the AsterBridge repository ${repositorySlug}`);
  }
}
for (const [name, text, links] of [
  ["README.md", readme, ["docs/quick-start.md", "docs/troubleshooting.md"]],
  ["README.zh-CN.md", readmeZh, ["docs/quick-start.zh-CN.md", "docs/troubleshooting.zh-CN.md"]],
] as const) {
  for (const link of links) {
    if (!text.includes(`href="${link}"`) && !text.includes(`](${link})`)) {
      throw new Error(`${name} must link to ${link}`);
    }
  }
}

if (readme.includes("default connector/App name is **Codex Native2**")
  || readmeZh.includes("默认连接器/App 名称仍是 **Codex Native2**")) {
  throw new Error("README still advertises the retired Codex Native2 identity as the default");
}

const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;
for (const relative of required) {
  const absolute = join(root, relative);
  const text = readFileSync(absolute, "utf8");
  for (const match of text.matchAll(markdownLink)) {
    const target = match[1]!.trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:")) continue;
    const withoutFragment = target.split("#", 1)[0]!;
    if (!withoutFragment) continue;
    const resolved = resolve(dirname(absolute), decodeURIComponent(withoutFragment));
    if (!existsSync(resolved)) {
      throw new Error(`${relative} links to missing local resource: ${target}`);
    }
  }
}

console.log(`Documentation contract OK (product=${productName}, connector=${connectorName})`);
