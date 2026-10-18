import { createInterface } from "node:readline";
import { MockDevice } from "../device/mock-device.js";
import { AdbDevice } from "../device/adb-device.js";
import { AdbDiscovery } from "../runtime/discovery.js";
import { McpServer } from "./server.js";

// stdout carries the protocol: log only to stderr.
const argv = process.argv.slice(2);
const mock = argv.includes("--mock");
const allowActions = argv.includes("--allow-actions");
const adbPath = process.env.ADB_PATH ?? "adb";

const devices = mock
  ? [new MockDevice("mock-1")]
  : (await new AdbDiscovery(adbPath).discover().catch((e) => {
      console.error(`adb discovery failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }))
      .filter((d) => d.state === "device")
      .map((d) => new AdbDevice(d.serial, adbPath));

console.error(`agentlab-mcp: ${devices.length} device(s), actions ${allowActions ? "ENABLED" : "disabled (read-only; pass --allow-actions)"}`);
const server = new McpServer({ devices, allowActions });

// One JSON-RPC message per line on stdin, one per line on stdout.
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let reply;
  try {
    reply = await server.handle(JSON.parse(line));
  } catch {
    reply = { jsonrpc: "2.0" as const, id: null, error: { code: -32700, message: "Parse error" } };
  }
  if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
}
