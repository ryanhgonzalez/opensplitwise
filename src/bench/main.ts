/**
 * Receipt extraction bench. Dev-only page at /bench/receipts.html.
 *
 * Drop in receipt photos plus a labels.json with the right answers, choose
 * engines, and compare field accuracy, speed, download size and cost.
 */
import '../index.css';
import './bench.css';
import { CLAUDE_MODELS, ENGINES, getDeviceInfo, type ClaudeModel } from './engines';
import { scoreExtraction, summarize, type FieldScores } from './score';
import type { Engine, EngineRun, Label } from './types';

interface Cell {
  run?: EngineRun;
  error?: string;
  scores: FieldScores | null;
}

const state = {
  images: [] as File[],
  labels: {} as Record<string, Label>,
  selected: new Set<string>(['tesseract', 'florence2']),
  /** engineId → file name → result */
  results: {} as Record<string, Record<string, Cell>>,
  loadMs: {} as Record<string, number>,
  running: false,
  stop: false,
  status: '',
};

// ─── Tiny DOM helpers ─────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const secs = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const mark = (v: boolean | null) => (v === null ? '<span class="zero">·</span>' : v ? '<span class="pos">✓</span>' : '<span class="neg">✗</span>');

const root = document.getElementById('bench')!;

function costPerReceipt(engineId: string): string {
  const model = CLAUDE_MODELS[engineId as ClaudeModel];
  if (!model) return engineId === 'tesseract' ? '$0' : '$0 (on device)';
  const runs = Object.values(state.results[engineId] ?? {})
    .map((c) => c.run?.usage)
    .filter((u): u is NonNullable<typeof u> => !!u);
  if (!runs.length) return '—';
  const avg =
    runs.reduce((s, u) => s + (u.inputTokens * model.input + u.outputTokens * model.output) / 1e6, 0) / runs.length;
  return `$${avg < 0.01 ? avg.toFixed(4) : avg.toFixed(3)}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

async function render() {
  const device = await getDeviceInfo();
  const labelled = state.images.filter((f) => state.labels[f.name]).length;
  const engines = ENGINES.filter((e) => state.selected.has(e.id));

  const summaryRows = ENGINES.filter((e) => state.results[e.id])
    .map((e) => {
      const rows = state.images.map((f) => {
        const c = state.results[e.id]?.[f.name];
        return { scores: c?.scores ?? null, ms: c?.run?.ms ?? null };
      });
      const s = summarize(rows);
      return `<tr>
        <th scope="row">${esc(e.label)}</th>
        <td class="num">${pct(s.total)}</td>
        <td class="num">${pct(s.date)}</td>
        <td class="num">${pct(s.merchant)}</td>
        <td class="num">${s.itemsF1 === null ? '—' : s.itemsF1.toFixed(2)}</td>
        <td class="num">${secs(s.medianMs)}</td>
        <td class="num">${secs(state.loadMs[e.id])}</td>
        <td class="num">${costPerReceipt(e.id)}</td>
        <td class="num">${s.failures ? `<span class="neg">${s.failures}</span>` : '0'}</td>
      </tr>`;
    })
    .join('');

  const ranEngines = ENGINES.filter((e) => state.results[e.id]);
  const detailRows = state.images
    .map((f) => {
      const label = state.labels[f.name];
      const cells = ranEngines
        .map((e) => {
          const c = state.results[e.id]?.[f.name];
          if (!c) return '<td class="zero">…</td>';
          if (c.error) return `<td><span class="neg" title="${esc(c.error)}">error</span></td>`;
          const s = c.scores;
          const x = c.run!.extraction;
          return `<td>
            <details>
              <summary>${s ? `${mark(s.total)} ${mark(s.date)} ${mark(s.merchant)} <span class="num">${s.itemsF1 === null ? '' : s.itemsF1.toFixed(2)}</span>` : '<span class="zero">no label</span>'}</summary>
              <dl class="bench-got">
                <dt>Total</dt><dd class="num">${esc(x.total ?? '—')}</dd>
                <dt>Date</dt><dd class="num">${esc(x.date ?? '—')}</dd>
                <dt>Merchant</dt><dd>${esc(x.merchant ?? '—')}</dd>
                <dt>Items</dt><dd>${(x.items ?? []).map((i) => `${esc(i.description)} <span class="num">${esc(i.amount)}</span>`).join('<br>') || '—'}</dd>
              </dl>
              <pre class="bench-raw">${esc(c.run!.raw ?? '')}</pre>
            </details>
          </td>`;
        })
        .join('');
      return `<tr>
        <th scope="row"><span class="num">${esc(f.name)}</span>${label ? '' : ' <span class="zero">(unlabelled)</span>'}</th>
        ${cells}
      </tr>`;
    })
    .join('');

  root.innerHTML = `
    <header class="bench-head">
      <span class="cap">OpenSplitwise · dev tool</span>
      <h1>Receipt extraction bench</h1>
      <p class="text-secondary">
        Runs each receipt through each engine and scores it against your labels.
        WebGPU: <strong>${device.webgpu ? 'available' : 'not available (on-device models fall back to WASM and run much slower)'}</strong>${device.webgpu ? ` · fp16: <strong>${device.f16 ? 'yes' : 'no'}</strong>` : ''}.
      </p>
    </header>

    <section class="bench-section">
      <h2>1 · Receipts and labels</h2>
      <label class="bench-drop">
        <input type="file" id="files" multiple accept="image/*,application/json,.json" />
        <span><strong>Choose receipt photos and labels.json</strong> (or drop them here)</span>
      </label>
      <p class="text-secondary">
        <span class="num">${state.images.length}</span> photos ·
        <span class="num">${labelled}</span> labelled
        ${state.images.length ? ' · <button class="btn-link" id="template">Download a labels.json template for these photos</button>' : ''}
      </p>
    </section>

    <section class="bench-section">
      <h2>2 · Engines</h2>
      <div class="bench-engines">
        ${ENGINES.map(
          (e: Engine) => `<label class="bench-engine">
            <input type="checkbox" data-engine="${e.id}" ${state.selected.has(e.id) ? 'checked' : ''} ${state.running ? 'disabled' : ''} />
            <span><strong>${esc(e.label)}</strong><br /><span class="text-secondary text-xs">${esc(e.downloadNote)}</span></span>
          </label>`,
        ).join('')}
      </div>
      <div class="bench-actions">
        <button class="btn btn-primary" id="run" ${state.running || !state.images.length || !engines.length ? 'disabled' : ''}>
          Run ${engines.length} engine${engines.length === 1 ? '' : 's'} on ${state.images.length} receipt${state.images.length === 1 ? '' : 's'}
        </button>
        ${state.running ? '<button class="btn btn-secondary" id="stop">Stop after this receipt</button>' : ''}
        ${ranEngines.length ? '<button class="btn btn-secondary" id="export">Export results JSON</button>' : ''}
      </div>
      <p class="bench-status num" aria-live="polite">${esc(state.status)}</p>
    </section>

    ${summaryRows ? `
    <section class="bench-section">
      <h2>3 · Summary</h2>
      <div class="bench-scroll"><table class="bench-table">
        <thead><tr>
          <th>Engine</th><th>Total</th><th>Date</th><th>Merchant</th><th>Items F1</th>
          <th>Median / receipt</th><th>First load</th><th>Cost / receipt</th><th>Errors</th>
        </tr></thead>
        <tbody>${summaryRows}</tbody>
      </table></div>
      <p class="text-secondary text-xs">Percentages count only receipts whose label has that field. Items F1: 1.00 means every item found with the right price and nothing extra.</p>
    </section>

    <section class="bench-section">
      <h2>4 · Per receipt</h2>
      <p class="text-secondary text-xs">Marks are total · date · merchant, then items F1. Open a cell to see what the engine returned.</p>
      <div class="bench-scroll"><table class="bench-table bench-detail">
        <thead><tr><th>Receipt</th>${ranEngines.map((e) => `<th>${esc(e.label)}</th>`).join('')}</tr></thead>
        <tbody>${detailRows}</tbody>
      </table></div>
    </section>` : ''}
  `;
  wire();
}

// ─── Input handling ───────────────────────────────────────────────────────────

async function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (f.type === 'application/json' || f.name.endsWith('.json')) {
      try {
        Object.assign(state.labels, JSON.parse(await f.text()));
      } catch {
        state.status = `${f.name} is not valid JSON.`;
      }
    } else if (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)) {
      if (!state.images.some((x) => x.name === f.name)) state.images.push(f);
    }
  }
  state.images.sort((a, b) => a.name.localeCompare(b.name));
  render();
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

async function run() {
  state.running = true;
  state.stop = false;
  const engines = ENGINES.filter((e) => state.selected.has(e.id));
  for (const e of engines) {
    state.results[e.id] = {};
    if (e.load) {
      state.status = `${e.label}: loading…`;
      render();
      const t0 = performance.now();
      try {
        await e.load((msg) => {
          state.status = `${e.label}: ${msg}`;
          const el = document.querySelector('.bench-status');
          if (el) el.textContent = state.status;
        });
        state.loadMs[e.id] = performance.now() - t0;
      } catch (err) {
        for (const f of state.images) state.results[e.id][f.name] = { error: `Load failed: ${(err as Error).message}`, scores: null };
        continue;
      }
    }
    for (const [i, f] of state.images.entries()) {
      if (state.stop) break;
      state.status = `${e.label}: receipt ${i + 1} of ${state.images.length} (${f.name})`;
      render();
      try {
        const out = await e.run(f);
        const label = state.labels[f.name];
        state.results[e.id][f.name] = { run: out, scores: label ? scoreExtraction(out.extraction, label) : null };
      } catch (err) {
        state.results[e.id][f.name] = { error: (err as Error).message, scores: null };
      }
    }
    if (state.stop) break;
  }
  state.running = false;
  state.status = state.stop ? 'Stopped.' : 'Done.';
  render();
}

function wire() {
  const input = document.getElementById('files') as HTMLInputElement | null;
  input?.addEventListener('change', () => input.files && addFiles(input.files));

  const drop = document.querySelector('.bench-drop');
  drop?.addEventListener('dragover', (ev) => ev.preventDefault());
  drop?.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const files = (ev as DragEvent).dataTransfer?.files;
    if (files) addFiles(files);
  });

  document.getElementById('template')?.addEventListener('click', () => {
    const template = Object.fromEntries(
      state.images.map((f) => [
        f.name,
        state.labels[f.name] ?? { merchant: '', date: 'YYYY-MM-DD', total: 0, items: [{ description: '', amount: 0 }] },
      ]),
    );
    download('labels.json', template);
  });

  document.querySelectorAll<HTMLInputElement>('[data-engine]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(cb.dataset.engine!);
      else state.selected.delete(cb.dataset.engine!);
      render();
    }),
  );

  document.getElementById('run')?.addEventListener('click', () => void run());
  document.getElementById('stop')?.addEventListener('click', () => {
    state.stop = true;
  });
  document.getElementById('export')?.addEventListener('click', async () => {
    download(`receipt-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, {
      device: await getDeviceInfo(),
      userAgent: navigator.userAgent,
      loadMs: state.loadMs,
      labels: state.labels,
      results: state.results,
    });
  });
}

render();
