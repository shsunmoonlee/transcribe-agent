import { writeFileSync } from 'fs';
import { ApiError, TranscribeAPI, handleFailure, sleep } from '../api';
import { EXIT, getConfig, printJson } from '../config';
import {
  captionFormatFor,
  isWaitableNotReady,
  notReadyRecovery,
} from '../catalog';

function apiFor(argv: any): TranscribeAPI {
  return new TranscribeAPI(getConfig({ allowCustomHost: argv.allowCustomHost }));
}

function writeRaw(raw: string): void {
  process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
}

// The raw-output commands (`subtitles`, `transcript`, `captions`) print a
// body, not JSON, so it can be piped to a file. Errors still print the JSON
// envelope, so `| jq .` on a failure keeps working.
export async function subtitles(argv: any): Promise<void> {
  try {
    const raw = await apiFor(argv).requestRaw(
      `/transcriptions/${argv.id}/subtitles`,
      {
        format: argv.format,
        preset: argv.preset,
        speaker_labels: argv.speakerLabels ? true : undefined,
        mode: argv.mode,
        source: argv.source,
      }
    );
    writeRaw(raw);
  } catch (err) {
    handleFailure(err, { id: argv.id });
  }
}

// GET /transcript. The whole transcript as a raw body, never capped.
//
// 409 handling is the interesting part: `not_ready` carries a `reason` and
// only `transcription_processing` can be fixed by waiting. Every other reason
// exits non-zero immediately with the envelope on stdout, because retrying it
// is a busy-loop that can never succeed.
export async function transcript(argv: any): Promise<void> {
  const api = apiFor(argv);
  const waitSeconds: number = argv.waitSeconds ?? 0;
  const deadline = Date.now() + waitSeconds * 1000;

  const query = {
    format: argv.format,
    // Both default to true server-side; only send the negation so the
    // request stays a plain GET of the documented default otherwise.
    speaker_labels: argv.speakerLabels === false ? false : undefined,
    timestamps: argv.timestamps === false ? false : undefined,
  };

  for (;;) {
    try {
      const raw = await api.requestRaw(`/transcriptions/${argv.id}/transcript`, query);
      if (argv.out) {
        writeFileSync(argv.out, raw.endsWith('\n') ? raw : raw + '\n');
        process.stderr.write(`wrote ${argv.out}\n`);
      } else {
        writeRaw(raw);
      }
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'not_ready') handleFailure(err, { id: argv.id });
      const apiErr = err as ApiError;
      const remainingMs = deadline - Date.now();
      if (!isWaitableNotReady(apiErr.reason) || remainingMs <= 0) {
        // Non-waitable reason, or --wait-seconds exhausted (default 0).
        handleFailure(apiErr, { id: argv.id });
      }
      // Retry-After is only set for `transcription_processing`; 15s is the
      // server's documented value and the fallback if the header is missing.
      const retryAfter =
        apiErr.retryAfterSeconds && Number.isFinite(apiErr.retryAfterSeconds)
          ? Math.max(1, apiErr.retryAfterSeconds)
          : 15;
      const sleepSec = Math.min(retryAfter, Math.ceil(remainingMs / 1000));
      process.stderr.write(
        `not ready (status=${apiErr.envelope?.error?.status ?? '?'}); retrying in ${sleepSec}s ` +
          `(${Math.ceil(remainingMs / 1000)}s of --wait-seconds left)\n`
      );
      await sleep(sleepSec * 1000);
    }
  }
}

// GET /timestamps, addressed by destination rather than by the wire's
// `format` name. Prints `text` raw by default; `--json` prints the whole
// envelope (warnings, ok_to_paste, thread[], constraints).
export async function captions(argv: any): Promise<void> {
  const api = apiFor(argv);
  let format: string;
  try {
    format = captionFormatFor(argv.for);
  } catch (err) {
    handleFailure(err, { id: argv.id });
  }

  const query = {
    format,
    variant: argv.variant,
    cta: argv.cta ? true : undefined,
  };

  const emit = (body: any, rawText: string): void => {
    if (argv.json) {
      writeRaw(rawText);
      return;
    }
    const text = body?.text;
    if (typeof text !== 'string') {
      printJson({
        error: {
          code: 'cli_error',
          message: 'the API response carried no `text` field; re-run with --json to see it',
        },
      });
      process.exit(EXIT.ERROR);
    }
    writeRaw(text);
    // Never let a silently shortened quote through unannounced: a truncated
    // quote is a misquote, and only stderr can carry that next to raw stdout.
    const warnings: string[] = Array.isArray(body?.warnings) ? body.warnings : [];
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    if (body?.ok_to_paste === false) {
      process.stderr.write(
        'warning: ok_to_paste=false - this output violates a hard platform rule; review before posting\n'
      );
    }
  };

  let regenerated = false;
  for (;;) {
    try {
      const res = await api.request(`/transcriptions/${argv.id}/timestamps`, { query });
      emit(res.json, res.rawText);
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'not_ready') handleFailure(err, { id: argv.id });
      const apiErr = err as ApiError;
      if (apiErr.reason === 'artifact_missing' && argv.regenerate && !regenerated) {
        regenerated = true;
        process.stderr.write(
          `curated cache missing; regenerating once (POST /timestamps/regenerate, 30-90s)...\n`
        );
        try {
          await api.request(`/transcriptions/${argv.id}/timestamps/regenerate`, {
            method: 'POST',
          });
        } catch (regenErr) {
          handleFailure(regenErr, { id: argv.id });
        }
        continue;
      }
      if (apiErr.reason === 'artifact_missing') {
        process.stderr.write(
          `Recovery: POST ${api.buildUrl(`/transcriptions/${argv.id}/timestamps/regenerate`)} once ` +
            `(or re-run with --regenerate), then retry this command.\n`
        );
      } else {
        process.stderr.write(`Recovery: ${notReadyRecovery(apiErr.reason, argv.id)}\n`);
      }
      // Both branches above already printed a Recovery line; the generic
      // not_ready hint would only repeat it.
      handleFailure(apiErr, { id: argv.id, suppressNotReadyHint: true });
    }
  }
}

// "Who said X, and when." Library-wide by default; --id scopes it to one
// transcription via the nested route (which 404s a foreign id instead of
// silently returning nothing).
export async function search(argv: any): Promise<void> {
  const path =
    argv.id !== undefined ? `/transcriptions/${argv.id}/search` : '/search';
  try {
    const res = await apiFor(argv).request(path, {
      query: { q: argv.q, limit: argv.limit, offset: argv.offset },
    });
    writeRaw(res.rawText);
    if (res.json?.has_more) {
      const next = (res.json.offset ?? 0) + (res.json.limit ?? 0);
      process.stderr.write(
        `more hits available; continue with --offset ${next} (offset is capped at 1000 - narrow the query instead of deep-paging)\n`
      );
    }
  } catch (err) {
    handleFailure(err, { id: argv.id });
  }
}

export async function ask(argv: any): Promise<void> {
  try {
    const body: Record<string, unknown> = { question: argv.question };
    if (argv.topK !== undefined) body.top_k = argv.topK;
    const res = await apiFor(argv).request(`/transcriptions/${argv.id}/ask`, {
      method: 'POST',
      body,
    });
    writeRaw(res.rawText);
  } catch (err) {
    handleFailure(err, { id: argv.id });
  }
}
