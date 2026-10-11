/**
 * Serves the receipt OCR models (PaddleOCR PP-OCRv6 small, Apache-2.0) at
 * /ocr, from our own origin.
 *
 * The files aren't in git (31 MB) or on npm. They're downloaded from Hugging
 * Face once, pinned to an exact commit and checked against their SHA-256, then
 * kept in node_modules/.cache. A changed or corrupted file fails the build
 * instead of shipping.
 *
 * File names carry the start of the checksum, so a model update gets a new URL
 * and can't be confused with the old one in the service worker's cache.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

interface ModelFile {
  /** Path under /ocr. */
  name: string
  url: string
  sha256: string
}

const HF = 'https://huggingface.co/PaddlePaddle'

export const OCR_FILES: ModelFile[] = [
  {
    name: 'det-d73e0058.onnx',
    url: `${HF}/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx`,
    sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e',
  },
  {
    name: 'rec-5435fd74.onnx',
    url: `${HF}/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx`,
    sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634',
  },
]

const CACHE_DIR = join(process.cwd(), 'node_modules/.cache/opensplitwise-ocr')

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Returns the file's bytes, downloading and verifying it on first use. */
async function ensure(file: ModelFile): Promise<Buffer> {
  const path = join(CACHE_DIR, file.name)
  if (existsSync(path)) {
    const data = readFileSync(path)
    if (sha256(data) === file.sha256) return data
  }
  const res = await fetch(file.url)
  if (!res.ok) throw new Error(`OCR model download failed: ${res.status} ${file.url}`)
  const data = Buffer.from(await res.arrayBuffer())
  const got = sha256(data)
  if (got !== file.sha256) throw new Error(`OCR model checksum mismatch for ${file.name}: ${got}`)
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(path, data)
  return data
}

export function ocrModels(): Plugin {
  return {
    name: 'ocr-models',
    configureServer(server) {
      server.middlewares.use('/ocr', (req, res, next) => {
        const file = OCR_FILES.find((f) => `/${f.name}` === (req.url ?? '').split('?')[0])
        if (!file) return next()
        ensure(file).then(
          (data) => {
            res.setHeader('content-type', 'application/octet-stream')
            res.end(data)
          },
          (err: Error) => next(err),
        )
      })
    },
    async generateBundle() {
      for (const file of OCR_FILES) {
        this.emitFile({ type: 'asset', fileName: `ocr/${file.name}`, source: await ensure(file) })
      }
    },
  }
}
