import { expect, test } from "bun:test";
import { launcherBrowserRequiredForTurns } from "../src/doctor";

test("embedded launcher browser is required only when it owns ChatGPT turns", () => {
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher" })).toBe(true);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "launcher" })).toBe(true);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "roxybrowser" })).toBe(false);
  expect(launcherBrowserRequiredForTurns({ browserHost: "launcher", turnBrowserHost: "system-browser" })).toBe(false);
});
