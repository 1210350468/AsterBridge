const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("RoxyBrowser external turns stream preview state and receive manual-control actions without leasing an embedded tab", async () => {
  const calls = [];
  const previews = [];
  const host = {
    beginTurn: (...args) => calls.push(["start", ...args]),
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    endTurn: (...args) => calls.push(["end", ...args]),
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true, roxyLivePreview: true }),
    publishRoxyPreview: (preview) => previews.push(preview),
  }).start();
  const descriptor = server.descriptor();
  const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
  try {
    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        phase: "start",
        traceId: "roxytrace123",
        helperPid: process.pid,
        externalHost: "roxybrowser",
      }),
    });
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { ok: true, external: true, previewEnabled: true });
    assert.deepEqual(calls, []);
    assert.equal(server.roxyPreviewSnapshot().active, true);

    server.requestRoxyAction("take-control");
    const preview = await fetch(`${descriptor.endpoint}/v1/turn/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        traceId: "roxytrace123",
        helperPid: process.pid,
        stage: "send",
        url: "https://chatgpt.com/",
        dataUrl: "data:image/jpeg;base64,AA==",
      }),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { ok: true, action: "take-control" });
    const state = server.roxyPreviewSnapshot();
    assert.equal(state.traceId, "roxytrace123");
    assert.equal(state.stage, "send");
    assert.equal(state.dataUrl, "data:image/jpeg;base64,AA==");

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "heartbeat", traceId: "roxytrace123", helperPid: process.pid }),
    });
    assert.deepEqual(await heartbeat.json(), { ok: true, action: null });

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        phase: "end",
        traceId: "roxytrace123",
        helperPid: process.pid,
        status: "completed",
        externalHost: "roxybrowser",
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(await end.json(), { ok: true, cancelledByUser: false });
    assert.equal(server.roxyPreviewSnapshot().active, false);
    assert.equal(previews.some((item) => item.active === true && item.stage === "send"), true);
  } finally {
    await server.close();
  }
});

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return {
        surfaceId: "launcher_surface_id_0123456789AB",
        tabId: "tab-1",
        reused: false,
        connectorBound: false,
      };
    },
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    endTurn: (...args) => calls.push(["end", ...args]),
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: process.pid }),
    });
    assert.equal(start.status, 200);

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "heartbeat", traceId: "abcdef123456", helperPid: process.pid }),
    });
    assert.equal(heartbeat.status, 200);

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(calls, [
      ["start", "abcdef123456", true, process.pid, undefined, undefined, false],
      ["heartbeat", "abcdef123456", process.pid],
      ["end", "abcdef123456", process.pid, "completed", true, undefined, false, false],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("browser control server reports a missing retained conversation as a typed conflict", async () => {
  const host = {
    beginTurn: () => {
      const error = new Error("The retained ChatGPT conversation is no longer available");
      error.code = "retained_conversation_unavailable";
      throw error;
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "missing123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        requireRetainedConversation: true,
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "The retained ChatGPT conversation is no longer available",
      code: "retained_conversation_unavailable",
    });
  } finally {
    await server.close();
  }
});

test("browser control server releases only ready tabs for an authenticated conversation key", async () => {
  const removed = [];
  const host = {
    turnTabs: new Map([
      ["ready", { id: "ready", traceId: "trace-ready", status: "ready", conversationKey: "b".repeat(64) }],
      ["running", { id: "running", traceId: "trace-running", status: "running", conversationKey: "b".repeat(64) }],
      ["other", { id: "other", traceId: "trace-other", status: "ready", conversationKey: "c".repeat(64) }],
    ]),
    removeTurnTab(tab) {
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
    logger: { info() {} },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationKey: "b".repeat(64) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, released: 1 });
    assert.deepEqual(removed, ["ready"]);
    assert.equal(host.turnTabs.has("running"), true);
    assert.equal(host.turnTabs.has("other"), true);
  } finally {
    await server.close();
  }
});
