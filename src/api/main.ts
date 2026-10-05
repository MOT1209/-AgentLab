import { initializeAgentLab } from "../bootstrap.js";
import { loadProviderFile } from "../providers/config.js";
import { ProviderManager } from "../providers/manager.js";
import { AdbDevice } from "../device/adb-device.js";
import { AdbDiscovery } from "../runtime/discovery.js";
import { DeviceManager } from "../runtime/device-manager.js";
import { createApiServer } from "./server.js";

/**
 * Dev entry point: `npm run dev:api`. Loads providers from PROVIDERS_FILE (default
 * providers.example.json), discovers real adb devices at startup (best-effort; a
 * missing adb just means zero devices), and serves the API on PORT (default 4000).
 */
async function main(): Promise<void> {
  const providersFile = process.env.PROVIDERS_FILE ?? "providers.example.json";
  let providers: ProviderManager;
  try {
    providers = ProviderManager.fromFile(loadProviderFile(providersFile));
  } catch (e) {
    console.warn(`[api] no usable provider file at ${providersFile}: ${e instanceof Error ? e.message : String(e)}`);
    providers = new ProviderManager();
  }

  const adbPath = process.env.ADB_PATH ?? "adb";
  const devices = new DeviceManager();
  try {
    const result = await devices.discover(new AdbDiscovery(adbPath), (d) => new AdbDevice(d.serial, adbPath));
    console.log(`[api] adb discovery: ${result.added.length} added, ${result.skipped.length} skipped`);
  } catch (e) {
    console.warn(`[api] adb discovery failed (using "${adbPath}"): ${e instanceof Error ? e.message : String(e)}`);
  }

  const runtime = initializeAgentLab({ deviceManager: devices, providers });
  const port = Number(process.env.PORT ?? 4000);
  createApiServer(runtime, { webRoot: process.env.WEB_ROOT ?? "web", adbPath }).listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
