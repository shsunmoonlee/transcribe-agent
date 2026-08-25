export const DEFAULT_API_URL = 'https://transcribe.so';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  PAYMENT: 4,
  TRANSIENT: 5,
  BUDGET: 6,
} as const;

export interface CliConfig {
  apiKey: string;
  apiUrl: string;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// Local (non-API) failure: JSON error envelope on stdout, human line on
// stderr, mapped exit code. Mirrors the API envelope shape so agents can
// always parse stdout the same way.
export function failLocal(
  exitCode: number,
  code: string,
  message: string
): never {
  printJson({ error: { code, message } });
  process.stderr.write(`Error: ${message}\n`);
  process.exit(exitCode);
}

export function getConfig(argv: {
  allowCustomHost?: boolean;
}): CliConfig {
  const rawUrl = (process.env.TRANSCRIBE_API_URL || DEFAULT_API_URL).replace(
    /\/+$/,
    ''
  );

  if (rawUrl !== DEFAULT_API_URL) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      failLocal(
        EXIT.USAGE,
        'invalid_api_url',
        `TRANSCRIBE_API_URL is not a valid URL: ${rawUrl}`
      );
    }
    const isDefaultHost =
      parsed.protocol === 'https:' && parsed.hostname === 'transcribe.so';
    if (!isDefaultHost && !argv.allowCustomHost) {
      failLocal(
        EXIT.USAGE,
        'custom_host_refused',
        `Refusing to send your API key to ${rawUrl} (non-default or non-https host). ` +
          `If this is intentional, pass --allow-custom-host.`
      );
    }
  }

  const apiKey = process.env.TRANSCRIBE_API_KEY;
  if (!apiKey) {
    failLocal(
      EXIT.AUTH,
      'missing_api_key',
      'TRANSCRIBE_API_KEY is not set. Create a key at https://transcribe.so/settings/api-keys and export TRANSCRIBE_API_KEY=tsk_live_...'
    );
  }

  return { apiKey, apiUrl: rawUrl };
}
