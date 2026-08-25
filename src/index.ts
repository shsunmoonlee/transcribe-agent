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
} from './commands/core';
import { subtitles, ask } from './commands/artifacts';
import { upload } from './commands/upload';

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
      return true;
    });
}

const parser = yargs(hideBin(process.argv))
  .scriptName('transcribe-so')
  .usage('$0 <command> [options]\n\nPure-JSON stdout (subtitles excepted); progress goes to stderr.')
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
      sourceOptions(y)
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
      y
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
      y
        .positional('id', { describe: 'Transcription id', type: 'number' })
        .option('include', { describe: INCLUDE_DESCRIBE, type: 'string' })
        .example('$0 result 4821', 'Chapters, sections and Q&A')
        .example('$0 result 4821 --include segments | jq -r \'.segments[].text\'', 'Full verbatim text'),
    result as any
  )
  .command(
    'run',
    'quote, then create, wait, and fetch the result in one command (requires --max-usd)',
    (y: Argv) =>
      sourceOptions(y)
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
      y
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
        .example('$0 retry 4821 --yes', 'Re-run failed job 4821'),
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
        .example('$0 upload ./interview.mp3', 'Upload an MP3 (duration via ffprobe)')
        .example('$0 upload ./talk.mp4 --duration 1922', 'Upload with explicit duration'),
    upload as any
  )
  .command(
    'subtitles <id>',
    'Print the raw subtitle file (SRT/VTT/JSON) to stdout - the one non-JSON command',
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
