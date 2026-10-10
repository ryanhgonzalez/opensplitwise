/* eslint-disable @typescript-eslint/no-explicit-any -- dev-only bench: Transformers.js returns loosely typed model/processor objects whose shape varies per architecture. */
import { loadBetterScan, runtimeFor } from '../lib/betterScan';
import { parseReceiptText, scanReceipt, scanReceiptBetter } from '../lib/receiptScanner';
import { docTagsToLines, extractJson } from './lines';
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

// Device checks and weight choices are shared with the app's Better scan.
export { getDeviceInfo, type DeviceInfo } from '../lib/betterScan';

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

// ─── 2. Florence-2: better OCR, same parser (ships as the app's Better scan) ──

const mb = (n = 0) => Math.round(n / 1e6);

const florence2: Engine = {
  id: 'florence2',
  label: 'Florence-2 base + app parser',
  downloadNote: '~390 MB, cached after the first run',
  async load(onProgress) {
    await loadBetterScan((phase, p) =>
      onProgress(phase === 'download' ? `Downloading ${mb(p.loaded)} MB` : 'Loading model'),
    );
  },
  async run(image) {
    const t0 = now();
    const r = await scanReceiptBetter(image);
    return { ms: now() - t0, raw: r.rawText, extraction: fromText(r.rawText) };
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
