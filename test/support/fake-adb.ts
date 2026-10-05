import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoScreenshot } from "../../src/ui/demo-png.js";

export const FAKE_SERIAL = "FAKE0001";

export const FAKE_UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.fake.app" clickable="false" enabled="true" bounds="[0,0][1080,1920]">
<node index="0" text="Open menu" resource-id="com.fake.app:id/menu" class="android.widget.Button" package="com.fake.app" content-desc="" clickable="true" enabled="true" bounds="[100,200][500,300]" />
</node></hierarchy>
UI hierarchy dumped to: /dev/tty`;

export interface FakeAdb {
  /** Path of the fake `adb` executable. */
  bin: string;
  dir: string;
  /** Everything the fake was asked to do (after the -s <serial> prefix), one line per call. */
  calls: () => string[];
  /** Replace the logcat content. */
  setLog: (text: string) => void;
}

import { readFileSync } from "node:fs";

/**
 * A shell script that imitates `adb` for one connected device. It is a SIMULATION: it proves AgentLab's process
 * handling (execFile, binary stdout, argument construction, parsing) but says nothing about real Android behaviour.
 * Launching package com.fake.crash appends a FATAL EXCEPTION to the log.
 */
export function createFakeAdb(opts: { state?: string } = {}): FakeAdb {
  const dir = mkdtempSync(join(tmpdir(), "fake-adb-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "screen.png"), demoScreenshot(0));
  writeFileSync(join(dir, "ui.xml"), FAKE_UI_XML);
  writeFileSync(join(dir, "log.txt"), "I/ActivityManager: boot completed\n");
  writeFileSync(join(dir, "calls.txt"), "");
  const bin = join(dir, "adb");
  const state = opts.state ?? "device";
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
S="${FAKE_SERIAL}"
if [ "$1" = "-s" ]; then
  if [ "$2" != "$S" ]; then echo "adb: device '$2' not found" >&2; exit 1; fi
  shift 2
  echo "$*" >> "$D/calls.txt"
  if [ "${state}" != "device" ]; then echo "error: device ${state}" >&2; exit 1; fi
fi
case "$*" in
  "devices -l") printf 'List of devices attached\\n%s   ${state} usb:1-1 product:fake model:Fake_Phone device:fake transport_id:1\\n\\n' "$S" ;;
  "shell getprop ro.product.model") echo "Fake_Phone" ;;
  "shell getprop ro.build.version.release") echo "14" ;;
  "exec-out screencap -p") cat "$D/screen.png" ;;
  "exec-out uiautomator dump /dev/tty") cat "$D/ui.xml" ;;
  "logcat -c") : > "$D/log.txt" ;;
  logcat\\ -d\\ -t\\ *) cat "$D/log.txt" ;;
  shell\\ monkey\\ *com.fake.crash*) printf '01-01 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main\\n01-01 10:00:00.001  100  100 E AndroidRuntime: Process: com.fake.crash, PID: 100\\n01-01 10:00:00.002  100  100 E AndroidRuntime: java.lang.IllegalStateException: boom\\n' >> "$D/log.txt" ;;
  shell\\ monkey\\ *|shell\\ am\\ start\\ *|shell\\ am\\ force-stop\\ *|shell\\ input\\ *) : ;;
  install\\ *) echo "Success" ;;
  *) echo "fake adb: unsupported: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    calls: () => readFileSync(join(dir, "calls.txt"), "utf8").split("\n").filter(Boolean),
    setLog: (text) => writeFileSync(join(dir, "log.txt"), text),
  };
}
