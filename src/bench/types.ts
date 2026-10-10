/**
 * Receipt-extraction bench: shared shapes.
 *
 * Dev-only. Nothing under src/bench is imported by the app, so none of it
 * (or the model runtimes it pulls in) reaches the production bundle.
 */

export interface ReceiptItem {
  description: string;
  amount: number;
}

/** What an engine pulled out of a receipt, or the hand-checked truth for one. */
export interface Extraction {
  merchant?: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date?: string;
  total?: number;
  items?: ReceiptItem[];
}

/** The correct answer for one receipt image, keyed in labels.json by file name. */
export type Label = Extraction;

export interface EngineRun {
  extraction: Extraction;
  /** Time spent on this receipt only, excluding model download and setup. */
  ms: number;
  /** Raw model output, for eyeballing failures. */
  raw?: string;
  /** Claude only: tokens billed for this receipt. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Engine {
  id: string;
  label: string;
  /** Approximate one-time download, shown before running. */
  downloadNote: string;
  /** One-time setup (model download, compile). Resolved once and reused. */
  load?: (onProgress: (msg: string) => void) => Promise<void>;
  run: (image: File) => Promise<EngineRun>;
}
