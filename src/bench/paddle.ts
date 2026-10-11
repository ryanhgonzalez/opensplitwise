/**
 * Other PaddleOCR model sets for the bench, run through the app's own OCR code
 * (src/lib/receiptOcr.ts) so only the models differ. The app ships PP-OCRv6
 * small, served from /ocr; these load straight from Hugging Face.
 */
import type { OcrModel } from '../lib/receiptOcr';

const HF = 'https://huggingface.co/PaddlePaddle';
const dict = (path: string) => () => fetch(path).then((r) => r.json() as Promise<string[]>);

export interface BenchOcrModel extends OcrModel {
  label: string;
  downloadNote: string;
}

export const PADDLE_MODELS: BenchOcrModel[] = [
  {
    id: 'paddle-v5-en',
    label: 'PaddleOCR v5 mobile (English) + app parser',
    downloadNote: '~13 MB + ORT wasm, CPU only',
    det: `${HF}/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx`,
    rec: `${HF}/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx`,
    dict: dict('/bench/ocr/pp-ocrv5-en-dict.json'),
    approxBytes: 27e6,
    thresh: 0.3,
    boxThresh: 0.6,
    unclipRatio: 1.5,
  },
  {
    id: 'paddle-v6-tiny',
    label: 'PaddleOCR v6 tiny + app parser',
    downloadNote: '~6 MB + ORT wasm, CPU only',
    det: `${HF}/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx`,
    rec: `${HF}/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.onnx`,
    dict: dict('/bench/ocr/pp-ocrv6-tiny-dict.json'),
    approxBytes: 20e6,
    thresh: 0.2,
    boxThresh: 0.4,
    unclipRatio: 1.4,
  },
];
