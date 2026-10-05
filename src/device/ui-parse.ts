import type { UiNode } from "./types.js";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " ").replace(/&amp;/g, "&");

/** Parses `uiautomator dump` XML. The format is machine-generated and regular, so attribute scanning is sufficient. */
export function parseUiAutomatorXml(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2] ?? "");
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? "");
    if (!b) continue;
    nodes.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      id: attrs["resource-id"] ?? "",
      cls: attrs.class ?? "",
      pkg: attrs.package ?? "",
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      bounds: { l: Number(b[1]), t: Number(b[2]), r: Number(b[3]), b: Number(b[4]) },
    });
  }
  return nodes;
}
