/// <reference types="vitest/config" />
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { benchClaudeProxy } from './bench/claudeProxy'

// Receipt bench switches (dev server only; see bench/README.md):
//   BENCH_HTTPS=1  self-signed HTTPS, so a phone on the LAN gets WebGPU
//   BENCH_CLAUDE=1 enables the local Claude proxy at /__bench/claude
const benchPlugins: PluginOption[] = [
  process.env.BENCH_HTTPS === '1' && basicSsl(),
  process.env.BENCH_CLAUDE === '1' && benchClaudeProxy(),
]

// Better scan's Transformers.js loads the ONNX Runtime wasm from jsDelivr at
// runtime, but Vite still emits onnxruntime-web's own 27 MB copy, which nothing
// fetches and which is over Cloudflare Pages' 25 MiB per-file limit.
const dropUnusedOrtWasm: PluginOption = {
  name: 'drop-unused-ort-wasm',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name]
    }
  },
}

// Tesseract fetches its worker, WASM core and English data from jsDelivr by
// default, so the standard receipt scan needed a connection. Serve copies at
// /tesseract instead, taken from node_modules so they always match the
// installed tesseract.js; the service worker precaches them.
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
const TESSERACT_FILES: Record<string, string> = {
  'worker.min.js': join(pkgDir('tesseract.js'), 'dist/worker.min.js'),
  'tesseract-core-simd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'),
  // Only for browsers without WebAssembly SIMD (pre-2021); not precached.
  'tesseract-core-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'),
  'eng.traineddata.gz': join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz'),
}

const tesseractAssets: PluginOption = {
  name: 'tesseract-assets',
  configureServer(server) {
    server.middlewares.use('/tesseract', (req, res, next) => {
      const file = TESSERACT_FILES[(req.url ?? '').replace(/^\//, '').split('?')[0]]
      if (!file) return next()
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
      res.end(readFileSync(file))
    })
  },
  generateBundle() {
    for (const [name, file] of Object.entries(TESSERACT_FILES)) {
      this.emitFile({ type: 'asset', fileName: `tesseract/${name}`, source: readFileSync(file) })
    }
  },
}

// Offline support: the service worker precaches everything the app can load
// (the shell, lazy PDF/OCR/Better scan chunks, fonts, Tesseract files), so once
// the app has been opened online it works with no connection. Better scan's
// ~390 MB model isn't precached; the browser keeps it after its first use.
const pwa = VitePWA({
  // 'prompt': a new version waits instead of reloading the page mid-use;
  // src/lib/serviceWorker.ts decides when to switch over.
  registerType: 'prompt',
  injectRegister: false,
  // public/manifest.webmanifest is hand-written and linked from index.html.
  manifest: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2,ttf}', 'tesseract/*'],
    globIgnores: ['tesseract/tesseract-core-lstm.wasm.js'],
    // The Tesseract core is ~3.9 MB, above Workbox's 2 MiB default.
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    navigateFallback: '/index.html',
    cleanupOutdatedCaches: true,
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dropUnusedOrtWasm, tesseractAssets, pwa, ...benchPlugins],
  test: {
    // Node, not jsdom: everything under test is pure calculation or store logic.
    // The only browser API the store touches is localStorage, which the setup
    // file stubs — cheaper and faster than pulling in a DOM implementation.
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
