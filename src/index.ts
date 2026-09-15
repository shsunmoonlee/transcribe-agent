import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { Argv } from 'yargs';
import { CLI_VERSION } from './version';
import {
  authStatus,
  me,
  pipelines,
  quote,
  create,
  wait,
  result,
  run,
  list,
  get,
  deleteTranscription,
  retry,
  capabilities,
} from './commands/core';
import { subtitles, ask, transcript, captions, search } from './commands/artifacts';
import { upload } from './commands/upload';
import {
  CAPTION_DESTINATION_NAMES,
  CAPTION_VARIANTS,
  TRANSCRIPT_FORMATS,
} from './catalog';

const INCLUDE_DESCRIBE =
  'Comma-separated result sections: chapters, acts, sections, qna, segments, posting_chapters, or all. Default chapters,sections,qna';

function sourceOptions(y: Argv): Argv {
  return y
    .option('source', {
      describe: 'Input source',
      type: 'string',
      choices: ['youtube', 'external_url', 'platform_url', 'upload'],
      demandOption: true,
    })
    .option('url', {
      describe: 'Media URL (required for youtube / platform_url / external_url)',
      type: 'string',
    })
    .option('upload-id', {
      describe: 'upload_id from `transcribe-so upload` (required for source=upload)',
      type: 'string',
    })
    .option('duration', {
      describe: 'Media duration in seconds (required for upload; speeds up URL sources)',
      type: 'number',
    })
    .option('language', {
      describe: 'BCP-47 language code (en, ja, ko, ...) or auto (default)',
      type: 'string',
    })
    .option('callback-url', {
      describe: 'Public https URL that receives this job\'s signed completed/failed webhook',
      type: 'string',
    })
    .option('idempotency-key', {
      describe: 'Override the auto-generated Idempotency-Key (max 128 chars)',
      type: 'string',
    })
    .check((argv: any) => {
      if (argv.source === 'upload') {
        if (!argv.uploadId) throw new Error('source=upload requires --upload-id');
        if (argv.duration === undefined)
          throw new Error('source=upload requires --duration <seconds>');
      } else if (!argv.url) {
        throw new Error(`source=${argv.source} requires --url`);
      }
      if (
        argv.duration !== undefined &&
        (!Number.isFinite(argv.duration) || argv.duration <= 0)
      ) {
        throw new Error('--duration must be a positive number of seconds');
      }
      return true;
    });
}

// Server-side charge ceiling. NOT the same thing as `run --max-usd`, which
// is a local refusal decided from the free quote before anything is created.
// This one travels with the request and is enforced at the wallet hold, so it
// also covers a charge that moves between the quote and the hold.
function maxChargeOption(y: Argv): Argv {
  return y
    .option('max-charge-usd', {
      describe:
        'Server-side charge ceiling in USD. The API refuses with 402 max_charge_exceeded (exit 7) before holding anything if the computed charge is higher. A plan-covered job charges $0 and passes any ceiling, including 0.',
      type: 'number',
    })
    .check((argv: any) => {
      if (
        argv.maxChargeUsd !== undefined &&
        (!Number.isFinite(argv.maxChargeUsd) || argv.maxChargeUsd < 0)
      ) {
        throw new Error('--max-charge-usd must be a finite number >= 0');
      }
      return true;
    });
}

function segmentWindowOptions(y: Argv): Argv {
  return y
    .option('segments-offset', {
      describe: 'First segment to return, 0-based (only with --include segments|all)',
      type: 'number',
    })
    .option('segments-limit', {
      describe:
        'How many segments to return (1-1000). Read segments_meta.has_more; for the whole transcript use `transcript <id>`, which is never capped.',
      type: 'number',
    });
}

const parser = yargs(hideBin(process.argv))
  .scriptName('transcribe-so')
  .usage(
    '$0 <command> [options]\n\nPure-JSON stdout, except the three raw-output commands (subtitles, transcript,\ncaptions) which print a body you can pipe to a file; progress goes to stderr.'
  )
  .option('allow-custom-host', {
    describe:
      'Allow sending the API key to a non-default TRANSCRIBE_API_URL host (refused otherwise)',
    type: 'boolean',
    default: false,
    global: true,
  })
  .command(
    'auth:status',
    'Check whether TRANSCRIBE_API_KEY authenticates against the API',
    {},
    authStatus as any
  )
  .command(
    'me',
    'Account, wallet balance, plan limits, API-key scopes and spend',
    (y: Argv) => y.example('$0 me | jq .wallet_balance_usd', 'Check the wallet balance'),
    me as any
  )
  .command(
    'pipelines',
    'Capability catalog: pricing per minute and supported languages',
    (y: Argv) =>
      y.example('$0 pipelines | jq \'.pipelines[0].retail_usd_per_min\'', 'Current per-minute rate'),
    pipelines as any
  )
  .command(
    'quote',
    'Preview the exact cost of a transcription (free, does not queue the job)',
    (y: Argv) =>
      sourceOptions(y)
        .example(
          '$0 quote --source youtube --url "https://www.youtube.com/watch?v=jNQXAC9IVRw"',
          'Price a YouTube video'
        )
        .example(
          '$0 quote --source upload --upload-id up_abc --duration 1800',
          'Price an uploaded file (30 min)'
        ),
    quote as any
  )
  .command(
    'create',
    'Submit a transcription (charges the wallet; prints the 202 body)',
    (y: Argv) =>
      maxChargeOption(sourceOptions(y))
        .example(
          '$0 create --source youtube --url "https://youtu.be/x" --max-charge-usd 2',
          'Refuse server-side (exit 7) if the charge would exceed $2'
        )
        .example(
          '$0 create --source youtube --url "https://youtu.be/jNQXAC9IVRw"',
          'Transcribe a YouTube video'
        )
        .example(
          '$0 create --source upload --upload-id up_abc --duration 1800',
          'Transcribe an uploaded file'
        ),
    create as any
  )
  .command(
    'wait <id>',
    'Long-poll until the transcription completes or fails (server-side windows)',
    (y: Argv) =>
      segmentWindowOptions(y)
        .positional('id', { describe: 'Transcription id from the create 202', type: 'number' })
        .option('timeout', {
          describe: 'Overall seconds to keep waiting',
          type: 'number',
          default: 1800,
        })
        .option('include', { describe: INCLUDE_DESCRIBE, type: 'string' })
        .example('$0 wait 4821', 'Wait for job 4821')
        .example('$0 wait 4821 --include all', 'Wait and inline the full result on completion'),
    wait as any
  )
  .command(
    'result <id>',
    'Fetch the result of a completed transcription',
    (y: Argv) =>
      segmentWindowOptions(y)
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('include', { describe: INCLUDE_DESCRIBE, type: 'string' })
        .example('$0 result 4821', 'Chapters, sections and Q&A')
        .example('$0 result 4821 --include segments | jq -r \'.segments[].text\'', 'One window of verbatim text')
        .example(
          '$0 result 4821 --include segments --segments-offset 1000 --segments-limit 1000',
          'The next window (see segments_meta)'
        ),
    result as any
  )
  .command(
    'run',
    'quote, then create, wait, and fetch the result in one command (requires --max-usd)',
    (y: Argv) =>
      maxChargeOption(sourceOptions(y))
        .option('server-ceiling', {
          describe:
            'Also send --max-usd (or --max-charge-usd) to the API as max_charge_usd, so the ceiling is enforced at the wallet hold too. Default true; --no-server-ceiling opts out.',
          type: 'boolean',
          default: true,
        })
        .option('max-usd', {
          describe:
            'Hard budget: refuse (exit 6) if the quote exceeds this many USD. Required; there is no default.',
          type: 'number',
          demandOption: true,
        })
        .option('timeout', {
          describe: 'Overall seconds to wait for completion',
          type: 'number',
          default: 1800,
        })
        .option('include', { describe: INCLUDE_DESCRIBE, type: 'string' })
        .check((argv: any) => {
          if (!Number.isFinite(argv.maxUsd) || argv.maxUsd < 0) {
            throw new Error('--max-usd must be a finite number >= 0 (e.g. --max-usd 2)');
          }
          return true;
        })
        .example(
          '$0 run --source youtube --url "https://youtu.be/jNQXAC9IVRw" --max-usd 2',
          'Transcribe end to end, refusing if it would cost more than $2'
        ),
    run as any
  )
  .command(
    'list',
    'List transcriptions (newest first, cursor-paginated)',
    (y: Argv) =>
      y
        .option('limit', { describe: '1-200, default 50', type: 'number' })
        .option('cursor', { describe: 'next_cursor from the previous page', type: 'string' })
        .option('api-only', { describe: 'Only jobs created via API', type: 'boolean' })
        .example('$0 list --limit 5 | jq \'.data[] | {id, status, title}\'', 'Latest five jobs'),
    list as any
  )
  .command(
    'get <id>',
    'Get one transcription (status, stage, progress, charge)',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .example('$0 get 4821 | jq .status', 'Check status'),
    get as any
  )
  .command(
    'delete <id>',
    'Permanently delete a transcription and all derived data (irreversible)',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('yes', {
          describe: 'Required confirmation flag; deletion is irreversible',
          type: 'boolean',
          default: false,
        })
        .check((argv: any) => {
          if (!argv.yes) throw new Error('delete is irreversible; re-run with --yes to confirm');
          return true;
        })
        .example('$0 delete 4821 --yes', 'Delete transcription 4821'),
    deleteTranscription as any
  )
  .command(
    'retry <id>',
    'Retry a failed transcription (charges again from scratch)',
    (y: Argv) =>
      maxChargeOption(y)
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('yes', {
          describe: 'Required confirmation flag; retry re-charges the wallet from scratch',
          type: 'boolean',
          default: false,
        })
        .option('idempotency-key', {
          describe: 'Override the auto-generated Idempotency-Key',
          type: 'string',
        })
        .check((argv: any) => {
          if (!argv.yes) throw new Error('retry re-charges from scratch; re-run with --yes to confirm');
          return true;
        })
        .example('$0 retry 4821 --yes --max-charge-usd 2', 'Re-run failed job 4821, capped at $2'),
    retry as any
  )
  .command(
    'upload <file>',
    'Upload a local media file; prints the upload_id to pass to create/run',
    (y: Argv) =>
      y
        .positional('file', { describe: 'Path to the audio/video file', type: 'string' })
        .option('duration', {
          describe: 'Duration in seconds (otherwise probed with ffprobe if installed)',
          type: 'number',
        })
        .option('content-type', {
          describe: 'Override the MIME type (must be on the API allowlist)',
          type: 'string',
        })
        .check((argv: any) => {
          if (
            argv.duration !== undefined &&
            (!Number.isFinite(argv.duration) || argv.duration <= 0)
          ) {
            throw new Error('--duration must be a positive number of seconds');
          }
          return true;
        })
        .example('$0 upload ./interview.mp3', 'Upload an MP3 (duration via ffprobe)')
        .example('$0 upload ./talk.mp4 --duration 1922', 'Upload with explicit duration'),
    upload as any
  )
  .command(
    'subtitles <id>',
    'Print the raw subtitle file (SRT/VTT/JSON) to stdout - a raw-output command',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('format', {
          describe: 'Subtitle format',
          type: 'string',
          choices: ['srt', 'vtt', 'vtt-karaoke', 'json'],
        })
        .option('preset', {
          describe: 'Platform line rules',
          type: 'string',
          choices: ['youtube', 'tiktok-shorts', 'instagram-reels', 'netflix', 'podcast', 'broadcast'],
        })
        .option('speaker-labels', { describe: 'Prefix cues with [Speaker]', type: 'boolean' })
        .option('mode', {
          describe: 'Cue timing',
          type: 'string',
          choices: ['auto', 'word', 'sentence'],
        })
        .option('source', {
          describe: 'Which cues to serve',
          type: 'string',
          choices: ['auto', 'generated', 'materialized'],
        })
        .example('$0 subtitles 4821 > talk.srt', 'Save the SRT')
        .example('$0 subtitles 4821 --format vtt --preset tiktok-shorts > talk.vtt', 'Vertical-video VTT'),
    subtitles as any
  )
  .command(
    'transcript <id>',
    'Print the COMPLETE transcript as raw text or Markdown (never capped) - a raw-output command',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('format', {
          describe: 'txt (transcript only) or md (title + chapter list + turns)',
          type: 'string',
          choices: [...TRANSCRIPT_FORMATS],
          default: 'txt',
        })
        .option('speaker-labels', {
          describe: 'Prefix each turn with its speaker label (default true; --no-speaker-labels to drop)',
          type: 'boolean',
          default: true,
        })
        .option('timestamps', {
          describe: 'Prefix each turn with its clock time (default true; --no-timestamps to drop)',
          type: 'boolean',
          default: true,
        })
        .option('out', { describe: 'Write to this file instead of stdout', type: 'string' })
        .option('wait-seconds', {
          describe:
            'If the job is still processing (409 not_ready reason=transcription_processing), keep retrying on Retry-After for up to this many seconds. Default 0 = fail immediately. Every other not_ready reason exits non-zero without waiting.',
          type: 'number',
          default: 0,
        })
        .check((argv: any) => {
          if (!Number.isFinite(argv.waitSeconds) || argv.waitSeconds < 0) {
            throw new Error('--wait-seconds must be a finite number >= 0');
          }
          return true;
        })
        .example('$0 transcript 4821 > talk.txt', 'Whole transcript as text')
        .example('$0 transcript 4821 --format md --out talk.md', 'Timestamped Markdown export')
        .example('$0 transcript 4821 --no-timestamps --no-speaker-labels', 'Prose only'),
    transcript as any
  )
  .command(
    'captions <id>',
    'Paste-ready captions/timestamps for one destination - prints the text raw (--json for the envelope)',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('for', {
          describe: 'Destination platform',
          type: 'string',
          choices: CAPTION_DESTINATION_NAMES,
          default: 'youtube',
        })
        .option('variant', {
          describe:
            'Content: standard (chapter list), highlights (5-item text outline), clips (3 video ideas), quoted_sections (verbatim quotes), show_notes, original',
          type: 'string',
          choices: [...CAPTION_VARIANTS],
          default: 'standard',
        })
        .option('cta', {
          describe: 'Append the transcribe.so CTA footer (quoted_sections only). Off by default: the caption belongs to the user.',
          type: 'boolean',
          default: false,
        })
        .option('json', {
          describe: 'Print the full JSON envelope (warnings, ok_to_paste, thread[], constraints) instead of the raw text',
          type: 'boolean',
          default: false,
        })
        .option('regenerate', {
          describe:
            'On 409 not_ready reason=artifact_missing, POST /timestamps/regenerate ONCE (30-90s) and retry. Without it the command prints the recovery and exits non-zero.',
          type: 'boolean',
          default: false,
        })
        .example('$0 captions 4821 --for instagram --variant highlights', 'IG caption outline')
        .example('$0 captions 4821 --for youtube > chapters.txt', 'YouTube chapter list')
        .example('$0 captions 4821 --for x --variant quoted_sections --json | jq -r \'.thread[]\'', 'Pre-split X thread'),
    captions as any
  )
  .command(
    'search <q>',
    'Search transcript segments ("who said X, and when") across the library or one transcription',
    (y: Argv) =>
      y
        .positional('q', { describe: 'Search terms (2-200 chars, case-insensitive substring)', type: 'string' })
        .option('id', {
          describe: 'Restrict to one transcription id (404s if it is not yours)',
          type: 'number',
        })
        .option('limit', { describe: 'Hits per page, 1-100 (default 20)', type: 'number' })
        .option('offset', { describe: '0-based offset, max 1000', type: 'number' })
        .example('$0 search "pricing" | jq -r \'.hits[] | "\\(.speaker): \\(.text)"\'', 'Who said it')
        .example('$0 search "pricing" --id 4821', 'Within one transcription'),
    search as any
  )
  .command(
    'capabilities',
    'One JSON object: this account (/me), the pipeline catalog (/pipelines), every format enum this CLI accepts, and the exit codes',
    (y: Argv) =>
      y.example('$0 capabilities | jq .formats.captions.destinations', 'Valid `captions --for` values'),
    capabilities as any
  )
  .command(
    'ask <id>',
    'Ask a question about one completed transcription (cited answer; daily Q&A allowance)',
    (y: Argv) =>
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('question', {
          alias: 'q',
          describe: 'The question (1-500 chars)',
          type: 'string',
          demandOption: true,
        })
        .option('top-k', { describe: 'Retrieval candidates before rerank (10-100)', type: 'number' })
        .example('$0 ask 4821 -q "What did the guest say about pricing?"', 'Cited Q&A'),
    ask as any
  )
  .demandCommand(1, 'You need at least one command')
  .strict()
  .help()
  .alias('h', 'help')
  .version(CLI_VERSION)
  .alias('v', 'version')
  .wrap(Math.min(100, process.stdout.columns || 100))
  .epilogue(
    'Authentication: export TRANSCRIBE_API_KEY=tsk_live_... (create one at https://transcribe.so/settings/api-keys)\n' +
      'Docs: https://transcribe.so/developers/docs  |  OpenAPI: https://transcribe.so/openapi.json'
  )
  .fail((msg, err, instance) => {
    // Handlers exit themselves (handleFailure/failLocal), so anything that
    // reaches here is a usage/validation problem: bad flags, missing args,
    // or a .check() throw. All of it is exit 2.
    if (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    instance.showHelp('error');
    process.stderr.write(`\n${msg}\n`);
    process.exit(2);
  });

parser.parse();
