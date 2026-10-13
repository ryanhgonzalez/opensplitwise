import { boxesToLines, type Box } from './receiptLines';

// ─────────────────────────────────────────────────────────────────────────────
// Receipt OCR: PaddleOCR's PP-OCRv6 small models (a text detector and a text
// recogniser, Apache-2.0) run on the CPU by ONNX Runtime's WebAssembly build.
//
// No WebGPU, ~45 MB downloaded on the first scan (models from /ocr, see
// scripts/ocrModels.ts, plus ONNX Runtime's wasm), then kept in the browser's
// Cache Storage for offline use. About 1 s per receipt in Chrome, Safari and Firefox on a laptop when
// the page is cross-origin isolated, which lets ONNX Runtime use threads.
// On the bench's sample receipts: totals 100%, items F1 0.81–0.91 (Tesseract:
// 33% and 0.25).
//
// Pipeline, following PaddleOCR's own inference configs:
//   1. Detection (DB): the image (BGR, ImageNet-normalised) → a per-pixel
//      "is text" probability map. Pixels above `thresh` are grouped into
//      boxes, kept if their mean probability clears `boxThresh`, then grown
//      by the "unclip" distance, since DB maps cover only the text's core.
//   2. Recognition (CTC): each box, cropped from the full-resolution image,
//      resized to 48 px tall, scaled to [-1, 1] → per-column character
//      scores → greedy CTC decode.
//   3. The boxes become text lines (boxesToLines) for parseReceiptText.
//
// Simplification: boxes are axis-aligned (PaddleOCR fits rotated rectangles),
// which is fine for receipts photographed roughly straight.
// ─────────────────────────────────────────────────────────────────────────────

export interface OcrModel {
  /** Identifies the loaded sessions; one model set is kept in memory per id. */
  id: string;
  det: string;
  rec: string;
  dict: () => Promise<string[]>;
  /** Approximate download, for progress before the sizes are known. */
  approxBytes: number;
  /** DB post-processing, from the model's inference.yml. */
  thresh: number;
  boxThresh: number;
  unclipRatio: number;
}

/** What the app ships. File names match scripts/ocrModels.ts. */
export const RECEIPT_OCR: OcrModel = {
  id: 'pp-ocrv6-small',
  det: '/ocr/det-d73e0058.onnx',
  rec: '/ocr/rec-5435fd74.onnx',
  dict: () => import('./ocr/pp-ocrv6-small-dict.json').then((m) => m.default),
  approxBytes: 45e6,
  thresh: 0.2,
  boxThresh: 0.45,
  unclipRatio: 1.4,
};

export type OcrProgress = (
  p: { phase: 'download'; loaded: number; total: number } | { phase: 'prepare' } | { phase: 'read'; fraction: number },
) => void;

// ─── Pure steps (unit-tested) ─────────────────────────────────────────────────

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

/**
 * DB post-processing on a probability map (row-major, `w`×`h`): groups
 * above-threshold pixels into 4-connected regions and returns each region's
 * bounding box, grown by the unclip distance (area × ratio / perimeter).
 */
export function dbBoxes(
  prob: Float32Array,
  w: number,
  h: number,
  opts: { thresh: number; boxThresh: number; unclipRatio: number; minSize?: number },
): Region[] {
  const minSize = opts.minSize ?? 3;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const out: Region[] = [];

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= opts.thresh) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, n = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      sum += prob[i];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < minSize) continue;
    const score = sum / n;
    if (score < opts.boxThresh) continue;
    const d = (bw * bh * opts.unclipRatio) / (2 * (bw + bh));
    out.push({
      x0: Math.max(0, x0 - d),
      y0: Math.max(0, y0 - d),
      x1: Math.min(w, x1 + 1 + d),
      y1: Math.min(h, y1 + 1 + d),
      score,
    });
  }
  return out;

  function visit(j: number) {
    if (!seen[j] && prob[j] > opts.thresh) {
      seen[j] = 1;
      stack.push(j);
    }
  }
}

/**
 * Greedy CTC decode of recogniser output (`steps`×`classes`, row-major).
 * Class 0 is the blank; class i is dict[i - 1]; one class past the
 * dictionary is a space (PaddleOCR's use_space_char).
 */
export function ctcDecode(
  scores: Float32Array,
  steps: number,
  classes: number,
  dict: string[],
): { text: string; confidence: number } {
  let text = '';
  let prev = -1;
  let confSum = 0;
  let confN = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < classes; c++) {
      const s = scores[t * classes + c];
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += best - 1 < dict.length ? dict[best - 1] : ' ';
      confSum += bestScore;
      confN++;
    }
    prev = best;
  }
  return { text, confidence: confN ? confSum / confN : 0 };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

type Ort = typeof import('onnxruntime-web/wasm');
type Session = import('onnxruntime-web/wasm').InferenceSession;

let ortPromise: Promise<{ ort: Ort; wasmUrl: string }> | null = null;
function loadOrt() {
  ortPromise ??= Promise.all([
    import('onnxruntime-web/wasm'),
    import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
  ]).then(([ort, { default: wasmUrl }]) => {
    // Threads need SharedArrayBuffer, which only a cross-origin isolated page has.
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return { ort, wasmUrl };
  });
  return ortPromise;
}

/**
 * Where the OCR files are kept for offline use. The page manages this cache
 * itself rather than leaving it to the service worker, which doesn't control
 * the page on a first visit, so a first scan's downloads would go uncached.
 */
const CACHE = 'ocr-files';

/** Whether the model's files are already saved, so scanning works offline. */
export async function isOcrDownloaded(model: OcrModel = RECEIPT_OCR): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(CACHE);
    const hits = await Promise.all([model.det, model.rec].map((url) => cache.match(url)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

/**
 * Loads several files from the cache, downloading (and caching) any that are
 * missing with their combined progress reported. Cached entries that aren't
 * in `urls` (an older model version) are removed once everything's in.
 */
async function loadFiles(urls: string[], approxBytes: number, onProgress?: OcrProgress): Promise<ArrayBuffer[]> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE).catch(() => null);
  const loaded = urls.map(() => 0);
  const totals = urls.map(() => 0);
  const report = () => {
    const sumTotal = totals.reduce((a, b) => a + b, 0);
    const total = totals.every((t) => t > 0) ? sumTotal : Math.max(sumTotal, approxBytes);
    onProgress?.({ phase: 'download', loaded: loaded.reduce((a, b) => a + b, 0), total });
  };
  const files = await Promise.all(
    urls.map(async (url, i) => {
      const hit = await cache?.match(url);
      if (hit) return hit.arrayBuffer();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download the receipt reader (${res.status})`);
      totals[i] = Number(res.headers.get('content-length')) || 0;
      if (!res.body) return res.arrayBuffer();
      const chunks: Uint8Array[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded[i] += value.byteLength;
        report();
      }
      const out = new Uint8Array(loaded[i]);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      // A full disk or private mode can refuse this; the scan still works, just not offline.
      await cache?.put(url, new Response(out.slice(), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
      return out.buffer;
    }),
  );
  if (cache) {
    const keep = new Set(urls.map((u) => new URL(u, location.href).href));
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  }
  return files;
}

interface Loaded {
  ort: Ort;
  det: Session;
  rec: Session;
  dict: string[];
}

const loaded = new Map<string, Promise<Loaded>>();

/** Downloads (first time) and loads the models. Later calls reuse them. */
export function loadOcr(model: OcrModel, onProgress?: OcrProgress): Promise<Loaded> {
  let p = loaded.get(model.id);
  if (!p) {
    p = (async () => {
      const { ort, wasmUrl } = await loadOrt();
      // The wasm comes through here too, so its download shows in the progress
      // and is cached; ONNX Runtime is handed the bytes instead of fetching it.
      const [det, rec, wasm] = await loadFiles([model.det, model.rec, wasmUrl], model.approxBytes, onProgress);
      ort.env.wasm.wasmBinary = wasm;
      onProgress?.({ phase: 'prepare' });
      const [detSession, recSession, dict] = await Promise.all([
        ort.InferenceSession.create(new Uint8Array(det)),
        ort.InferenceSession.create(new Uint8Array(rec)),
        model.dict(),
      ]);
      return { ort, det: detSession, rec: recSession, dict };
    })();
    // A failed load (offline, storage full) shouldn't stick: let the next scan retry.
    p.catch(() => loaded.delete(model.id));
    loaded.set(model.id, p);
  }
  return p;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Detector input size: short side ≥ 736 px (small photos get enlarged), long side ≤ 2400, both multiples of 32. */
function detSize(w: number, h: number): [number, number] {
  let scale = Math.max(1, 736 / Math.min(w, h));
  scale = Math.min(scale, 2400 / Math.max(w, h), 3);
  const r32 = (n: number) => Math.max(32, Math.round((n * scale) / 32) * 32);
  return [r32(w), r32(h)];
}

function pixels(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh).data;
}

/** RGBA pixels → CHW float tensor data in BGR order, normalised per channel. */
function toChwBgr(rgba: Uint8ClampedArray, w: number, h: number, mean: number[], std: number[]): Float32Array {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    out[i] = (rgba[i * 4 + 2] / 255 - mean[0]) / std[0];
    out[plane + i] = (rgba[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + i] = (rgba[i * 4] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Reads a receipt photo and returns its text, one printed line per line. */
export async function readReceiptText(file: File, model: OcrModel = RECEIPT_OCR, onProgress?: OcrProgress): Promise<string> {
  const { ort, det, rec, dict } = await loadOcr(model, onProgress);
  onProgress?.({ phase: 'read', fraction: 0 });
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    // 1. Detection
    const [dw, dh] = detSize(img.width, img.height);
    const detIn = new ort.Tensor('float32', toChwBgr(pixels(img, 0, 0, img.width, img.height, dw, dh), dw, dh, MEAN, STD), [1, 3, dh, dw]);
    const detOut = await det.run({ [det.inputNames[0]]: detIn });
    detIn.dispose();
    const probTensor = detOut[det.outputNames[0]];
    const regions = dbBoxes(probTensor.data as Float32Array, dw, dh, model);
    probTensor.dispose();
    const sx = img.width / dw;
    const sy = img.height / dh;

    // 2. Recognition, one box at a time, from the full-resolution image.
    const boxes: Box[] = [];
    for (const [i, r] of regions.entries()) {
      const x = r.x0 * sx;
      const y = r.y0 * sy;
      const w = (r.x1 - r.x0) * sx;
      const h = (r.y1 - r.y0) * sy;
      if (w >= 2 && h >= 2) {
        const rh = 48;
        const rw = Math.max(16, Math.min(3200, Math.ceil((rh * w) / h)));
        const recIn = new ort.Tensor('float32', toChwBgr(pixels(img, x, y, w, h, rw, rh), rw, rh, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, rh, rw]);
        const recOut = await rec.run({ [rec.inputNames[0]]: recIn });
        recIn.dispose();
        const t = recOut[rec.outputNames[0]];
        const [, steps, classes] = t.dims as number[];
        const { text, confidence } = ctcDecode(t.data as Float32Array, steps, classes, dict);
        t.dispose();
        if (text.trim() && confidence > 0.5) boxes.push({ text, x0: x, y0: y, x1: x + w, y1: y + h });
      }
      onProgress?.({ phase: 'read', fraction: (i + 1) / regions.length });
    }
    return boxesToLines(boxes).join('\n');
  } finally {
    img.close();
  }
}
