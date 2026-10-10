/* eslint-disable @typescript-eslint/no-explicit-any -- dev-only bench: the request body and the beta-only fallback fields are handled as loose JSON here. */
/**
 * Dev-only Claude proxy for the receipt bench.
 *
 * The browser can't hold an API key, so the bench posts the receipt image to
 * this Vite dev-server middleware, which calls Claude with structured outputs
 * and returns the parsed fields. It is registered only when the dev server is
 * started with BENCH_CLAUDE=1, and never exists in a production build.
 *
 * Credentials come from the usual SDK sources: ANTHROPIC_API_KEY, or an
 * `ant auth login` profile.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const MODELS = new Set(['claude-opus-5-5', 'claude-haiku-5-5']);

const SYSTEM = [
  'You extract expense details from a photo of a receipt.',
  'merchant: the business name as printed, without address or slogans.',
  'date: the transaction date as YYYY-MM-DD, or an empty string if none is legible.',
  'total: the final amount charged, including tax and tip. Use 0 only if no total is legible.',
  'items: each purchased line with its line price. Leave out subtotal, tax, tip, discounts, change and payment lines.',
  'Copy text as printed; do not guess values you cannot read.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    date: { type: 'string' },
    total: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, amount: { type: 'number' } },
        required: ['description', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['merchant', 'date', 'total', 'items'],
  additionalProperties: false,
};

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function benchClaudeProxy(): Plugin {
  return {
    name: 'bench-claude-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bench/claude', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const { model, mediaType, data } = await readJson(req);
          if (!MODELS.has(model)) return send(res, 400, { error: `Unsupported model ${model}` });

          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const client = new Anthropic();

          const content = [
            { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data } },
            { type: 'text' as const, text: 'Extract the expense details from this receipt.' },
          ];
          const common = {
            model,
            max_tokens: 16000,
            system: SYSTEM,
            output_config: { effort: 'medium' as const, format: { type: 'json_schema' as const, schema: SCHEMA } },
            messages: [{ role: 'user' as const, content }],
          };

          // Opus 5.5 gets the server-side refusal fallback; Haiku 5.5 has none.
          const message: any =
            model === 'claude-opus-5-5'
              ? await client.beta.messages.create({
                  ...common,
                  betas: ['server-side-fallback-2026-07-01'],
                  fallbacks: 'default',
                } as any)
              : await client.messages.create(common as any);

          if (message.stop_reason === 'refusal') {
            return send(res, 422, { error: `Refused (${message.stop_details?.category ?? 'no category'})` });
          }
          const text: string = message.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Reported back as raw text; the bench scores it as a failed extraction.
          }
          send(res, 200, {
            text,
            json,
            usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
            servedBy: message.model,
          });
        } catch (err) {
          const e = err as { status?: number; message?: string };
          send(res, e.status && e.status >= 400 ? e.status : 500, { error: e.message ?? String(err) });
        }
      });
    },
  };
}
