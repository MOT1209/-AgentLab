import { crc32, deflateSync } from "node:zlib";

const W = 270;
const H = 480;

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes raw RGB rows as a valid PNG. No dependencies. */
function encode(rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (W * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A fake phone screen for the demo, so the UI shows real images. Phone coordinates are 1080x1920. */
export function demoScreenshot(step: number, lastTap?: { x: number; y: number }): Buffer {
  const px = new Uint8Array(W * H * 3);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) px.set(c, (y * W + x) * 3);
  };
  rect(0, 0, W, H, [245, 246, 248]);
  rect(0, 0, W, 40, [37 + step * 12, 99, 235]); // app bar changes with each step
  rect(110, 90, 160, 110, [59, 130, 246]); // "Menu"
  rect(110, 150, 160, 170, [148, 163, 184]); // "Settings"
  for (let i = 0; i < 6; i++) rect(30, 220 + i * 38, W - 30 - (i % 3) * 40, 242 + i * 38, [226, 232, 240]); // list rows
  rect(W - 8, 60 + ((step * 40) % 300), W - 4, 110 + ((step * 40) % 300), [100, 116, 139]); // scroll bar
  if (lastTap) {
    const cx = Math.round(lastTap.x / 4);
    const cy = Math.round(lastTap.y / 4);
    rect(cx - 6, cy - 6, cx + 6, cy + 6, [220, 38, 38]); // red marker where the last tap landed
  }
  return encode(px);
}
