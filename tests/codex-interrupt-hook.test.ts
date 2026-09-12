import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("installs one narrowly trusted Interrupt hook and restores the exact Codex config", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "existing-hook"',
    "",
  ].join("\n");
  const config = { runtimeCommand: ["/opt/AsterBridge/runtime/bun", "/opt/AsterBridge/app/cli.js"] };
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", config);

  expect(installed.installed.groupIndex).toBe(1);
  expect(installed.installed.stateKey).toBe(`${resolve("/Users/test/.codex/config.toml")}:interrupt:1:0`);
  expect(installed.text).toContain("[[hooks.Interrupt]]");
  expect(installed.text).toContain(`[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`);
  expect(installed.text).toContain(`trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`);
  verifyCodexInterruptHook(installed.text, installed.installed);
  expect(restoreCodexInterruptHook(installed.text, installed.installed)).toBe(original);
  verifyCodexInterruptHookRestored(original);
});

test("trusts the canonical Codex config path before a new config file exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "asterbridge-interrupt-hook-"));
  try {
    const configPath = join(directory, "config.toml");
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime"] });
    expect(installed.installed.stateKey).toBe(
      `${join(realpathSync.native(directory), "config.toml")}:interrupt:0:0`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Interrupt hook command is absolute, quoted, and bound to the exact application home", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\AsterBridge\\bun.exe", "C:\\Program Files\\AsterBridge\\cli.js"] },
    "C:\\Users\\test\\AsterBridge",
    "win32",
  )).toBe(
    '"C:\\Program Files\\AsterBridge\\bun.exe" "C:\\Program Files\\AsterBridge\\cli.js"'
      + ' "--home" "C:\\Users\\test\\AsterBridge" "hook" "interrupt"',
  );
});

test("Interrupt hook trust hash is deterministic and refuses modified owned definitions", () => {
  const first = codexInterruptHookHash("'runtime' 'hook' 'interrupt'");
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(codexInterruptHookHash("'runtime' 'hook' 'interrupt'")).toBe(first);
  expect(codexInterruptHookHash("'other-runtime' 'hook' 'interrupt'")).not.toBe(first);

  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  );
  expect(() => restoreCodexInterruptHook(
    installed.text.replace("timeout = 3", "timeout = 2"),
    installed.installed,
  )).toThrow("changed after setup");
  expect(() => restoreCodexInterruptHook(
    installed.text.replace(MANAGED_INTERRUPT_HOOK_END, `approved = false\n${MANAGED_INTERRUPT_HOOK_END}`),
    installed.installed,
  )).toThrow("changed after setup");
  for (const extension of [
    '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
    `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
  ]) {
    expect(() => restoreCodexInterruptHook(
      installed.text.replace(MANAGED_INTERRUPT_HOOK_END, extension + MANAGED_INTERRUPT_HOOK_END),
      installed.installed,
    )).toThrow("changed after setup");
  }
  const reordered = [
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "new-earlier-hook"',
    "",
    installed.text,
  ].join("\n");
  expect(() => restoreCodexInterruptHook(reordered, installed.installed))
    .toThrow("order changed after setup");
  expect(() => installCodexInterruptHook(
    installed.text,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  )).toThrow("already contains");
});

test("preserves Codex TOML tables inserted before the trailing hook comment", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime"],
    });
    const appended = "\n[features]\ngoals = true\n";
    const edited = installed.text.replaceAll("\r\n", "\n")
      .replace(MANAGED_INTERRUPT_HOOK_END, appended + MANAGED_INTERRUPT_HOOK_END);
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + appended);
    verifyCodexInterruptHookRestored(restored);
  }
});
