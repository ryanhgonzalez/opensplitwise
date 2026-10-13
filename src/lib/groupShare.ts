import { BUNDLE_KIND, BUNDLE_VERSION, type GroupBundle } from './groupSync';

// ─────────────────────────────────────────────────────────────────────────────
// Getting a group bundle (groupSync.ts) from one phone to another.
//
//   • File: readable JSON, sent through the share sheet (AirDrop, Messages…)
//     and opened on the other phone from Groups → Receive.
//   • Code: the same JSON, compressed, split into small QR frames that cycle
//     on screen (frames below; drawing and scanning live in the UI).
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const revive = (_: string, v: unknown) => (typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v);

/** Reads a bundle from JSON text, or explains why it isn't one. */
export function parseBundle(text: string): GroupBundle {
  let data: unknown;
  try {
    data = JSON.parse(text, revive);
  } catch {
    throw new Error('That isn’t a shared group (not valid JSON).');
  }
  const b = data as Partial<GroupBundle> | null;
  if (!b || b.kind !== BUNDLE_KIND) throw new Error('That isn’t a shared group.');
  if (b.v !== BUNDLE_VERSION) throw new Error('This group was shared from a newer version of the app. Update and try again.');
  if (!b.group?.id || !b.group.name || !Array.isArray(b.users) || !Array.isArray(b.expenses)) {
    throw new Error('This shared group is incomplete.');
  }
  return { ...b, settlements: b.settlements ?? [], tombstones: b.tombstones ?? [] } as GroupBundle;
}

// ─── File ─────────────────────────────────────────────────────────────────────

export function bundleFile(bundle: GroupBundle): File {
  const slug = bundle.group.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'group';
  return new File([JSON.stringify(bundle)], `${slug}.opensplitwise-group.json`, { type: 'application/json' });
}

/**
 * Sends the group through the share sheet where the browser can share files
 * (phones, Safari), otherwise downloads it. Resolves false if the person
 * cancelled the share sheet.
 */
export async function sendBundleFile(bundle: GroupBundle): Promise<boolean> {
  const file = bundleFile(bundle);
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: bundle.group.name });
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      // Sharing failed for another reason: fall through to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

// ─── Compression ──────────────────────────────────────────────────────────────

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const compressBundle = (bundle: GroupBundle) =>
  pipe(new TextEncoder().encode(JSON.stringify(bundle)), new CompressionStream('deflate'));

export async function decompressBundle(bytes: Uint8Array): Promise<GroupBundle> {
  let text: string;
  try {
    text = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate')));
  } catch {
    throw new Error('The code was read incompletely. Try scanning again.');
  }
  return parseBundle(text);
}

// ─── Frames ───────────────────────────────────────────────────────────────────
//
// Each QR frame carries a 7-byte header and up to FRAME_BYTES of the payload:
//   0      'O' — marks our frames, so a stray QR code is ignored
//   1      format version (1)
//   2–3    transfer id: frames from different shares never mix
//   4      frame index
//   5      frame count
//   6      reserved (0)
// The frames cycle on screen; the receiver keeps each index once and has the
// bundle when it holds all of them.

/** Payload bytes per frame: a QR version around 15–20 that a phone reads easily off a screen. */
export const FRAME_BYTES = 600;
const HEADER = 7;
const MAGIC = 0x4f; // 'O'

export function toFrames(payload: Uint8Array, transferId = Math.floor(Math.random() * 0x10000)): Uint8Array[] {
  const count = Math.max(1, Math.ceil(payload.length / FRAME_BYTES));
  if (count > 255) throw new Error('This group is too large to share as a code. Send it as a file instead.');
  return Array.from({ length: count }, (_, i) => {
    const chunk = payload.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
    const frame = new Uint8Array(HEADER + chunk.length);
    frame.set([MAGIC, 1, transferId >> 8, transferId & 0xff, i, count, 0]);
    frame.set(chunk, HEADER);
    return frame;
  });
}

/** Collects frames as they're scanned, in any order and with repeats. */
export class FrameCollector {
  private transferId = -1;
  private parts: (Uint8Array | undefined)[] = [];

  /** Adds a scanned frame; false if it isn't one of ours. */
  add(frame: Uint8Array): boolean {
    if (frame.length < HEADER || frame[0] !== MAGIC || frame[1] !== 1) return false;
    const id = (frame[2] << 8) | frame[3];
    const index = frame[4];
    const count = frame[5];
    if (count === 0 || index >= count) return false;
    // A different share started on screen: begin again with it.
    if (id !== this.transferId || this.parts.length !== count) {
      this.transferId = id;
      this.parts = new Array(count).fill(undefined);
    }
    this.parts[index] ??= frame.slice(HEADER);
    return true;
  }

  get received() {
    return this.parts.filter(Boolean).length;
  }

  get total() {
    return this.parts.length;
  }

  /** For each part, in order, whether it has arrived. */
  get arrived(): boolean[] {
    return this.parts.map(Boolean);
  }

  get complete() {
    return this.total > 0 && this.received === this.total;
  }

  payload(): Uint8Array {
    if (!this.complete) throw new Error('Not all frames have arrived yet.');
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p!.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p!, at);
      at += p!.length;
    }
    return out;
  }
}
