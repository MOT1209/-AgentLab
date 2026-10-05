import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AgentLabRuntime } from "../bootstrap.js";
import type { AgentResult, Task } from "../agents/types.js";
import { AdbDevice } from "../device/adb-device.js";
import { AdbDiscovery, type DeviceDiscovery } from "../runtime/discovery.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";
import { ProviderError } from "../providers/types.js";
import { TaskStore } from "./task-store.js";

interface JsonResponse {
  status: number;
  body: unknown;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function json(status: number, body: unknown): JsonResponse {
  return { status, body };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Thin HTTP + SSE server wrapping an existing AgentLabRuntime. No framework, no new
 * runtime dependency (matches the project's dependency-minimal decision); no changes to
 * orchestrator/agents/device internals — every route just calls the library as a consumer
 * would. In-memory only; no persistence (see known-issues.md).
 */
export interface ApiOptions {
  webRoot?: string;
  /** adb executable to use for discovery and for the devices it finds. Default "adb" (must be on PATH). */
  adbPath?: string;
  /** Replaces adb discovery entirely (tests, other device sources). */
  discovery?: DeviceDiscovery;
}

export function createApiServer(runtime: AgentLabRuntime, opts: ApiOptions = {}): Server {
  const adbPath = opts.adbPath ?? "adb";
  const tasks = new TaskStore();
  const webRoot = opts.webRoot ? resolve(opts.webRoot) : undefined;

  // Serves the static Control Center. Anything that resolves outside webRoot is a 404.
  async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    if (!webRoot) return false;
    const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const file = resolve(webRoot, rel);
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return false;
    const type = MIME[extname(file)];
    if (!type) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  // Devices found at runtime (Discover) are registered but unassigned, and assignment is otherwise
  // only done at boot. Give the target MAIN a device here: the requested one, else a free one,
  // taking it from another MAIN only if that device is not in use (lock FREE).
  function ensureDevice(agentId: string, requested?: string): string | undefined {
    const main = runtime.registry.get(agentId);
    if (!main || main.kind !== "MAIN") return undefined; // dispatch reports bad agents itself
    const current = runtime.devices.getAssignment(agentId);
    if (!requested && current) return undefined;
    const target = requested ?? (runtime.devices.findAvailable() ?? runtime.devices.findAvailable({ includeAssigned: true }))?.id;
    if (!target) return "no free device is available; connect one and press Discover";
    if (current?.deviceId === target) return undefined;
    const snap = runtime.devices.snapshot().find((d) => d.id === target);
    if (!snap) return `unknown device: ${target}`;
    try {
      if (snap.assignedAgentId !== undefined && snap.assignedAgentId !== agentId) runtime.unassignDevice(snap.assignedAgentId);
      if (current) runtime.reassignDevice(agentId, target);
      else runtime.assignDevice(agentId, target);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async function handleTestsStart(req: IncomingMessage): Promise<JsonResponse> {
    const body = (await readJsonBody(req)) as { agentId?: unknown; type?: unknown; payload?: unknown; deviceId?: unknown };
    if (typeof body.agentId !== "string" || typeof body.type !== "string") {
      return json(400, { error: "agentId and type are required" });
    }
    const agentId = body.agentId;
    const type = body.type;
    const payload = body.payload ?? {};
    const deviceError = ensureDevice(agentId, typeof body.deviceId === "string" ? body.deviceId : undefined);
    if (deviceError) return json(409, { error: deviceError });

    // dispatch() runs synchronously up to its first await, so by the time the call below
    // returns a pending promise, the TASK_ASSIGNED message (if any) has already been
    // published on the bus. Capture it to learn the task_id without waiting for the run
    // to finish, so the client gets an id back immediately instead of blocking on a run
    // that can take many LLM turns.
    let taskId: string | undefined;
    const unsubscribe = runtime.bus.subscribe((msg) => {
      if (taskId === undefined && msg.type === "TASK_ASSIGNED" && msg.to === agentId) taskId = msg.task_id;
    });
    const pending = runtime.orchestrator.dispatch(agentId, type, payload) as Promise<Task<unknown, AgentResult>>;
    unsubscribe();

    if (taskId === undefined) {
      // dispatch rejected before publishing (unknown agent id, or not a MAIN agent); already settled.
      const task = await pending;
      return json(400, { error: task.errors.join("; ") || "dispatch failed" });
    }
    tasks.track(taskId, agentId, type, pending);
    return json(202, { taskId });
  }

  function handleTestStatus(taskId: string): JsonResponse {
    const rec = tasks.get(taskId);
    if (!rec) return json(404, { error: `unknown task: ${taskId}` });
    return json(200, rec);
  }

  async function handleProviderTest(id: string): Promise<JsonResponse> {
    if (!runtime.providers) return json(404, { error: "no providers configured" });
    return json(200, await runtime.providers.test(id));
  }

  // The body is a ProviderConfig: auth.env is the NAME of an env var, never a key value
  // (assertProviderConfig rejects anything key-shaped). A missing env var fails closed.
  async function handleProviderAdd(req: IncomingMessage): Promise<JsonResponse> {
    if (!runtime.providers) return json(404, { error: "no providers configured" });
    const body = await readJsonBody(req);
    try {
      const provider = runtime.providers.add(body);
      return json(201, { id: provider.id, kind: provider.kind, model: provider.model });
    } catch (e) {
      if (e instanceof ProviderError) return json(400, { error: e.message, code: e.code });
      throw e;
    }
  }

  function handleProviderRemove(id: string): JsonResponse {
    if (!runtime.providers) return json(404, { error: "no providers configured" });
    return runtime.providers.remove(id) ? json(200, { removed: id }) : json(404, { error: `unknown provider: ${id}` });
  }

  async function handleDeviceDiscover(): Promise<JsonResponse> {
    try {
      const result = await runtime.devices.discover(opts.discovery ?? new AdbDiscovery(adbPath), (d) => new AdbDevice(d.serial, adbPath));
      return json(200, result);
    } catch (e) {
      return json(502, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function handleEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(":ok\n\n");
    const unsubscribe = runtime.bus.subscribe((msg) => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    res.req.on("close", unsubscribe);
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const method = req.method ?? "GET";

        if (method === "GET" && path === "/providers") {
          return send(res, json(200, runtime.providers?.describe() ?? []));
        }
        if (method === "GET" && path === "/providers/presets") {
          return send(res, json(200, PROVIDER_PRESETS));
        }
        if (method === "POST" && path === "/providers") {
          return send(res, await handleProviderAdd(req));
        }
        const providerTest = /^\/providers\/([^/]+)\/test$/.exec(path);
        if (method === "POST" && providerTest) {
          return send(res, await handleProviderTest(decodeURIComponent(providerTest[1]!)));
        }
        const providerById = /^\/providers\/([^/]+)$/.exec(path);
        if (method === "DELETE" && providerById) {
          return send(res, handleProviderRemove(decodeURIComponent(providerById[1]!)));
        }
        if (method === "GET" && path === "/devices") {
          return send(res, json(200, runtime.devices.snapshot()));
        }
        if (method === "POST" && path === "/devices/discover") {
          return send(res, await handleDeviceDiscover());
        }
        if (method === "POST" && path === "/tests") {
          return send(res, await handleTestsStart(req));
        }
        const testStatus = /^\/tests\/([^/]+)$/.exec(path);
        if (method === "GET" && testStatus) {
          return send(res, handleTestStatus(decodeURIComponent(testStatus[1]!)));
        }
        if (method === "GET" && path === "/events") {
          return handleEvents(res);
        }
        if (method === "GET" && (await serveStatic(path, res))) return;
        send(res, json(404, { error: `no route for ${method} ${path}` }));
      } catch (e) {
        if (e instanceof SyntaxError) return send(res, json(400, { error: "request body is not valid JSON" }));
        send(res, json(500, { error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });
}

function send(res: ServerResponse, r: JsonResponse): void {
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(body);
}
