import { expect, test } from "bun:test";
import {
  externalBrowserCapabilityProbeRequired,
  launcherCapabilityProbeRequired,
  setupProxyIsReady,
} from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    proAvailable: false,
  } as never;

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher, true)).toBe(true);
});

test("external-browser upgrades reuse verified capabilities until the browser identity changes", () => {
  const verifiedRoxy = {
    browserHost: "launcher",
    turnBrowserHost: "roxybrowser",
    roxyBrowserProfileId: "profile-a",
    roxyBrowserDataDir: "C:/Roxy/profiles",
    solAvailable: true,
    proAvailable: false,
  };
  const unchanged = { ...verifiedRoxy, releaseVersion: "0.2.0" };

  expect(externalBrowserCapabilityProbeRequired(verifiedRoxy as never, unchanged as never)).toBe(false);
  expect(externalBrowserCapabilityProbeRequired(verifiedRoxy as never, unchanged as never, true)).toBe(true);
  expect(externalBrowserCapabilityProbeRequired(verifiedRoxy as never, {
    ...verifiedRoxy,
    roxyBrowserProfileId: "profile-b",
  } as never)).toBe(true);
  expect(externalBrowserCapabilityProbeRequired(verifiedRoxy as never, {
    ...verifiedRoxy,
    turnBrowserHost: "system-browser",
  } as never)).toBe(true);
  expect(externalBrowserCapabilityProbeRequired({
    ...verifiedRoxy,
    solAvailable: undefined,
  } as never, unchanged as never)).toBe(true);
});
