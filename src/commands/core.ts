import { randomUUID } from 'crypto';
import { TranscribeAPI, handleFailure } from '../api';
import {
  CAPTION_DESTINATIONS,
  CAPTION_DESTINATION_NAMES,
  CAPTION_VARIANTS,
  RESULT_INCLUDE_SECTIONS,
  SOURCES,
  SUBTITLE_FORMATS,
  SUBTITLE_MODES,
  SUBTITLE_PRESETS,
  SUBTITLE_SOURCES,
  TRANSCRIPT_FORMATS,
} from '../catalog';
import { EXIT, getConfig, printJson } from '../config';
import { CLI_VERSION } from '../version';
import { CONTENT_TYPE_ALLOWLIST } from './upload';

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
  maxChargeUsd?: number;
}

// `withCeiling` is false for /quotes: a quote never charges, so a ceiling
// there would only risk a refusal on the one call that is free and whose
// whole job is to tell you the price.
export function buildCreateBody(
  argv: SourceArgs,
  withCeiling = false
): Record<string, unknown> {
  const body: Record<string, unknown> = { source: argv.source };
  if (argv.url !== undefined) body.url = argv.url;
  if (argv.uploadId !== undefined) body.upload_id = argv.uploadId;
  if (argv.duration !== undefined) body.duration_seconds = argv.duration;
  if (argv.language !== undefined) body.language = argv.language;
  if (argv.callbackUrl !== undefined) body.callback_url = argv.callbackUrl;
  if (withCeiling && argv.maxChargeUsd !== undefined)
    body.max_charge_usd = argv.maxChargeUsd;
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
      body: buildCreateBody(argv, true),
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
  opts: {
    timeoutSec: number;
    include?: string;
    segmentsOffset?: number;
    segmentsLimit?: number;
  }
): Promise<{ body: any; rawText: string; timedOut: boolean; notAJob?: boolean }> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let last: { body: any; rawText: string } | null = null;
  let quotedPolls = 0;

  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      return { body: last?.body ?? null, rawText: last?.rawText ?? 'null', timedOut: true };
    }
    const window = Math.min(45, Math.max(1, remaining));
    const res = await api.request(`/transcriptions/${id}/wait`, {
      query: {
        timeout: window,
        include: opts.include,
        segments_offset: opts.segmentsOffset,
        segments_limit: opts.segmentsLimit,
      },
    });
    last = { body: res.json, rawText: res.rawText };
    const status = res.json?.status;
    if (TERMINAL_STATUSES.has(status)) {
      return { body: res.json, rawText: res.rawText, timedOut: false };
    }
    if (status === 'quoted') {
      // The wire reports concurrency-queued jobs as "queued"; a row that
      // shows "quoted" is a quote that was never started (createQuote's
      // transcription_id, not a create 202 id). It will never progress.
      quotedPolls++;
      process.stderr.write(
        'this id looks like a quote, not a job; only the create 202 id is pollable\n'
      );
      if (quotedPolls >= 2) {
        return { body: res.json, rawText: res.rawText, timedOut: false, notAJob: true };
      }
    } else if (status === 'queued') {
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
      segmentsOffset: argv.segmentsOffset,
      segmentsLimit: argv.segmentsLimit,
    });
    printRaw(result.rawText);
    noteSegmentsWindow(result.body, argv.id);
    if (result.notAJob) {
      process.stderr.write(
        `id ${argv.id} is a quote row (status=quoted), not a started job; pass the id from the create 202 response\n`
      );
      process.exit(EXIT.ERROR);
    }
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

// `segments_meta` is the difference between a complete transcript and a
// windowed one. Silently handing back a truncated transcript is the failure
// mode this note exists to prevent.
export function noteSegmentsWindow(body: any, id: number | string): void {
  const meta = body?.segments_meta;
  if (!meta) return;
  process.stderr.write(
    `segments window: offset=${meta.offset} limit=${meta.limit} of ${meta.total} total, has_more=${meta.has_more}\n`
  );
  if (meta.has_more) {
    process.stderr.write(
      `this is a PARTIAL transcript; continue with --segments-offset ${meta.offset + meta.limit}, ` +
        `or get the whole thing as text with: transcribe-so transcript ${id}\n`
    );
  }
}

export async function result(argv: any): Promise<void> {
  try {
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/result`, {
      query: {
        include: argv.include,
        segments_offset: argv.segmentsOffset,
        segments_limit: argv.segmentsLimit,
      },
    });
    printRaw(res.rawText);
    noteSegmentsWindow(res.json, argv.id);
  } catch (err) {
    handleFailure(err);
  }
}

// quote -> enforce --max-usd -> create -> wait -> result.
// Uses ONLY the create 202 `id` for wait/result (the quote's
// transcription_id is a different row and must never be polled).
// `run` already has a local budget (`--max-usd`, enforced before the create
// call). The server-side ceiling closes the gap the local check cannot: the
// charge is recomputed at the wallet hold, and plan coverage or a probed
// duration can move it between the quote and the hold. So by default the
// local budget IS sent as `max_charge_usd` too. An explicit
// `--max-charge-usd` wins; `--no-server-ceiling` opts out entirely.
export function resolveRunCeiling(argv: {
  maxUsd: number;
  maxChargeUsd?: number;
  serverCeiling?: boolean;
}): number | undefined {
  if (argv.serverCeiling === false) return undefined;
  if (argv.maxChargeUsd !== undefined) return argv.maxChargeUsd;
  return argv.maxUsd;
}

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

    // Belt and suspenders on top of the yargs .check(): a non-finite budget
    // must never let `retailUsd > maxUsd` evaluate false and slip through.
    if (
      !Number.isFinite(argv.maxUsd) ||
      !Number.isFinite(retailUsd) ||
      retailUsd > argv.maxUsd
    ) {
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

    const ceiling = resolveRunCeiling(argv);
    const createBody =
      ceiling === undefined ? body : { ...body, max_charge_usd: ceiling };
    if (ceiling !== undefined) {
      process.stderr.write(`server-side charge ceiling: $${ceiling}\n`);
    }
    const createRes = await api.request('/transcriptions', {
      method: 'POST',
      body: createBody,
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    const id = createRes.json?.id;
    process.stderr.write(
      `created transcription ${id} (held $${createRes.json?.retail_usd})\n`
    );

    const waited = await waitLoop(api, id, { timeoutSec: argv.timeout });
    if (waited.notAJob) {
      // Should be unreachable: run always polls the create 202 id.
      printRaw(waited.rawText);
      process.stderr.write(`transcription ${id} unexpectedly reports status=quoted\n`);
      process.exit(EXIT.ERROR);
    }
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
    noteSegmentsWindow(resultRes.json, id);
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
    // A retry is a NEW paid attempt with its own hold: the create call's
    // ceiling does not carry over, so it has to be sent again here.
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/retry`, {
      method: 'POST',
      body:
        argv.maxChargeUsd !== undefined
          ? { max_charge_usd: argv.maxChargeUsd }
          : undefined,
      idempotencyKey: argv.idempotencyKey ?? randomUUID(),
    });
    printRaw(res.rawText);
  } catch (err) {
    handleFailure(err);
  }
}

// One JSON object describing what this account and this CLI can do: the live
// /me and /pipelines bodies, plus the CLI's own enums (every one of them a
// real wire enum, not a schema language). Answers "what can I ask for?" in a
// single call so an agent does not guess flag values.
export async function capabilities(argv: any): Promise<void> {
  const api = apiFor(argv);
  try {
    const [meRes, pipelinesRes] = await Promise.all([
      api.request('/me'),
      api.request('/pipelines'),
    ]);

    // Unauthenticated and cheap; the spec is public. A failure here must not
    // fail the command - the version is a nicety, the enums are the payload.
    let apiVersion: string | null = null;
    try {
      const specRes = await fetch(`${api.baseUrl}/openapi.json`, {
        headers: { Accept: 'application/json' },
      });
      if (specRes.ok) {
        const spec: any = await specRes.json();
        apiVersion = spec?.info?.version ?? null;
      }
    } catch {
      apiVersion = null;
    }

    printJson({
      cli_version: CLI_VERSION,
      api_url: api.baseUrl,
      api_version: apiVersion,
      account: meRes.json,
      pipelines: pipelinesRes.json?.pipelines ?? pipelinesRes.json,
      formats: {
        sources: SOURCES,
        result_include: RESULT_INCLUDE_SECTIONS,
        transcript_formats: TRANSCRIPT_FORMATS,
        subtitles: {
          formats: SUBTITLE_FORMATS,
          presets: SUBTITLE_PRESETS,
          modes: SUBTITLE_MODES,
          sources: SUBTITLE_SOURCES,
        },
        captions: {
          destinations: CAPTION_DESTINATION_NAMES,
          destination_to_api_format: CAPTION_DESTINATIONS,
          variants: CAPTION_VARIANTS,
        },
        upload_content_types: CONTENT_TYPE_ALLOWLIST,
      },
      exit_codes: EXIT,
    });
  } catch (err) {
    handleFailure(err);
  }
}
