import { boxesToLines, dedupeOverlap, quadToBox, type Box } from './receiptLines';

// ─────────────────────────────────────────────────────────────────────────────
// Better scan: Florence-2 (a small on-device vision model) reads the receipt
// instead of Tesseract, and the same text parser turns its lines into fields.
//
// Opt-in because it costs a one-time ~390 MB download and ~10 s per receipt.
// Offered only where WebGPU exists: on the WASM fallback it takes minutes.
// Not offered in Firefox (see isFirefox).
// Transformers.js is lazy-loaded, so none of this touches the main bundle.
// On the bench's sample receipts: totals 33% → 100%, items F1 0.25 → 0.69.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_ID = 'onnx-community/Florence-2-base-ft';
const TASK = '<OCR_WITH_REGION>';

export type BetterScanPhase = 'download' | 'prepare' | 'read';

/**
 * Progress for the scan button. `download`: bytes fetched so far (first use
 * only); `prepare`: loading the model onto the GPU; `read`: fraction 0–1.
 */
export type BetterScanProgress = (phase: BetterScanPhase, progress: { loaded?: number; fraction?: number }) => void;

// ─── Device support ──────────────────────────────────────────────────────────

export interface DeviceInfo {
  webgpu: boolean;
  /** WebGPU adapter supports 16-bit floats, which the fp16 model files need. */
  f16: boolean;
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> };
};

let deviceInfo: Promise<DeviceInfo> | null = null;
export function getDeviceInfo(): Promise<DeviceInfo> {
  deviceInfo ??= (async () => {
    const gpu = typeof navigator === 'undefined' ? undefined : (navigator as GpuNavigator).gpu;
    if (!gpu) return { webgpu: false, f16: false };
    try {
      const adapter = await gpu.requestAdapter();
      return { webgpu: !!adapter, f16: !!adapter?.features.has('shader-f16') };
    } catch {
      return { webgpu: false, f16: false };
    }
  })();
  return deviceInfo;
}

/**
 * Firefox has WebGPU, but its shader compiler rejects one of ONNX Runtime's
 * shaders ("Pad", used by the vision encoder; seen in Firefox 157). The model
 * downloads and loads, then the first scan fails, so don't offer it there.
 * Firefox on iOS is WebKit underneath and says "FxiOS", not "Firefox/".
 */
const isFirefox = () => typeof navigator !== 'undefined' && /\bFirefox\//.test(navigator.userAgent);

export async function isBetterScanSupported(): Promise<boolean> {
  return !isBetterScanBlocked() && !isFirefox() && (await getDeviceInfo()).webgpu;
}

/**
 * Smallest sensible weights per component. WebGPU: 4-bit decoders, fp16 vision
 * where the GPU supports it. WASM fallback: 8-bit everything (slow, but runs).
 */
export async function runtimeFor(components: string[], decoder: 'q4' | 'fp16' = 'q4') {
  const { webgpu, f16 } = await getDeviceInfo();
  if (!webgpu) return { device: 'wasm' as const, dtype: 'q8' as const };
  const dtype: Record<string, 'fp16' | 'q4' | 'fp32'> = {};
  for (const c of components) {
    const isDecoder = c.startsWith('decoder') || c === 'encoder_model';
    dtype[c] = isDecoder ? (decoder === 'fp16' && !f16 ? 'fp32' : decoder) : f16 ? 'fp16' : 'q4';
  }
  return { device: 'webgpu' as const, dtype };
}

// ─── Remembering the choice and the download ─────────────────────────────────

const ENABLED_KEY = 'opensplitwise-better-scan';

export function isBetterScanEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setBetterScanEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // Private mode or blocked storage: the toggle just won't stick.
  }
}

/** Whether the model files are already in Transformers.js's cache (no download needed). */
export async function isModelDownloaded(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((k) => k.url.includes(MODEL_ID) && k.url.endsWith('.onnx'));
  } catch {
    return false;
  }
}

// ─── Surviving a crash ───────────────────────────────────────────────────────
//
// A scan needs about 1.5 GB of memory in the page. A phone browser that can't
// spare that kills the page outright, and it reloads with no error to catch,
// so the next scan would do the same. A marker in storage while a scan runs
// shows afterwards that the page died during one.

const RUNNING_KEY = 'opensplitwise-better-scan-running';
const BLOCKED_KEY = 'opensplitwise-better-scan-blocked';

/** Call with true just before a Better scan and false once it ends, however it ends. */
export function markBetterScanRunning(running: boolean): void {
  try {
    if (running) localStorage.setItem(RUNNING_KEY, '1');
    else localStorage.removeItem(RUNNING_KEY);
  } catch {
    // Without storage there's no marker; a crash just won't be noticed.
  }
}

function isBetterScanBlocked(): boolean {
  try {
    return localStorage.getItem(BLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * True when the page died during a Better scan before this load. Then Better
 * scan is switched off and hidden on this device, and its downloaded files are
 * deleted, since they'd only take up space. Checked once per page load; every
 * caller gets the same answer.
 */
let recovery: Promise<boolean> | null = null;
export function recoverFromBetterScanCrash(): Promise<boolean> {
  recovery ??= recover();
  return recovery;
}

/** True the first time it's called after a crash was found, so the explanation shows once. */
let noticeTaken = false;
export function takeCrashNotice(): boolean {
  if (noticeTaken) return false;
  noticeTaken = true;
  return true;
}

async function recover(): Promise<boolean> {
  try {
    if (localStorage.getItem(RUNNING_KEY) !== '1') return false;
    localStorage.removeItem(RUNNING_KEY);
    localStorage.setItem(BLOCKED_KEY, '1');
  } catch {
    return false;
  }
  setBetterScanEnabled(false);
  await deleteModelFiles();
  return true;
}

async function deleteModelFiles(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open('transformers-cache');
    for (const req of await cache.keys()) {
      if (req.url.includes(MODEL_ID) || req.url.includes('onnxruntime-web')) await cache.delete(req);
    }
  } catch {
    // Storage unavailable: nothing to free.
  }
}

// ─── Model ───────────────────────────────────────────────────────────────────

/** The parts of the Florence-2 model and processor this file uses. */
interface Florence {
  model: { generate: (inputs: Record<string, unknown>) => Promise<unknown> };
  processor: {
    (image: unknown, prompts: unknown): Promise<Record<string, unknown>>;
    construct_prompts: (task: string) => unknown;
    batch_decode: (ids: unknown, opts: { skip_special_tokens: boolean }) => string[];
    post_process_generation: (
      text: string,
      task: string,
      size: unknown,
    ) => Record<string, { quad_boxes: number[][]; labels: string[] }>;
  };
  RawImage: { fromCanvas: (c: HTMLCanvasElement) => { size: unknown } };
}

interface FileProgress {
  status?: string;
  file?: string;
  loaded?: number;
}

let florence: Promise<Florence> | null = null;

/** Downloads (first time) and loads Florence-2. Later calls reuse the loaded model. */
export function loadBetterScan(onProgress?: BetterScanProgress): Promise<Florence> {
  if (!florence) {
    florence = (async () => {
      onProgress?.('prepare', {});
      const [t, rt, cached] = await Promise.all([
        import('@huggingface/transformers'),
        runtimeFor(['embed_tokens', 'vision_encoder', 'encoder_model', 'decoder_model_merged']),
        isModelDownloaded(),
      ]);

      // Progress arrives per file, and files start one after another, so only
      // the bytes so far are meaningful (the running total keeps growing).
      // Reads from the cache report progress too; those aren't downloads.
      const files = new Map<string, number>();
      const progress_callback = (p: FileProgress) => {
        if (cached || p.status !== 'progress' || !p.file) return;
        files.set(p.file, p.loaded ?? 0);
        let loaded = 0;
        for (const n of files.values()) loaded += n;
        onProgress?.('download', { loaded });
      };

      const [model, processor] = await Promise.all([
        t.Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, { ...rt, progress_callback }),
        t.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      ]);
      return { model, processor, RawImage: t.RawImage } as unknown as Florence;
    })();
    // A failed load (network, out of memory) shouldn't stick: let the next scan retry.
    florence.catch(() => {
      florence = null;
    });
  }
  return florence;
}

// ─── Reading a receipt ───────────────────────────────────────────────────────

/** Scales an image so its long edge is at most `maxEdge`, returned as a canvas. */
function scaledCanvas(img: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Reads a receipt photo with Florence-2 and returns its text, one printed line per line. */
export async function readReceiptText(file: File, onProgress?: BetterScanProgress): Promise<string> {
  const { model, processor, RawImage } = await loadBetterScan(onProgress);
  onProgress?.('read', { fraction: 0 });

  // Florence squashes every input to 768×768, which makes a long receipt
  // illegible. Cut it into roughly square, overlapping tiles instead.
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const page = scaledCanvas(bmp, 1600);
  bmp.close();
  const tileH = Math.max(page.width, 400);
  const overlap = Math.round(tileH * 0.12);
  const step = tileH - overlap;
  const tiles = Math.max(1, Math.ceil((page.height - overlap) / step));
  const prompts = processor.construct_prompts(TASK);
  let boxes: Box[] = [];

  for (let i = 0, top = 0; i < tiles; i++, top += step) {
    const h = Math.min(tileH, page.height - top);
    const tile = document.createElement('canvas');
    tile.width = page.width;
    tile.height = h;
    tile.getContext('2d')!.drawImage(page, 0, top, page.width, h, 0, 0, page.width, h);
    const img = RawImage.fromCanvas(tile);
    const inputs = await processor(img, prompts);
    const ids = await model.generate({ ...inputs, max_new_tokens: 1024 });
    const text = processor.batch_decode(ids, { skip_special_tokens: false })[0];
    const result = processor.post_process_generation(text, TASK, img.size)[TASK];
    boxes = boxes.concat(
      result.labels.map((label, j) => {
        const b = quadToBox(label.replace(/<\/?s>/g, ''), result.quad_boxes[j]);
        return { ...b, y0: b.y0 + top, y1: b.y1 + top };
      }),
    );
    onProgress?.('read', { fraction: (i + 1) / tiles });
  }

  return boxesToLines(dedupeOverlap(boxes, overlap)).join('\n');
}
