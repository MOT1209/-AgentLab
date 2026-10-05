import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { UiApp, UiError } from "./app.js";
import { pageHtml } from "./page.js";

const MAX_BODY = 64 * 1024;

export interface UiServerOptions {
  /** Secret required on every API call. Printed in the launch URL only. */
  token: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new UiError(415, "Content-Type must be application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new UiError(413, "Request too large.");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new UiError(400, "Body must be a JSON object.");
  }
}

/**
 * Local-only web UI server. Defences: binds to loopback, checks the Host header (DNS rebinding),
 * requires a random token on every API call (CSRF), serves the page with a nonce-based CSP,
 * and never returns API keys.
 */
export function createUiServer(app: UiApp, opts: UiServerOptions): Server {
  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (e instanceof UiError) {
        if (e.status === 413) res.setHeader("connection", "close"); // do not keep reading an oversized body
        return json(res, e.status, { error: e.message });
      }
      json(res, 500, { error: "Internal error." });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "Forbidden host." });

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (url.pathname === "/" && method === "GET") {
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, pageHtml(nonce), "text/html; charset=utf-8", {
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." });

    const supplied = (req.headers["x-agentlab-token"] as string | undefined) ?? (method === "GET" ? (url.searchParams.get("t") ?? "") : "");
    if (!supplied || !safeEqual(supplied, opts.token)) return json(res, 401, { error: "Missing or wrong token. Open the link printed in the terminal." });

    // Every POST must be JSON: a cross-site form post cannot send this content type without a CORS preflight.
    if (method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) throw new UiError(415, "Content-Type must be application/json.");

    const route = `${method} ${url.pathname}`;
    switch (route) {
      case "GET /api/state":
        return json(res, 200, app.state());
      case "POST /api/devices/refresh":
        await app.refreshDevices();
        return json(res, 200, app.state());
      case "POST /api/provider": {
        const b = await readJson(req);
        app.setProvider({
          kind: b.kind as "anthropic" | "openai-compatible",
          model: String(b.model ?? ""),
          ...(typeof b.baseUrl === "string" ? { baseUrl: b.baseUrl } : {}),
          ...(typeof b.apiKey === "string" ? { apiKey: b.apiKey } : {}),
        });
        return json(res, 200, app.state());
      }
      case "POST /api/provider/clear":
        app.clearProvider();
        return json(res, 200, app.state());
      case "POST /api/provider/test":
        return json(res, 200, await app.testProvider());
      case "POST /api/run": {
        const b = await readJson(req);
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        const started = app.startRun({
          mode: b.mode === "real" ? "real" : "demo",
          ...(typeof b.package === "string" ? { package: b.package } : {}),
          ...(typeof b.objective === "string" ? { objective: b.objective } : {}),
          ...(num(b.maxSteps) !== undefined ? { maxSteps: num(b.maxSteps)! } : {}),
          ...(num(b.timeoutMs) !== undefined ? { timeoutMs: num(b.timeoutMs)! } : {}),
          ...(typeof b.deviceId === "string" ? { deviceId: b.deviceId } : {}),
        });
        return json(res, 202, started);
      }
      case "POST /api/run/cancel":
        app.cancelRun();
        return json(res, 200, { ok: true });
      case "GET /api/run/report": {
        const r = app.report();
        if (!r) return json(res, 404, { error: "No finished run." });
        return send(res, 200, JSON.stringify(r, null, 2), "application/json; charset=utf-8", { "content-disposition": 'attachment; filename="agentlab-report.json"' });
      }
    }
    const m = /^\/api\/run\/screenshot\/(EV-\d{3})$/.exec(url.pathname);
    if (m && method === "GET") {
      const png = app.screenshot(m[1]!);
      return png ? send(res, 200, png, "image/png") : json(res, 404, { error: "No such screenshot." });
    }
    return json(res, 404, { error: "Not found." });
  }
  return server;
}
