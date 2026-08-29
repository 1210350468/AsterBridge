const fs = require("node:fs");
const path = require("node:path");
const { convertIcon } = require("app-builder-lib/out/util/iconConverter.js");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "assets", "icon.svg");
const outputDir = path.join(root, "build", "icons");
const output = path.join(outputDir, "icon.ico");

async function main() {
  if (!fs.existsSync(source)) throw new Error(`AsterBridge icon source is missing: ${source}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const converted = await convertIcon({
    sources: [source],
    fallbackSources: [],
    roots: [root],
    format: "ico",
    outDir: outputDir,
  });
  if (!converted.icons.some((icon) => path.resolve(icon.file) === path.resolve(output)) || !fs.existsSync(output)) {
    throw new Error(`Windows ICO was not generated at ${output}`);
  }
  const bytes = fs.readFileSync(output);
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) < 1) {
    throw new Error(`Generated Windows icon is invalid: ${output}`);
  }
  process.stdout.write(`AsterBridge Windows icon ready: ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`prepare-win-icon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
