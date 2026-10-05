import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import type { AgentLabRuntime } from "../bootstrap.js";
import type { AgentResult, Task } from "../agents/types.js";
import { AdbDiscovery } from "../runtime/discovery.js";
import { TaskStore } from "./task-store.js";

interface JsonResponse {
  status: number;
  body: unknown;
}

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
export function createApiServer(runtime: AgentLabRuntime): Server {
  const tasks = new TaskStore();

  async function handleTestsStart(req: IncomingMessage): Promise<JsonResponse> {
    const body = (await readJsonBody(req)) as { agentId?: unknown; type?: unknown; payload?: unknown };
    if (typeof body.agentId !== "string" || typeof body.type !== "string") {
      return json(400, { error: "agentId and type are required" });
    }
    const agentId = body.agentId;
    const type = body.type;
    const payload = body.payload ?? {};

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

  async function handleDeviceDiscover(): Promise<JsonResponse> {
    try {
      const result = await runtime.devices.discover(new AdbDiscovery());
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
        const providerTest = /^\/providers\/([^/]+)\/test$/.exec(path);
        if (method === "POST" && providerTest) {
          return send(res, await handleProviderTest(decodeURIComponent(providerTest[1]!)));
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
        send(res, json(404, { error: `no route for ${method} ${path}` }));
      } catch (e) {
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
