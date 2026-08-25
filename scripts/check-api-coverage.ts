// Drift gate: every non-deprecated operation in the live OpenAPI spec must
// either map to a CLI command or sit in the explicit skip list below.
// Run: npx -y tsx scripts/check-api-coverage.ts   (pnpm run check:coverage)
// Exits nonzero on drift so CI can gate releases on it.

const SPEC_URL = process.env.OPENAPI_URL || 'https://transcribe.so/openapi.json';

// operationId -> CLI command (v0.1 surface).
const COVERED: Record<string, string> = {
  getMe: 'me',
  listPipelines: 'pipelines',
  createUpload: 'upload',
  createQuote: 'quote',
  createTranscription: 'create',
  listTranscriptions: 'list',
  getTranscription: 'get',
  deleteTranscription: 'delete',
  getTranscriptionResult: 'result',
  waitForTranscription: 'wait',
  retryTranscription: 'retry',
  getSubtitles: 'subtitles',
  askTranscription: 'ask',
};

// Deliberately NOT covered in v0.1. Each entry needs a reason; remove the
// entry when the command ships so this gate starts enforcing it.
const SKIPPED: Record<string, string> = {
  createTusUpload: 'v0.2: resumable tus uploads (CLI caps presigned at 500 MB and points larger files at tus/web)',
  getTranscriptionTimestamps: 'v0.2: timestamps:* command tail',
  regeneratePostingChapters: 'v0.2: timestamps:* command tail',
  getTranscriptionWords: 'v0.2: words command',
  createClip: 'v0.2: clips:* commands',
  listClips: 'v0.2: clips:* commands',
  getClip: 'v0.2: clips:* commands',
  askLibrary: 'v0.2: ask:library command',
  getWebhook: 'v0.2: webhooks:get (API has one webhook per key, no list)',
  createWebhook: 'v0.2: webhooks:*',
  deleteWebhook: 'v0.2: webhooks:*',
  testWebhook: 'v0.2: webhooks:*',
  createRealtimeSession: 'internal beta: realtime sessions are not generally available',
  endRealtimeSession: 'internal beta: realtime sessions are not generally available',
  resumeRealtimeSession: 'internal beta: realtime sessions are not generally available',
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

async function main(): Promise<void> {
  const response = await fetch(SPEC_URL);
  if (!response.ok) {
    console.error(`failed to fetch ${SPEC_URL}: ${response.status}`);
    process.exit(1);
  }
  const spec: any = await response.json();

  const failures: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let covered = 0;
  let skipped = 0;

  for (const [path, pathItem] of Object.entries<any>(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (operation.deprecated) continue;
      total++;
      const operationId: string | undefined = operation.operationId;
      const label = `${method.toUpperCase()} ${path}`;
      if (!operationId) {
        failures.push(`${label}: missing operationId`);
        continue;
      }
      seen.add(operationId);
      if (COVERED[operationId]) {
        covered++;
      } else if (SKIPPED[operationId]) {
        skipped++;
      } else {
        failures.push(
          `${label} (${operationId}): no CLI command and not in the skip list`
        );
      }
    }
  }

  // Stale entries: local lists referencing operations the spec no longer has.
  for (const operationId of [...Object.keys(COVERED), ...Object.keys(SKIPPED)]) {
    if (!seen.has(operationId)) {
      failures.push(`stale entry: ${operationId} is not in the live spec`);
    }
  }

  console.log(
    `api coverage: ${total} operations, ${covered} covered, ${skipped} explicitly skipped`
  );
  if (failures.length > 0) {
    console.error('\nDRIFT DETECTED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('ok: no drift');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
