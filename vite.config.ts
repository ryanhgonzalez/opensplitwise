/// <reference types="vitest/config" />
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dropUnusedOrtWasm, ...benchPlugins],
  test: {
    // Node, not jsdom: everything under test is pure calculation or store logic.
    // The only browser API the store touches is localStorage, which the setup
    // file stubs — cheaper and faster than pulling in a DOM implementation.
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
