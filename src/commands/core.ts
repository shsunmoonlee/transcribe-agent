import { randomUUID } from 'crypto';
import { TranscribeAPI, handleFailure } from '../api';
import { EXIT, getConfig, printJson } from '../config';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function apiFor(argv: any): TranscribeAPI {
  return new TranscribeAPI(getConfig({ allowCustomHost: argv.allowCustomHost }));
}

function printRaw(rawText: string): void {
  process.stdout.write(rawText.endsWith('\n') ? rawText : rawText + '\n');
}

export interface SourceArgs {
  source: string;
  url?: string;
  uploadId?: string;
  duration?: number;
  language?: string;
  callbackUrl?: string;
}

function buildCreateBody(argv: SourceArgs): Record<string, unknown> {
  const body: Record<string, unknown> = { source: argv.source };
  if (argv.url !== undefined) body.url = argv.url;
  if (argv.uploadId !== undefined) body.upload_id = argv.uploadId;
  if (argv.duration !== undefined) body.duration_seconds = argv.duration;
  if (argv.language !== undefined) body.language = argv.language;
  if (argv.callbackUrl !== undefined) body.callback_url = argv.callbackUrl;
  return body;
}

export async function authStatus(argv: any): Promise<void> {
  const config = getConfig({ allowCustomHost: argv.allowCustomHost });
  const api = new TranscribeAPI(config);
  try {
    const res = await api.request('/me');
    printJson({
      authenticated: true,
      api_url: config.apiUrl,
      email: res.json?.email ?? null,
      subscription_tier: res.json?.subscription_tier ?? null,
      wallet_balance_usd: res.json?.wallet_balance_usd ?? null,
      api_key: res.json?.api_key ?? null,
    });
  } catch (err) {
    handleFailure(err);
  }
}

export async function me(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request('/me');
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function pipelines(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request('/pipelines');
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function quote(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request('/quotes', {
      method: 'POST',
      body: buildCreateBody(argv),
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function create(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request('/transcriptions', {
      method: 'POST',
      body: buildCreateBody(argv),
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

// Shared long-poll loop over the server's /wait endpoint (45 s windows,
// under Cloudflare's 120 s limit). Never hand-rolls short polling.
export async function waitLoop(
  api: TranscribeAPI,
  id: number,
  opts: { timeoutSec: number; include?: string }
): Promise<{ body: any; rawText: string; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let last: { body: any; rawText: string } | null = null;

  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      return { body: last?.body ?? null, rawText: last?.rawText ?? 'null', timedOut: true };
    }
    const window = Math.min(45, Math.max(1, remaining));
    const res = await api.request(`/transcriptions/${id}/wait`, {
      query: { timeout: window, include: opts.include },
    });
    last = { body: res.json, rawText: res.rawText };
    const status = res.json?.status;
    if (TERMINAL_STATUSES.has(status)) {
      return { body: res.json, rawText: res.rawText, timedOut: false };
    }
    if (status === 'queued' || status === 'quoted') {
      // Concurrency cap: the job waits FIFO for a free slot. Expected
      // state, not an error; never re-create the job.
      process.stderr.write('waiting for a concurrency slot\n');
    } else {
      const stage = res.json?.stage ?? '?';
      const progress = res.json?.progress ?? 0;
      process.stderr.write(`status=${status} stage=${stage} progress=${progress}%\n`);
    }
  }
}

export async function wait(argv: any): Promise<void> {
  const api = apiFor(argv);
  try {
    const result = await waitLoop(api, argv.id, {
      timeoutSec: argv.timeout,
      include: argv.include,
    });
    printRaw(result.rawText);
    if (result.timedOut) {
      process.stderr.write(`wait timed out after ${argv.timeout}s (job still running)\n`);
      process.exit(EXIT.TRANSIENT);
    }
    if (result.body?.status !== 'completed') {
      process.stderr.write(`transcription ended with status=${result.body?.status}\n`);
      process.exit(EXIT.ERROR);
    }
  } catch (err) {
    handleFailure(err);
  }
}

export async function result(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/result`, {
      query: { include: argv.include },
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

// quote -> enforce --max-usd -> create -> wait -> result.
// Uses ONLY the create 202 `id` for wait/result (the quote's
// transcription_id is a different row and must never be polled).
export async function run(argv: any): Promise<void> {
  const api = apiFor(argv);
  try {
    const body = buildCreateBody(argv);
    const quoteRes = await api.request('/quotes', {
      method: 'POST',
      body,
      idempotencyKey: randomUUID(),
    });
    const retailUsd = Number(quoteRes.json?.retail_usd);
    const billedMinutes = quoteRes.json?.billed_minutes;
    process.stderr.write(`quote: $${retailUsd.toFixed(2)} for ${billedMinutes} billed minute(s)\n`);

    if (!Number.isFinite(retailUsd) || retailUsd > argv.maxUsd) {
      printJson({
        error: {
          code: 'max_usd_exceeded',
          message: `Quoted price $${retailUsd} exceeds --max-usd ${argv.maxUsd}. Re-run with a higher --max-usd to proceed (this is a local budget refusal, not a balance problem; do not top up).`,
          quote: quoteRes.json,
        },
      });
      process.stderr.write(
        `Refusing to create: quoted $${retailUsd} > --max-usd ${argv.maxUsd}\n`
      );
      process.exit(EXIT.BUDGET);
    }

    const createRes = await api.request('/transcriptions', {
      method: 'POST',
      body,
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    const id = createRes.json?.id;
    process.stderr.write(
      `created transcription ${id} (held $${createRes.json?.retail_usd})\n`
    );

    const waited = await waitLoop(api, id, { timeoutSec: argv.timeout });
    if (waited.timedOut) {
      printRaw(waited.rawText);
      process.stderr.write(
        `wait timed out after ${argv.timeout}s; resume with: transcribe-so wait ${id}\n`
      );
      process.exit(EXIT.TRANSIENT);
    }
    if (waited.body?.status !== 'completed') {
      printRaw(waited.rawText);
      process.stderr.write(`transcription ${id} ended with status=${waited.body?.status}\n`);
      process.exit(EXIT.ERROR);
    }

    const resultRes = await api.request(`/transcriptions/${id}/result`, {
      query: { include: argv.include },
    });
    printRaw(resultRes.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function list(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request('/transcriptions', {
      query: {
        limit: argv.limit,
        cursor: argv.cursor,
        api_only: argv.apiOnly ? true : undefined,
      },
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function get(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}`);
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function deleteTranscription(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}`, {
      method: 'DELETE',
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

export async function retry(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/retry`, {
      method: 'POST',
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}
