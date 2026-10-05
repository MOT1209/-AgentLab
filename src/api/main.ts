import { initializeAgentLab } from "../bootstrap.js";
import { loadProviderFile } from "../providers/config.js";
import { ProviderManager } from "../providers/manager.js";
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
  let providers: ProviderManager | undefined;
  try {
    providers = ProviderManager.fromFile(loadProviderFile(providersFile));
  } catch (e) {
    console.warn(`[api] no usable provider file at ${providersFile}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const devices = new DeviceManager();
  try {
    const result = await devices.discover(new AdbDiscovery());
    console.log(`[api] adb discovery: ${result.added.length} added, ${result.skipped.length} skipped`);
  } catch (e) {
    console.warn(`[api] adb discovery failed (adb not found or no devices): ${e instanceof Error ? e.message : String(e)}`);
  }

  const runtime = initializeAgentLab({ deviceManager: devices, ...(providers ? { providers } : {}) });
  const port = Number(process.env.PORT ?? 4000);
  createApiServer(runtime).listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
