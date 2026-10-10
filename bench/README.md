# Receipt extraction bench

A development-only page for comparing ways of reading receipts before changing
the app's scanner. It is not part of the production build: only `/index.html`
is bundled, and nothing in the app imports `src/bench`.

Engines compared:

| Engine | Runs | One-time download | How it extracts |
|---|---|---|---|
| Tesseract (current) | On device | ~15 MB from a CDN | OCR text → the app's `parseReceiptText` |
| Florence-2 base | On device (WebGPU, else WASM) | ~390 MB, cached | OCR with line positions, tiled for long receipts → `parseReceiptText`. Ships in the app as Better scan (`src/lib/betterScan.ts`) |
| Granite-Docling 258M | On device | ~205 MB, cached | Document structure (tables) → `parseReceiptText` |
| SmolVLM 500M | On device | ~310 MB, cached | Asked for the fields as JSON |
| Claude Opus 5.5 / Haiku 5.5 | Cloud, via a local proxy | none | Structured output (JSON schema) |

The first three share the app's parser, so differences come from how well the
text was read. SmolVLM and Claude replace the parser entirely.

## 1. Collect and label receipts

Aim for 20–30 real photos, including the hard ones: faded thermal paper,
crumpled, long, shot at an angle, in poor light, other languages and currencies.

Open the page, choose the photos, then click **Download a labels.json template**.
Fill in each receipt's correct values:

```json
{
  "IMG_1042.jpg": {
    "merchant": "Pingo Doce",
    "date": "2026-09-15",
    "total": 14.2,
    "items": [
      { "description": "Leite Mimosa 1L", "amount": 1.29 },
      { "description": "Pao de Forma", "amount": 0.89 }
    ]
  }
}
```

Leave a field out and it simply isn't scored for that receipt. Items are the
slowest to label; labelling them on even half the set is useful.

Keep real receipt photos and labels **out of the repository**: they hold card
digits, locations and spending. `bench/data/` is git-ignored for exactly this,
so keep them there.

## 2. Run it

On this computer:

```bash
npm run dev
# open http://localhost:5173/bench/receipts.html
```

On a phone (the number that matters): WebGPU requires HTTPS, so start the dev
server with a self-signed certificate and open it over your local network.

```bash
BENCH_HTTPS=1 npm run dev -- --host
# open https://<your-computer's-LAN-IP>:5173/bench/receipts.html on the phone
# and accept the certificate warning
```

Run each on-device model once to download it, then run again: the summary's
*First load* column shows the cold cost, and *Median / receipt* the warm speed.

## 3. Including Claude

Claude can't be called from the browser without exposing an API key, so the
dev server proxies it. Enable the proxy explicitly:

```bash
BENCH_CLAUDE=1 npm run dev
```

Credentials come from `ANTHROPIC_API_KEY` or an `ant auth login` profile. Each
receipt is one request; the summary shows the average cost per receipt from the
tokens actually billed. Opus 5.5 requests use the server-side refusal fallback.

Do not combine `BENCH_CLAUDE=1` with `--host` on a network you don't trust: the
proxy would let anyone who can reach the dev server spend on your key.

## 4. Reading the results

- **Total / Date / Merchant**: share of labelled receipts where the field was right.
- **Items F1**: 1.00 means every item was found with the right price and nothing extra.
- **Median / receipt**: warm time per receipt. **First load**: download plus setup.
- **Cost / receipt**: Claude only, from billed tokens.

**Export results JSON** saves everything, including each engine's raw output,
for comparing devices or runs later.
