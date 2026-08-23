const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 768 * 1024;
const EMPTY_ROXY_PREVIEW = Object.freeze({
  active: false,
  traceId: null,
  status: "idle",
  stage: "idle",
  url: "",
  dataUrl: null,
  updatedAt: null,
});

function secureTokenMatches(expected, authorization) {
  const prefix = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("request body is empty");
  return JSON.parse(text);
}

function writeJson(response, status, body) {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

class BrowserControlServer {
  constructor({ logger, getBrowserHost, getPreferences, publishRoxyPreview = null }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.publishRoxyPreview = publishRoxyPreview;
    this.externalTurns = new Map();
    this.pendingActions = new Map();
    this.roxyPreviews = new Map();
    this.token = randomBytes(32).toString("base64url");
    this.port = 0;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.control_request_failed", { message });
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        try {
          writeJson(response, 500, { error: "internal_error" });
        } catch {
          response.destroy();
        }
      });
    });
    this.server.on("error", (error) => {
      this.logger.error("browser.control_server_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.port = address && typeof address === "object" ? address.port : 0;
        if (!this.port) reject(new Error("Browser control server did not receive a port"));
        else resolve();
      });
    });
    this.logger.info("browser.control_started", { port: this.port });
    return this;
  }

  descriptor() {
    if (!this.port) throw new Error("Browser control server is not started");
    return { endpoint: `http://127.0.0.1:${this.port}`, token: this.token };
  }

  roxyPreviewSnapshot() {
    const previews = [...this.roxyPreviews.values()];
    if (previews.length === 0) return { ...EMPTY_ROXY_PREVIEW };
    previews.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return structuredClone(previews[0]);
  }

  publishPreview(preview) {
    if (preview.active) this.roxyPreviews.set(preview.traceId, preview);
    else this.roxyPreviews.delete(preview.traceId);
    const snapshot = preview.active ? preview : this.roxyPreviewSnapshot();
    this.publishRoxyPreview?.(structuredClone(snapshot));
  }

  requestRoxyAction(action) {
    if (action !== "take-control") throw new Error(`Unknown RoxyBrowser action: ${action}`);
    const preview = this.roxyPreviewSnapshot();
    if (!preview.active || !preview.traceId) throw new Error("No active RoxyBrowser turn is available for manual control");
    const owner = this.externalTurns.get(preview.traceId);
    if (!owner || owner.host !== "roxybrowser") throw new Error("The active preview is not owned by RoxyBrowser");
    this.pendingActions.set(preview.traceId, action);
    this.logger.info("browser.roxy_action_requested", { traceId: preview.traceId, action });
    return preview;
  }

  async handle(request, response) {
    if (!secureTokenMatches(this.token, request.headers.authorization)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const isTurn = request.url === "/v1/turn/start"
      || request.url === "/v1/turn/heartbeat"
      || request.url === "/v1/turn/end";
    const isPreview = request.url === "/v1/turn/preview";
    const isSessionInspect = request.url === "/v1/session/inspect";
    if (request.method !== "POST" || (!isTurn && !isPreview && !isSessionInspect)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readJson(request);
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is not ready");
      if (isSessionInspect) {
        const result = await host.inspectSession(body?.detectCapabilities === true);
        writeJson(response, 200, result);
        return;
      }
      if (!body || typeof body !== "object" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.traceId || "")) {
        throw new Error("traceId is invalid");
      }
      if (!Number.isInteger(body.helperPid) || body.helperPid < 1) {
        throw new Error("browser helper pid is invalid");
      }
      const preferences = this.getPreferences();
      const externalHost = body.externalHost === "roxybrowser" || body.externalHost === "system-browser"
        ? body.externalHost
        : null;
      if (isPreview) {
        const owner = this.externalTurns.get(body.traceId);
        if (!owner || owner.helperPid !== body.helperPid || owner.host !== "roxybrowser") {
          throw new Error("RoxyBrowser preview ownership mismatch");
        }
        if (typeof body.stage !== "string" || body.stage.length > 120) throw new Error("RoxyBrowser preview stage is invalid");
        if (typeof body.url !== "string" || body.url.length > 4096) throw new Error("RoxyBrowser preview URL is invalid");
        if (body.dataUrl !== null && body.dataUrl !== undefined) {
          if (typeof body.dataUrl !== "string"
            || body.dataUrl.length > 700_000
            || !body.dataUrl.startsWith("data:image/jpeg;base64,")) {
            throw new Error("RoxyBrowser preview frame is invalid");
          }
        }
        const previousPreview = this.roxyPreviews.get(body.traceId);
        const preview = {
          active: true,
          traceId: body.traceId,
          status: body.status === "starting" ? "starting" : "running",
          stage: body.stage,
          url: body.url,
          dataUrl: body.dataUrl || previousPreview?.dataUrl || null,
          updatedAt: new Date().toISOString(),
        };
        this.publishPreview(preview);
        if (!previousPreview?.dataUrl && preview.dataUrl) {
          this.logger.info("browser.roxy_preview_started", { traceId: body.traceId, stage: body.stage });
        }
        const action = this.pendingActions.get(body.traceId) || null;
        if (action) {
          this.pendingActions.delete(body.traceId);
          this.logger.info("browser.roxy_action_delivered", { traceId: body.traceId, action });
        }
        writeJson(response, 200, { ok: true, action });
        return;
      }
      if (request.url === "/v1/turn/start") {
        if (externalHost) {
          this.externalTurns.set(body.traceId, { helperPid: body.helperPid, host: externalHost });
          if (externalHost === "roxybrowser") {
            this.publishPreview({
              active: true,
              traceId: body.traceId,
              status: "starting",
              stage: "starting",
              url: "",
              dataUrl: null,
              updatedAt: new Date().toISOString(),
            });
          }
          this.logger.info("browser.external_turn_started", { traceId: body.traceId, host: externalHost });
          writeJson(response, 200, {
            ok: true,
            external: true,
            previewEnabled: externalHost === "roxybrowser" && preferences.roxyLivePreview !== false,
          });
          return;
        }
        const lease = host.beginTurn(body.traceId, preferences.showBrowserDuringTurns === true, body.helperPid);
        this.logger.info("browser.turn_started", { traceId: body.traceId });
        writeJson(response, 200, { ok: true, ...lease });
        return;
      } else if (request.url === "/v1/turn/heartbeat") {
        const owner = this.externalTurns.get(body.traceId);
        if (owner) {
          if (owner.helperPid !== body.helperPid) throw new Error("External browser turn ownership mismatch");
          const action = this.pendingActions.get(body.traceId) || null;
          if (action) {
            this.pendingActions.delete(body.traceId);
            this.logger.info("browser.roxy_action_delivered", { traceId: body.traceId, action });
          }
          this.logger.debug?.("browser.external_turn_heartbeat", { traceId: body.traceId, host: owner.host });
          writeJson(response, 200, { ok: true, action });
          return;
        }
        host.heartbeatTurn(body.traceId, body.helperPid);
        this.logger.debug?.("browser.turn_heartbeat", { traceId: body.traceId });
        writeJson(response, 200, { ok: true });
        return;
      } else {
        if (!['completed', 'failed', 'aborted'].includes(body.status)) throw new Error("turn status is invalid");
        const owner = this.externalTurns.get(body.traceId);
        if (owner) {
          if (owner.helperPid !== body.helperPid) throw new Error("External browser turn ownership mismatch");
          this.externalTurns.delete(body.traceId);
          this.pendingActions.delete(body.traceId);
          if (owner.host === "roxybrowser") {
            const previous = this.roxyPreviews.get(body.traceId);
            this.publishPreview({
              active: false,
              traceId: body.traceId,
              status: body.status,
              stage: body.status,
              url: previous?.url || "",
              dataUrl: previous?.dataUrl || null,
              updatedAt: new Date().toISOString(),
            });
          }
          this.logger.info("browser.external_turn_ended", { traceId: body.traceId, host: owner.host, status: body.status });
          writeJson(response, 200, { ok: true, cancelledByUser: false });
          return;
        }
        const release = await host.endTurn(
          body.traceId,
          body.helperPid,
          body.status,
          preferences.showBrowserDuringTurns === true,
          body.message,
        );
        this.logger.info("browser.turn_ended", { traceId: body.traceId, status: body.status });
        writeJson(response, 200, { ok: true, ...release });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("browser.control_rejected", { message });
      const cancelled = error?.code === "turn_cancelled";
      writeJson(response, cancelled ? 409 : 400, {
        error: message,
        ...(cancelled ? { code: "turn_cancelled" } : {}),
      });
    }
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

module.exports = { BrowserControlServer };
