// Unit tests for the pure mapping/parsing helpers. No test framework: this
// repo's scripts are plain tsx entrypoints (see check-api-coverage.ts), and
// adding a runner would add a devDependency for five assertions.
// Run: pnpm run test   (npx -y tsx scripts/test-units.ts)

import assert from 'assert';
import { ApiError, exitCodeFor } from '../src/api';
import {
  CAPTION_DESTINATION_NAMES,
  CAPTION_VARIANTS,
  captionFormatFor,
  isWaitableNotReady,
  notReadyRecovery,
} from '../src/catalog';
import { buildCreateBody, resolveRunCeiling } from '../src/commands/core';
import { EXIT } from '../src/config';

let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function envelope(code: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: { code, message: 'x', ...extra } });
}

console.log('catalog');

test('instagram is the only destination whose wire format differs', () => {
  assert.strictEqual(captionFormatFor('instagram'), 'instagram_caption');
  for (const name of CAPTION_DESTINATION_NAMES) {
    if (name === 'instagram') continue;
    assert.strictEqual(captionFormatFor(name), name, `${name} should be identity`);
  }
});

test('linkedin is a real destination and cta-capable variants are present', () => {
  assert.ok(CAPTION_DESTINATION_NAMES.includes('linkedin'));
  assert.ok(CAPTION_VARIANTS.includes('quoted_sections'));
  assert.ok(CAPTION_VARIANTS.includes('highlights'));
});

test('an unknown destination throws and names the valid set', () => {
  assert.throws(() => captionFormatFor('tiktok'), /instagram/);
});

test('only transcription_processing is waitable', () => {
  assert.strictEqual(isWaitableNotReady('transcription_processing'), true);
  for (const reason of [
    'transcription_failed',
    'transcription_cancelled',
    'not_started',
    'artifact_missing',
    undefined,
  ]) {
    assert.strictEqual(isWaitableNotReady(reason), false, `${reason} must not wait`);
  }
});

test('every not_ready reason gets a distinct recovery line', () => {
  const lines = new Set(
    [
      'transcription_processing',
      'transcription_failed',
      'transcription_cancelled',
      'not_started',
      'artifact_missing',
    ].map((r) => notReadyRecovery(r, 42))
  );
  assert.strictEqual(lines.size, 5);
});

console.log('exit codes');

test('max_charge_exceeded is exit 7, not the generic payment exit 4', () => {
  const err = new ApiError(402, envelope('max_charge_exceeded', { charge_usd: 3, max_charge_usd: 1 }), null);
  assert.strictEqual(exitCodeFor(err), EXIT.MAX_CHARGE);
  assert.notStrictEqual(EXIT.MAX_CHARGE, EXIT.PAYMENT);
});

test('the pre-0.2.0 exit codes are unchanged', () => {
  assert.deepStrictEqual(
    { OK: EXIT.OK, ERROR: EXIT.ERROR, USAGE: EXIT.USAGE, AUTH: EXIT.AUTH, PAYMENT: EXIT.PAYMENT, TRANSIENT: EXIT.TRANSIENT, BUDGET: EXIT.BUDGET },
    { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, PAYMENT: 4, TRANSIENT: 5, BUDGET: 6 }
  );
});

test('insufficient_funds still maps to payment (exit 4)', () => {
  assert.strictEqual(exitCodeFor(new ApiError(402, envelope('insufficient_funds'), null)), EXIT.PAYMENT);
});

test('rate_limited WITH a Retry-After stays transient (exit 5)', () => {
  const err = new ApiError(429, envelope('rate_limited', { message: 'slow down' }), 30);
  assert.strictEqual(exitCodeFor(err), EXIT.TRANSIENT);
});

test('rate_limited with NO Retry-After is a plain error (exit 1), not a retry loop', () => {
  // The regeneration cap: "Regeneration limit reached (10). Re-transcribe to
  // reset." 429, no Retry-After, and it never frees up on its own.
  const err = new ApiError(429, envelope('rate_limited'), null);
  assert.strictEqual(exitCodeFor(err), EXIT.ERROR);
  assert.notStrictEqual(exitCodeFor(err), EXIT.TRANSIENT);
});

test('ApiError exposes the not_ready reason', () => {
  const err = new ApiError(409, envelope('not_ready', { reason: 'artifact_missing' }), null);
  assert.strictEqual(err.reason, 'artifact_missing');
});

console.log('request bodies');

test('max_charge_usd is sent on create but never on a quote', () => {
  const argv = { source: 'youtube', url: 'https://youtu.be/x', maxChargeUsd: 2 };
  assert.strictEqual((buildCreateBody(argv, true) as any).max_charge_usd, 2);
  assert.ok(!('max_charge_usd' in buildCreateBody(argv)));
});

test('a zero ceiling survives the body builder (0 is meaningful: plan-covered only)', () => {
  const body = buildCreateBody({ source: 'youtube', url: 'u', maxChargeUsd: 0 }, true) as any;
  assert.strictEqual(body.max_charge_usd, 0);
});

test('run sends --max-usd as the server ceiling by default', () => {
  assert.strictEqual(resolveRunCeiling({ maxUsd: 2, serverCeiling: true }), 2);
});

test('an explicit --max-charge-usd beats --max-usd', () => {
  assert.strictEqual(resolveRunCeiling({ maxUsd: 2, maxChargeUsd: 5, serverCeiling: true }), 5);
});

test('--no-server-ceiling sends nothing', () => {
  assert.strictEqual(resolveRunCeiling({ maxUsd: 2, maxChargeUsd: 5, serverCeiling: false }), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall unit tests passed');
