import { boxesToLines, type Box } from './receiptLines';

// ─────────────────────────────────────────────────────────────────────────────
// Receipt OCR: PaddleOCR's PP-OCRv6 small models (a text detector and a text
// recogniser, Apache-2.0) run on the CPU by ONNX Runtime's WebAssembly build.
//
// No WebGPU, ~45 MB downloaded on the first scan (models from /ocr, see
// scripts/ocrModels.ts, plus ONNX Runtime's wasm), then kept in the browser's
// Cache Storage for offline use. About 2 s for a 12-megapixel photo on a
// laptop when the page is cross-origin isolated, which lets ONNX Runtime use
// threads. On the bench's phone-sized test photos (straight, tilted, sideways,
// dim): totals 100%, dates 86–100%, items F1 0.77–1.00; without straightening,
// totals 64–91%.
//
// Pipeline, following PaddleOCR's own inference configs:
//   1. A first look at low resolution: which way the text runs (textAngle),
//      and where on the photo it is. A tilted or sideways photo is turned
//      level, and the next step looks only at the receipt, not the table.
//   2. Detection (DB): the image (BGR, ImageNet-normalised) → a per-pixel
//      "is text" probability map. Pixels above `thresh` are grouped into
//      boxes, kept if their mean probability clears `boxThresh`, then grown
//      by the "unclip" distance, since DB maps cover only the text's core.
//   3. Which way up: the start of a few lines is read; if that reads poorly,
//      it's read upside down too, and the better way is kept.
//   4. Recognition (CTC): each box, cropped from the full-resolution photo,
//      resized to 48 px tall, scaled to [-1, 1] → per-column character
//      scores → greedy CTC decode.
//   5. The boxes become text lines (boxesToLines) for parseReceiptText.
//
// Boxes are axis-aligned (PaddleOCR fits rotated rectangles); once the photo
// is level, that's enough. Without levelling, a 5° tilt was enough to make
// boxes cut across lines.
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
  /** The direction the region runs in, degrees from horizontal, in (-90, 90]: a text line's slant. */
  angle: number;
  /** How line-like it is: 0 for a round blob, near 1 for a long thin line. */
  elongation: number;
  /** Its size in map pixels. */
  pixels: number;
}

export interface DbOptions {
  thresh: number;
  boxThresh: number;
  unclipRatio: number;
  minSize?: number;
}

/** Direction and elongation of a set of pixels, from their second moments. */
function shapeOf(sx: number, sy: number, sxx: number, syy: number, sxy: number, n: number) {
  const cx = sx / n;
  const cy = sy / n;
  const mu20 = sxx / n - cx * cx;
  const mu02 = syy / n - cy * cy;
  const mu11 = sxy / n - cx * cy;
  const half = (mu20 - mu02) / 2;
  const root = Math.sqrt(half * half + mu11 * mu11);
  const l1 = (mu20 + mu02) / 2 + root;
  const l2 = (mu20 + mu02) / 2 - root;
  let angle = (Math.atan2(2 * mu11, mu20 - mu02) / 2) * (180 / Math.PI);
  if (angle <= -90) angle += 180;
  return { angle, elongation: l1 > 0 ? 1 - Math.max(0, l2) / l1 : 0 };
}

/**
 * DB post-processing on a probability map (row-major, `w`×`h`): groups
 * above-threshold pixels into 4-connected regions and returns each region's
 * bounding box, grown by the unclip distance (area × ratio / perimeter).
 */
export function dbBoxes(prob: Float32Array, w: number, h: number, opts: DbOptions): Region[] {
  const minSize = opts.minSize ?? 3;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const out: Region[] = [];

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= opts.thresh) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, n = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      sum += prob[i];
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
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
      pixels: n,
      ...shapeOf(sx, sy, sxx, syy, sxy, n),
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
 * The slant of the text, degrees in (-90, 90]: the average direction of the
 * line-like regions, weighted by size. Directions are averaged doubled, so
 * 89° and -89° (both nearly vertical) agree rather than cancel.
 */
export function textAngle(regions: Pick<Region, 'angle' | 'elongation' | 'pixels'>[]): number {
  let c = 0;
  let s = 0;
  for (const r of regions) {
    if (r.elongation < 0.6) continue;
    const wgt = r.pixels * r.elongation;
    const a = (2 * r.angle * Math.PI) / 180;
    c += wgt * Math.cos(a);
    s += wgt * Math.sin(a);
  }
  if (c === 0 && s === 0) return 0;
  let angle = ((Math.atan2(s, c) / 2) * 180) / Math.PI;
  if (angle <= -90) angle += 180;
  return angle;
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

export interface ReadOptions {
  /**
   * Straighten the photo first (on by default): a tilted receipt (even 5°)
   * gets boxes that cut across lines, and a sideways or upside-down one
   * reads as nonsense.
   */
  straighten?: boolean;
  /**
   * Look for the text only where the first look found some (the receipt, not
   * the table it's on), on by default: fewer pixels for the detector, which
   * makes up the time straightening takes.
   */
  cropToText?: boolean;
  /** Filled in with where the time went, for the bench. */
  stats?: ReadStats;
}

export interface ReadStats {
  detMs: number;
  recMs: number;
  detRuns: number;
  boxes: number;
  /** How far the photo was turned to straighten it, degrees. */
  turned: number;
  /** Of recMs, the time spent checking which way up it is. */
  flipMs: number;
}

/** Detector input size: short side ≥ 736 px (small photos get enlarged), long side ≤ maxSide, both multiples of 32. */
function detSize(w: number, h: number, maxSide: number): [number, number] {
  let scale = Math.max(1, 736 / Math.min(w, h));
  scale = Math.min(scale, maxSide / Math.max(w, h), 3);
  const r32 = (n: number) => Math.max(32, Math.round((n * scale) / 32) * 32);
  return [r32(w), r32(h)];
}

/**
 * The photo as the reader sees it: turned by `angle` (radians, clockwise)
 * about its centre, on a canvas of `w`×`h`. Parts of it are drawn from the
 * original as needed, so a turned 12-megapixel photo never needs a canvas of
 * its own (phones limit their size).
 */
interface View {
  src: CanvasImageSource;
  srcW: number;
  srcH: number;
  angle: number;
  w: number;
  h: number;
}

function turnedView(src: CanvasImageSource, srcW: number, srcH: number, angle: number): View {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  return { src, srcW, srcH, angle, w: Math.round(srcW * cos + srcH * sin), h: Math.round(srcW * sin + srcH * cos) };
}

/** RGBA pixels of the view's rectangle (x, y, w, h), drawn at dw×dh. */
function pixels(view: View, x: number, y: number, w: number, h: number, dw: number, dh: number) {
  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (view.angle === 0) {
    ctx.drawImage(view.src, x, y, w, h, 0, 0, dw, dh);
  } else {
    // Paper-white where the turned photo doesn't reach.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dw, dh);
    // Only the part of the photo under this rectangle: drawing all of a large
    // photo through the turn for each line of text was most of the reading time.
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([vx, vy]) => fromView(view, vx, vy));
    const sx = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 2);
    const sy = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 2);
    const ex = Math.min(view.srcW, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 2);
    const ey = Math.min(view.srcH, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 2);
    if (ex > sx && ey > sy) {
      ctx.setTransform(dw / w, 0, 0, dh / h, (-x * dw) / w, (-y * dh) / h);
      ctx.translate(view.w / 2, view.h / 2);
      ctx.rotate(view.angle);
      ctx.drawImage(view.src, sx, sy, ex - sx, ey - sy, sx - view.srcW / 2, sy - view.srcH / 2, ex - sx, ey - sy);
    }
  }
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

type Engine = Loaded & {
  model: OcrModel;
  options: ReadOptions;
  stats: ReadStats;
  /** Called as lines are read, with the share of them done. */
  onLines?: (fraction: number) => void;
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Text regions in part of the view (all of it by default), in the view's own
 * pixels. The detector's scale is set by the whole view, so text comes out the
 * same size whether or not it's cropped.
 */
async function detect(e: Engine, view: View, maxSide: number, part: Rect = { x: 0, y: 0, w: view.w, h: view.h }): Promise<Region[]> {
  const t0 = performance.now();
  const [fw, fh] = detSize(view.w, view.h, maxSide);
  const scale = Math.min(fw / view.w, fh / view.h);
  const r32 = (n: number) => Math.max(32, Math.round((n * scale) / 32) * 32);
  const [dw, dh] = part.w === view.w && part.h === view.h ? [fw, fh] : [r32(part.w), r32(part.h)];
  const input = new e.ort.Tensor('float32', toChwBgr(pixels(view, part.x, part.y, part.w, part.h, dw, dh), dw, dh, MEAN, STD), [1, 3, dh, dw]);
  const out = await e.det.run({ [e.det.inputNames[0]]: input });
  input.dispose();
  const prob = out[e.det.outputNames[0]];
  const regions = dbBoxes(prob.data as Float32Array, dw, dh, e.model);
  prob.dispose();
  const sx = part.w / dw;
  const sy = part.h / dh;
  e.stats.detMs += performance.now() - t0;
  e.stats.detRuns++;
  return regions.map((r) => {
    // The detector's input isn't quite the photo's shape: carry the slant over too.
    const rad = (r.angle * Math.PI) / 180;
    const angle = (Math.atan2(Math.sin(rad) * sy, Math.cos(rad) * sx) * 180) / Math.PI;
    return {
      ...r,
      x0: part.x + r.x0 * sx,
      y0: part.y + r.y0 * sy,
      x1: part.x + r.x1 * sx,
      y1: part.y + r.y1 * sy,
      angle: angle <= -90 ? angle + 180 : angle > 90 ? angle - 180 : angle,
    };
  });
}

/** Where a point of a turned view comes from in the photo. */
function fromView(view: View, x: number, y: number): [number, number] {
  const dx = x - view.w / 2;
  const dy = y - view.h / 2;
  const c = Math.cos(view.angle);
  const s = Math.sin(view.angle);
  return [dx * c + dy * s + view.srcW / 2, -dx * s + dy * c + view.srcH / 2];
}

/** Where a point of the photo lands in a turned view of it. */
function intoView(view: View, x: number, y: number): [number, number] {
  const dx = x - view.srcW / 2;
  const dy = y - view.srcH / 2;
  const c = Math.cos(view.angle);
  const s = Math.sin(view.angle);
  return [dx * c - dy * s + view.w / 2, dx * s + dy * c + view.h / 2];
}

/** The part of the view holding the regions (found in the photo, unturned), with a margin. */
function textArea(view: View, regions: Region[]): Rect | undefined {
  if (!regions.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) {
    for (const [px, py] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) {
      const [x, y] = intoView(view, px, py);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const margin = 0.03 * Math.max(view.w, view.h);
  const x = Math.max(0, x0 - margin);
  const y = Math.max(0, y0 - margin);
  return { x, y, w: Math.min(view.w, x1 + margin) - x, h: Math.min(view.h, y1 + margin) - y };
}

interface Read {
  text: string;
  confidence: number;
}

let lastBreath = 0;
/**
 * Lets the page draw (the progress shown) when reading has held it for a
 * tenth of a second. The models run on the page's own thread, and without
 * this the progress stayed at 0% until the end. A message, not a timer:
 * browsers slow timers right down in a tab that isn't showing.
 */
async function breathe() {
  if (performance.now() - lastBreath < 100) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
  lastBreath = performance.now();
}

/** Reads each region's text: cropped from the view, 48 px tall, one at a time. */
async function recognize(e: Engine, view: View, regions: Region[]): Promise<Read[]> {
  const t0 = performance.now();
  const rh = 48;
  const results: Read[] = [];
  for (const [k, r] of regions.entries()) {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w < 2 || h < 2) {
      results.push({ text: '', confidence: 0 });
      continue;
    }
    const rw = Math.max(16, Math.min(3200, Math.ceil((rh * w) / h)));
    const input = new e.ort.Tensor('float32', toChwBgr(pixels(view, r.x0, r.y0, w, h, rw, rh), rw, rh, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, rh, rw]);
    const out = await e.rec.run({ [e.rec.inputNames[0]]: input });
    input.dispose();
    const t = out[e.rec.outputNames[0]];
    const [, steps, classes] = t.dims as number[];
    results.push(ctcDecode(t.data as Float32Array, steps, classes, e.dict));
    t.dispose();
    e.onLines?.((k + 1) / regions.length);
    await breathe();
  }
  e.stats.recMs += performance.now() - t0;
  return results;
}

/** The same regions with the view turned half a turn. */
function halfTurn(view: View, regions: Region[]): [View, Region[]] {
  const turned = { ...view, angle: view.angle + Math.PI };
  return [turned, regions.map((r) => ({ ...r, x0: view.w - r.x1, x1: view.w - r.x0, y0: view.h - r.y1, y1: view.h - r.y0 }))];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Reads a receipt photo and returns its text, one printed line per line. */
export async function readReceiptText(
  file: File,
  model: OcrModel = RECEIPT_OCR,
  onProgress?: OcrProgress,
  options: ReadOptions = {},
): Promise<string> {
  const loadedModel = await loadOcr(model, onProgress);
  const stats: ReadStats = Object.assign(options.stats ?? {}, { detMs: 0, recMs: 0, detRuns: 0, boxes: 0, turned: 0, flipMs: 0 });
  const e: Engine = { ...loadedModel, model, options, stats };
  onProgress?.({ phase: 'read', fraction: 0 });
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { straighten = true, cropToText = true } = options;
  try {
    const maxSide = 2400;
    let view = turnedView(img, img.width, img.height, 0);
    let regions: Region[];
    if (straighten || cropToText) {
      // A first look, to see which way the text runs and where it is. At low
      // resolution for a photo; a small image gets its one full look here.
      const small = Math.max(img.width, img.height) <= 1600;
      const glance = await detect(e, view, small ? maxSide : 960);
      const slant = straighten ? textAngle(glance) : 0;
      if (Math.abs(slant) > 0.75) {
        view = turnedView(img, img.width, img.height, (-slant * Math.PI) / 180);
        stats.turned = -slant;
      }
      if (small && view.angle === 0) regions = glance;
      else regions = await detect(e, view, maxSide, cropToText && !small ? textArea(view, glance) : undefined);
    } else {
      regions = await detect(e, view, maxSide);
    }

    if (straighten && regions.length) {
      // Level, but maybe upside down. Text the right way up reads with high
      // confidence, so the start of a few lines is read that way first, and
      // only read upside down too when that goes poorly.
      const tf = performance.now();
      const lineLike = regions.filter((r) => r.x1 - r.x0 > 3 * (r.y1 - r.y0)).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
      const sample = lineLike.slice(Math.floor(lineLike.length * 0.1), Math.floor(lineLike.length * 0.1) + 4).map((r) => ({
        ...r,
        x1: Math.min(r.x1, r.x0 + 8 * (r.y1 - r.y0)),
      }));
      const upright = mean((await recognize(e, view, sample)).map((r) => r.confidence));
      if (upright < 0.85) {
        const [flipped, flippedSample] = halfTurn(view, sample);
        const upsideDown = mean((await recognize(e, flipped, flippedSample)).map((r) => r.confidence));
        if (upsideDown > upright + 0.05) {
          [view, regions] = halfTurn(view, regions);
          stats.turned += 180;
        }
      }
      stats.flipMs = performance.now() - tf;
    }
    // Finding the text is about a quarter of the time; reading it, the rest.
    onProgress?.({ phase: 'read', fraction: 0.25 });
    await breathe();
    e.onLines = (f) => onProgress?.({ phase: 'read', fraction: 0.25 + 0.75 * f });
    const reads = await recognize(e, view, regions);

    const boxes: Box[] = [];
    regions.forEach((r, i) => {
      const { text, confidence } = reads[i];
      if (text.trim() && confidence > 0.5) boxes.push({ text, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
    });
    stats.boxes = boxes.length;
    return boxesToLines(boxes).join('\n');
  } finally {
    img.close();
  }
}
