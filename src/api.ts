import { CliConfig, EXIT } from './config';
import { notReadyRecovery } from './catalog';
import { CLI_VERSION } from './version';

export interface ApiResponse {
  status: number;
  headers: Headers;
  rawText: string;
  json: any;
}

export class ApiError extends Error {
  status: number;
  rawText: string;
  envelope: any;
  retryAfterSeconds: number | null;

  constructor(status: number, rawText: string, retryAfterSeconds: number | null) {
    let envelope: any = null;
    try {
      envelope = JSON.parse(rawText);
    } catch {
      envelope = null;
    }
    const code = envelope?.error?.code ?? 'unknown_error';
    const message = envelope?.error?.message ?? rawText.slice(0, 500);
    super(`API error ${status} ${code}: ${message}`);
    this.status = status;
    this.rawText = rawText;
    this.envelope = envelope;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get code(): string {
    return this.envelope?.error?.code ?? 'unknown_error';
  }

  // Only set on 409 `not_ready` (transcript / timestamps). Decides whether
  // waiting can possibly help.
  get reason(): string | undefined {
    return this.envelope?.error?.reason;
  }
}

// `rate_limited` with no finite Retry-After is permanent on a CLI timescale:
// nothing the agent can do makes the same call succeed later.
export function isPermanentRateLimit(err: ApiError): boolean {
  if (err.code !== 'rate_limited') return false;
  return !(err.retryAfterSeconds !== null && Number.isFinite(err.retryAfterSeconds));
}

// Exit-code mapping: error.code FIRST, HTTP status second.
export function exitCodeFor(err: ApiError): number {
  switch (err.code) {
    case 'unauthenticated':
    case 'invalid_api_key':
    case 'scope_forbidden':
      return EXIT.AUTH;
    case 'insufficient_funds':
    case 'spend_cap_exceeded':
      return EXIT.PAYMENT;
    // Also a 402, but the opposite remedy: nothing was held or charged and
    // the account is fine. Raising the ceiling is the user's call, never the
    // agent's, so it gets its own code instead of reading as "top up".
    case 'max_charge_exceeded':
      return EXIT.MAX_CHARGE;
    // A 429 with a Retry-After is a real throttle: wait it out. Without one it
    // is an exhausted allowance that never refills on its own - the
    // regeneration cap ("Regeneration limit reached (10). Re-transcribe to
    // reset.") is the live example - so it gets the plain error code and
    // agents stop looping.
    case 'rate_limited':
      return isPermanentRateLimit(err) ? EXIT.ERROR : EXIT.TRANSIENT;
    case 'internal_error':
      return EXIT.TRANSIENT;
    // Not transient on a CLI timescale: the daily Q&A allowance frees up in
    // hours, not seconds. Plain error so agents stop asking, not retry.
    case 'qna_quota_exceeded':
      return EXIT.ERROR;
  }
  if (err.status === 401) return EXIT.AUTH;
  if (err.status === 402) return EXIT.PAYMENT;
  if (err.status === 429 || err.status >= 500) return EXIT.TRANSIENT;
  return EXIT.ERROR;
}

// Print the API error envelope to stdout VERBATIM, a human line to stderr,
// then exit with the mapped code. Non-ApiError failures (network, bugs) get
// a synthesized envelope and exit 1.
export interface FailureContext {
  // The transcription id the failing call was about, so recovery lines can
  // name a real command instead of a placeholder.
  id?: number | string;
  // Set by callers that already printed their own, more specific Recovery
  // line; without it the generic not_ready hint prints the same advice twice.
  suppressNotReadyHint?: boolean;
}

export function handleFailure(err: unknown, ctx: FailureContext = {}): never {
  if (err instanceof ApiError) {
    if (err.envelope !== null) {
      process.stdout.write(err.rawText.endsWith('\n') ? err.rawText : err.rawText + '\n');
    } else {
      // Upstream body was not JSON (CF error page, empty 502, ...). Keep
      // stdout jq-safe with a synthesized envelope instead of raw HTML.
      process.stdout.write(
        JSON.stringify({
          error: {
            code: 'upstream_error',
            message: err.rawText.slice(0, 300),
            http_status: err.status,
          },
        }) + '\n'
      );
    }
    process.stderr.write(`${err.message}\n`);
    if (err.code === 'not_ready' && !ctx.suppressNotReadyHint) {
      // `reason` is the whole point of this envelope: only
      // `transcription_processing` resolves by waiting.
      process.stderr.write(
        `Hint: ${notReadyRecovery(err.reason, ctx.id ?? '<id>')}\n`
      );
    }
    if (isPermanentRateLimit(err)) {
      process.stderr.write(
        'Hint: this allowance does not refill on a CLI timescale (no Retry-After was sent). ' +
          'Re-transcribe to reset; retrying will not help.\n'
      );
    }
    if (err.code === 'max_charge_exceeded') {
      const charge = err.envelope?.error?.charge_usd;
      // The envelope does not always echo the ceiling back; `$undefined` read
      // as a real number to agents.
      const ceiling = err.envelope?.error?.max_charge_usd ?? 'not sent';
      process.stderr.write(
        `Hint: nothing was charged and no job started. The real charge is $${charge} against a ceiling of $${ceiling}. ` +
          `Report the price and ask the user before raising --max-charge-usd; do not raise it on your own.\n`
      );
    }
    process.exit(exitCodeFor(err));
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(
    JSON.stringify({ error: { code: 'cli_error', message } }) + '\n'
  );
  process.stderr.write(`Error: ${message}\n`);
  process.exit(EXIT.ERROR);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export class TranscribeAPI {
  private apiKey: string;
  private apiUrl: string;

  constructor(config: CliConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl;
  }

  get baseUrl(): string {
    return this.apiUrl;
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.apiUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  // Retry policy: decided on error.code, never on a bare 429 status.
  // Only per-minute `rate_limited` responses with a short, finite
  // Retry-After header are retried; fair-use / daily-allowance exhaustion
  // shares the code but carries no short Retry-After window. Job-creating
  // POSTs (create/retry) are never auto-retried at all — resubmitting a
  // charge is the caller's call, idempotency key or not.
  async request(path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);
    const maxAttempts = 3;
    const isJobCreatingPost =
      method === 'POST' &&
      (path === '/transcriptions' || /\/retry$/.test(path));

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': `transcribe-so-cli/${CLI_VERSION}`,
        Accept: 'application/json',
      };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

      const response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const rawText = await response.text();

      if (response.ok) {
        let json: any = null;
        try {
          json = JSON.parse(rawText);
        } catch {
          json = null;
        }
        return { status: response.status, headers: response.headers, rawText, json };
      }

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
      const err = new ApiError(response.status, rawText, retryAfterSeconds);

      const retryable =
        err.code === 'rate_limited' &&
        !isJobCreatingPost &&
        retryAfterSeconds !== null &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds <= 90;

      if (retryable && attempt < maxAttempts) {
        const waitSec = Math.max(1, retryAfterSeconds!);
        process.stderr.write(
          `rate limited; retrying in ${waitSec}s (attempt ${attempt}/${maxAttempts - 1})\n`
        );
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }

  // GET that returns the RAW body (subtitles). Errors keep the envelope.
  async requestRaw(path: string, query?: RequestOptions['query']): Promise<string> {
    const url = this.buildUrl(path, query);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': `transcribe-so-cli/${CLI_VERSION}`,
      },
    });
    const rawText = await response.text();
    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      throw new ApiError(
        response.status,
        rawText,
        retryAfterHeader ? Number(retryAfterHeader) : null
      );
    }
    return rawText;
  }
}
