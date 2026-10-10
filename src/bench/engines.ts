/* eslint-disable @typescript-eslint/no-explicit-any -- dev-only bench: Transformers.js returns loosely typed model/processor objects whose shape varies per architecture. */
import { parseReceiptText, scanReceipt } from '../lib/receiptScanner';
import { boxesToLines, dedupeOverlap, docTagsToLines, extractJson, quadToBox, type Box } from './lines';
import type { Engine, Extraction, ReceiptItem } from './types';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The app's own parser, applied to text from any OCR-style engine. */
function fromText(text: string): Extraction {
  const p = parseReceiptText(text);
  return {
    merchant: p.description,
    date: p.date ? isoDay(p.date) : undefined,
    total: p.amount,
    items: p.lineItems?.map((li) => ({ description: li.description, amount: li.amount })),
  };
}

/** Coerces a model's JSON reply into an Extraction, dropping anything malformed. */
function fromJson(value: unknown): Extraction {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => {
    const n = typeof x === 'string' ? parseFloat(x.replace(/[^0-9.-]/g, '')) : typeof x === 'number' ? x : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const items: ReceiptItem[] = Array.isArray(v.items)
    ? v.items.flatMap((it) => {
        if (!it || typeof it !== 'object') return [];
        const r = it as Record<string, unknown>;
        const amount = num(r.amount);
        return typeof r.description === 'string' && amount !== undefined ? [{ description: r.description, amount }] : [];
      })
    : [];
  const date = typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : undefined;
  return {
    merchant: typeof v.merchant === 'string' && v.merchant.trim() ? v.merchant.trim() : undefined,
    date,
    total: num(v.total),
    items,
  };
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** Scales an image so its long edge is at most `maxEdge`, returned as a canvas. */
function scaledCanvas(img: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

const now = () => performance.now();

// ─── Runtime selection for the on-device models ──────────────────────────────

type Transformers = typeof import('@huggingface/transformers');
let tf: Promise<Transformers> | null = null;
const transformers = () => (tf ??= import('@huggingface/transformers'));

export interface DeviceInfo {
  webgpu: boolean;
  /** WebGPU adapter supports 16-bit floats, which the fp16 model files need. */
  f16: boolean;
}

let deviceInfo: Promise<DeviceInfo> | null = null;
export function getDeviceInfo(): Promise<DeviceInfo> {
  deviceInfo ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } }).gpu;
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
 * Smallest sensible weights per component. WebGPU: 4-bit decoders, fp16 vision
 * where the GPU supports it. WASM fallback: 8-bit everything (slow, but runs).
 */
async function runtimeFor(components: string[], decoder: 'q4' | 'fp16' = 'q4') {
  const { webgpu, f16 } = await getDeviceInfo();
  if (!webgpu) return { device: 'wasm' as const, dtype: 'q8' as const };
  const dtype: Record<string, 'fp16' | 'q4' | 'fp32'> = {};
  for (const c of components) {
    const isDecoder = c.startsWith('decoder') || c === 'encoder_model';
    dtype[c] = isDecoder ? (decoder === 'fp16' && !f16 ? 'fp32' : decoder) : f16 ? 'fp16' : 'q4';
  }
  return { device: 'webgpu' as const, dtype };
}

const progressText = (p: { status?: string; file?: string; progress?: number }) =>
  p.status === 'progress' && p.file
    ? `Downloading ${p.file.split('/').pop()} ${Math.round(p.progress ?? 0)}%`
    : p.status ?? '';

// ─── 1. Tesseract (what the app ships today) ─────────────────────────────────

const tesseract: Engine = {
  id: 'tesseract',
  label: 'Tesseract (current)',
  downloadNote: '~15 MB, fetched from a CDN on first scan',
  async run(image) {
    const t0 = now();
    const r = await scanReceipt(image);
    return {
      ms: now() - t0,
      raw: r.rawText,
      extraction: {
        merchant: r.description,
        date: r.date ? isoDay(r.date) : undefined,
        total: r.amount,
        items: r.lineItems?.map((li) => ({ description: li.description, amount: li.amount })),
      },
    };
  },
};

// ─── 2. Florence-2: better OCR, same parser ──────────────────────────────────

const FLORENCE_ID = 'onnx-community/Florence-2-base-ft';
let florence: Promise<{ model: any; processor: any }> | null = null;

const florence2: Engine = {
  id: 'florence2',
  label: 'Florence-2 base + app parser',
  downloadNote: '~150–200 MB, cached after the first run',
  async load(onProgress) {
    florence ??= (async () => {
      const t = await transformers();
      const rt = await runtimeFor(['embed_tokens', 'vision_encoder', 'encoder_model', 'decoder_model_merged']);
      const opts = { ...rt, progress_callback: (p: any) => onProgress(progressText(p)) };
      const [model, processor] = await Promise.all([
        t.Florence2ForConditionalGeneration.from_pretrained(FLORENCE_ID, opts as any),
        t.AutoProcessor.from_pretrained(FLORENCE_ID, { progress_callback: opts.progress_callback } as any),
      ]);
      return { model, processor };
    })();
    await florence;
  },
  async run(image) {
    const { model, processor } = await florence!;
    const t = await transformers();
    const t0 = now();

    // Florence squashes every input to 768×768, which makes a long receipt
    // illegible. Cut it into roughly square, overlapping tiles instead.
    const bmp = await loadBitmap(image);
    const page = scaledCanvas(bmp, 1600);
    const tileH = Math.max(page.width, 400);
    const overlap = Math.round(tileH * 0.12);
    const task = '<OCR_WITH_REGION>';
    const prompts = processor.construct_prompts(task);
    let boxes: Box[] = [];
    const rawParts: string[] = [];

    for (let top = 0; top < page.height; top += tileH - overlap) {
      const h = Math.min(tileH, page.height - top);
      const tile = document.createElement('canvas');
      tile.width = page.width;
      tile.height = h;
      tile.getContext('2d')!.drawImage(page, 0, top, page.width, h, 0, 0, page.width, h);
      const img = t.RawImage.fromCanvas(tile);
      const inputs = await processor(img, prompts);
      const ids = await model.generate({ ...inputs, max_new_tokens: 1024 });
      const text = processor.batch_decode(ids, { skip_special_tokens: false })[0];
      const result = processor.post_process_generation(text, task, img.size)[task] as {
        quad_boxes: number[][];
        labels: string[];
      };
      rawParts.push(result.labels.join('\n'));
      boxes = boxes.concat(
        result.labels.map((label, i) => {
          const b = quadToBox(label.replace(/<\/?s>/g, ''), result.quad_boxes[i]);
          return { ...b, y0: b.y0 + top, y1: b.y1 + top };
        }),
      );
      if (top + h >= page.height) break;
    }

    const lines = boxesToLines(dedupeOverlap(boxes, overlap));
    return { ms: now() - t0, raw: lines.join('\n') || rawParts.join('\n---\n'), extraction: fromText(lines.join('\n')) };
  },
};

// ─── 3. Granite-Docling: document structure, same parser ─────────────────────

const DOCLING_ID = 'onnx-community/granite-docling-258M-ONNX';
let docling: Promise<{ model: any; processor: any }> | null = null;

const graniteDocling: Engine = {
  id: 'docling',
  label: 'Granite-Docling 258M + app parser',
  downloadNote: '~205 MB. Produced garbage on WebGPU in testing (see engines.ts)',
  async load(onProgress) {
    docling ??= (async () => {
      const t = await transformers();
      // Tested on Chromium + WebGPU (Oct 2026): the 4-bit decoder emits token
      // soup and the fp16 one overflows to "!!!!". Only fp32 (~650 MB) would be
      // left to try, which is too big for a phone, so this stays at 4-bit.
      const rt = await runtimeFor(['embed_tokens', 'vision_encoder', 'decoder_model_merged']);
      const cb = (p: any) => onProgress(progressText(p));
      const [model, processor] = await Promise.all([
        t.AutoModelForVision2Seq.from_pretrained(DOCLING_ID, { ...rt, progress_callback: cb } as any),
        t.AutoProcessor.from_pretrained(DOCLING_ID, { progress_callback: cb } as any),
      ]);
      return { model, processor };
    })();
    await docling;
  },
  async run(image) {
    const { model, processor } = await docling!;
    const t = await transformers();
    const t0 = now();
    const img = t.RawImage.fromCanvas(scaledCanvas(await loadBitmap(image), 2048));
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Convert this page to docling.' }] }];
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [img], { do_image_splitting: true });
    const out = await model.generate({ ...inputs, max_new_tokens: 2048 });
    const promptLen = inputs.input_ids.dims.at(-1);
    const doctags = processor.batch_decode(out.slice(null, [promptLen, null]), { skip_special_tokens: true })[0];
    const lines = docTagsToLines(doctags);
    return { ms: now() - t0, raw: doctags, extraction: fromText(lines.join('\n')) };
  },
};

// ─── 4. SmolVLM: ask for the fields directly ─────────────────────────────────

const SMOL_ID = 'HuggingFaceTB/SmolVLM-500M-Instruct';
let smol: Promise<{ model: any; processor: any }> | null = null;

const EXTRACT_PROMPT =
  'Read this receipt. Reply with only JSON in this shape: ' +
  '{"merchant": string, "date": "YYYY-MM-DD", "total": number, "items": [{"description": string, "amount": number}]}. ' +
  'Use the grand total actually charged. Leave out tax, tip, subtotal and payment lines from items.';

const smolvlm: Engine = {
  id: 'smolvlm',
  label: 'SmolVLM 500M (direct JSON)',
  downloadNote: '~310 MB, cached after the first run',
  async load(onProgress) {
    smol ??= (async () => {
      const t = await transformers();
      const rt = await runtimeFor(['embed_tokens', 'vision_encoder', 'decoder_model_merged']);
      const cb = (p: any) => onProgress(progressText(p));
      const [model, processor] = await Promise.all([
        t.AutoModelForVision2Seq.from_pretrained(SMOL_ID, { ...rt, progress_callback: cb } as any),
        t.AutoProcessor.from_pretrained(SMOL_ID, { progress_callback: cb } as any),
      ]);
      return { model, processor };
    })();
    await smol;
  },
  async run(image) {
    const { model, processor } = await smol!;
    const t = await transformers();
    const t0 = now();
    const img = t.RawImage.fromCanvas(scaledCanvas(await loadBitmap(image), 1536));
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: EXTRACT_PROMPT }] }];
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [img]);
    const out = await model.generate({ ...inputs, max_new_tokens: 768, do_sample: false });
    const promptLen = inputs.input_ids.dims.at(-1);
    const reply = processor.batch_decode(out.slice(null, [promptLen, null]), { skip_special_tokens: true })[0];
    return { ms: now() - t0, raw: reply, extraction: fromJson(extractJson(reply)) };
  },
};

// ─── 5. Claude, through the dev server's local proxy ─────────────────────────

/** First-party API prices, USD per million tokens. */
export const CLAUDE_MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20 },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5 },
} as const;
export type ClaudeModel = keyof typeof CLAUDE_MODELS;

async function toJpegBase64(file: File): Promise<string> {
  // The API downsizes anything with a long edge over ~1568 px anyway.
  const canvas = scaledCanvas(await loadBitmap(file), 1568);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.88),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function claudeEngine(model: ClaudeModel): Engine {
  return {
    id: model,
    label: CLAUDE_MODELS[model].label,
    downloadNote: 'Cloud. Needs the dev server started with BENCH_CLAUDE=1',
    async run(image) {
      const data = await toJpegBase64(image);
      const t0 = now();
      const res = await fetch('/__bench/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, mediaType: 'image/jpeg', data }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return {
        ms: now() - t0,
        raw: body.text,
        extraction: fromJson(body.json),
        usage: body.usage,
      };
    },
  };
}

export const ENGINES: Engine[] = [
  tesseract,
  florence2,
  graniteDocling,
  smolvlm,
  claudeEngine('claude-opus-5-5'),
  claudeEngine('claude-haiku-5-5'),
];
