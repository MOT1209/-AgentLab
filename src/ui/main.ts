import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { UiApp } from "./app.js";
import { createUiServer } from "./server.js";

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const port = Number(portArg >= 0 ? argv[portArg + 1] : (process.env.AGENTLAB_UI_PORT ?? 4173));
const token = randomBytes(16).toString("hex");

const app = new UiApp(process.env.ADB_PATH ? { adbPath: process.env.ADB_PATH } : {});
const server = createUiServer(app, { token });
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Try:  npm run ui -- --port 4174` : `Server error: ${e.message}`);
  process.exit(1);
});
// 127.0.0.1 only: nothing outside this computer can reach the UI.
server.listen(port, "127.0.0.1", () => {
  const actual = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${actual}/?token=${token}`;
  console.log(`\nAgentLab UI is running.\n\n  ${url}\n\nOpen that link in your browser (it contains a one-time secret). Press Ctrl+C to stop.\n`);
  if (!argv.includes("--no-open")) {
    // Fixed program names, URL as a single argument, no shell.
    const [cmd, args]: [string, string[]] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    execFile(cmd, args, () => undefined);
  }
});
process.once("SIGINT", () => {
  server.close();
  process.exit(0);
});
