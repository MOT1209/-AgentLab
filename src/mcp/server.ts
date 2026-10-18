import { Device } from "../device/types.js";

/**
 * Minimal MCP server (JSON-RPC 2.0, stdio framing is done by main.ts) over the Device abstraction.
 * Models never get shell, raw adb or code execution: only the fixed tools below.
 * Read tools are always on; tools that change the device need `allowActions` (MCP_EXECUTE, never implicit).
 */
export interface McpServerOptions {
  devices: Device[];
  allowActions?: boolean;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface Tool {
  name: string;
  description: string;
  action: boolean;
  properties: Record<string, object>;
  required?: string[];
  run(device: Device, args: Record<string, unknown>): Promise<Content[]>;
}

const text = (t: string): Content[] => [{ type: "text", text: t }];
const str = (a: Record<string, unknown>, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new Error(`"${k}" must be a non-empty string`);
  return v;
};
const num = (a: Record<string, unknown>, k: string): number => {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`"${k}" must be a non-negative number`);
  return v;
};
const deviceId = { deviceId: { type: "string", description: "Optional when exactly one device is connected." } };

const TOOLS: Tool[] = [
  {
    name: "get_ui",
    description: "Current UI hierarchy: labels, ids, bounds and whether each element is clickable.",
    action: false,
    properties: deviceId,
    async run(d) {
      if (!d.ui) throw new Error("This device cannot read the UI hierarchy");
      return text(JSON.stringify(await d.ui()));
    },
  },
  {
    name: "screenshot",
    description: "PNG screenshot of the device screen.",
    action: false,
    properties: deviceId,
    async run(d) {
      return [{ type: "image", data: (await d.screenshot()).toString("base64"), mimeType: "image/png" }];
    },
  },
  {
    name: "get_logs",
    description: "Recent device log lines (logcat).",
    action: false,
    properties: { ...deviceId, lines: { type: "number", description: "Default 200, max 1000." } },
    async run(d, a) {
      const lines = typeof a.lines === "number" ? Math.min(Math.max(1, Math.floor(a.lines)), 1000) : 200;
      return text(await d.logs(lines));
    },
  },
  {
    name: "launch_app",
    description: "Start an installed app by package name.",
    action: true,
    properties: { ...deviceId, packageName: { type: "string" } },
    required: ["packageName"],
    async run(d, a) {
      await d.launch(str(a, "packageName"));
      return text("launched");
    },
  },
  {
    name: "stop_app",
    description: "Force-stop an app by package name.",
    action: true,
    properties: { ...deviceId, packageName: { type: "string" } },
    required: ["packageName"],
    async run(d, a) {
      await d.stop(str(a, "packageName"));
      return text("stopped");
    },
  },
  {
    name: "tap",
    description: "Tap at screen coordinates (pixels).",
    action: true,
    properties: { ...deviceId, x: { type: "number" }, y: { type: "number" } },
    required: ["x", "y"],
    async run(d, a) {
      await d.tap(num(a, "x"), num(a, "y"));
      return text("tapped");
    },
  },
  {
    name: "press_key",
    description: "Press BACK or HOME.",
    action: true,
    properties: { ...deviceId, key: { type: "string", enum: ["BACK", "HOME"] } },
    required: ["key"],
    async run(d, a) {
      const key = str(a, "key");
      if (key !== "BACK" && key !== "HOME") throw new Error('"key" must be BACK or HOME');
      if (!d.pressKey) throw new Error("This device cannot press keys");
      await d.pressKey(key);
      return text("pressed");
    },
  },
];

export class McpServer {
  private readonly tools: Tool[];

  constructor(private readonly opts: McpServerOptions) {
    this.tools = [
      {
        name: "list_devices",
        description: "List connected devices with id, state, model and Android version.",
        action: false,
        properties: {},
        run: async () => {
          const out = [];
          for (const d of opts.devices) {
            const info = await d.info().catch(() => undefined);
            out.push({ id: d.id, state: d.state(), ...(info ? { model: info.model, androidVersion: info.androidVersion } : {}) });
          }
          return text(JSON.stringify(out));
        },
      },
      ...TOOLS,
    ].filter((t) => opts.allowActions || !t.action);
  }

  /** Returns undefined for notifications (no reply expected). */
  async handle(msg: Rpc): Promise<RpcResponse | undefined> {
    const isNotification = msg.id === undefined;
    const id = msg.id ?? null;
    const ok = (result: unknown): RpcResponse | undefined => (isNotification ? undefined : { jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): RpcResponse | undefined =>
      isNotification ? undefined : { jsonrpc: "2.0", id, error: { code, message } };

    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "agentlab", version: "0.1.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: "object", properties: t.properties, ...(t.required ? { required: t.required } : {}) },
          })),
        });
      case "tools/call": {
        const name = msg.params?.name;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const device = tool.name === "list_devices" ? (undefined as unknown as Device) : this.pick(args.deviceId);
          return ok({ content: await tool.run(device, args) });
        } catch (e) {
          // Tool failures are results the model can read, not protocol errors.
          return ok({ isError: true, content: text(e instanceof Error ? e.message : String(e)) });
        }
      }
      default:
        if (msg.method?.startsWith("notifications/")) return undefined;
        return fail(-32601, `Method not found: ${String(msg.method)}`);
    }
  }

  private pick(id: unknown): Device {
    const { devices } = this.opts;
    if (id !== undefined && typeof id !== "string") throw new Error('"deviceId" must be a string');
    if (id !== undefined) {
      const d = devices.find((x) => x.id === id);
      if (!d) throw new Error(`Unknown device: ${id}`);
      return d;
    }
    if (devices.length === 1) return devices[0]!;
    throw new Error(devices.length ? "Several devices connected: pass deviceId (see list_devices)" : "No device connected");
  }
}
