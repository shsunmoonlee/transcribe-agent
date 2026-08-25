import { CliConfig, EXIT } from './config';
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
    case 'rate_limited':
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
export function handleFailure(err: unknown): never {
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
    if (err.code === 'not_ready') {
      process.stderr.write(
        'Hint: transcription not completed yet; run `transcribe-so wait <id>` first.\n'
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

function sleep(ms: number): Promise<void> {
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
