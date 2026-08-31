import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedImagesStorageCheck, launcherBrowserRequiredForTurns } from "../src/doctor";

test("embedded launcher browser is required only when it owns ChatGPT turns", () => {
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher" })).toBe(true);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "launcher" })).toBe(true);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "roxybrowser" })).toBe(false);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "system-browser" })).toBe(false);
});

test("generated image diagnostics report bounded local asset usage without deleting files", () => {
  const root = mkdtempSync(join(tmpdir(), "asterbridge-generated-images-"));
  try {
    const nested = join(root, "thread-a");
    mkdirSync(nested);
    writeFileSync(join(root, "one.png"), Buffer.alloc(1024));
    writeFileSync(join(nested, "two.png"), Buffer.alloc(2048));
    const check = generatedImagesStorageCheck(root);
    expect(check).toMatchObject({
      id: "generated-images",
      status: "ok",
      message: expect.stringContaining("2 files / 3.0 KiB"),
    });
    expect(check.detail).toContain("does not delete them automatically");
    expect(generatedImagesStorageCheck(root, 1).status).toBe("warning");
    expect(Bun.file(join(root, "one.png")).size).toBe(1024);
    expect(Bun.file(join(nested, "two.png")).size).toBe(2048);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
