import { spawnSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { TranscribeAPI, handleFailure } from '../api';
import { EXIT, failLocal, getConfig, printJson } from '../config';

// Closed allowlist from the OpenAPI spec (UploadRequest.content_type).
export const CONTENT_TYPE_ALLOWLIST = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
];

const EXTENSION_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/m4a',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

const WARN_BYTES = 50 * 1024 * 1024;
const HARD_LIMIT_BYTES = 500 * 1024 * 1024;

function resolveContentType(file: string, override?: string): string {
  if (override) {
    if (!CONTENT_TYPE_ALLOWLIST.includes(override)) {
      failLocal(
        EXIT.USAGE,
        'unsupported_content_type',
        `--content-type ${override} is not accepted by the API. Allowed: ${CONTENT_TYPE_ALLOWLIST.join(', ')}`
      );
    }
    return override;
  }
  const ext = extname(file).toLowerCase();
  const type = EXTENSION_MAP[ext];
  if (!type) {
    failLocal(
      EXIT.USAGE,
      'unsupported_content_type',
      `Cannot map extension "${ext}" to an accepted content type. Pass --content-type with one of: ${CONTENT_TYPE_ALLOWLIST.join(', ')}`
    );
  }
  return type;
}

function probeDurationSeconds(file: string): number | null {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ],
    { encoding: 'utf8' }
  );
  if (probe.error || probe.status !== 0) return null;
  const seconds = parseFloat(probe.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export async function upload(argv: any): Promise<void> {
  const file: string = argv.file;

  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    failLocal(EXIT.USAGE, 'file_not_found', `File not found: ${file}`);
  }

  if (size > HARD_LIMIT_BYTES) {
    failLocal(
      EXIT.ERROR,
      'file_too_large_for_presigned',
      `${file} is ${(size / (1024 * 1024)).toFixed(0)} MB; the CLI's single-shot presigned upload is capped at 500 MB. Use a resumable tus upload (POST /api/v1/uploads/tus with any tus 1.0 client) or upload via https://transcribe.so instead.`
    );
  }
  if (size > WARN_BYTES) {
    process.stderr.write(
      `warning: ${(size / (1024 * 1024)).toFixed(0)} MB single-shot upload; the presigned URL expires in 900s. For flaky networks prefer the resumable tus flow (POST /api/v1/uploads/tus) or the web app.\n`
    );
  }

  const contentType = resolveContentType(file, argv.contentType);

  let durationSeconds: number | undefined = argv.duration;
  if (durationSeconds === undefined) {
    const probed = probeDurationSeconds(file);
    if (probed === null) {
      failLocal(
        EXIT.USAGE,
        'duration_required',
        'Duration is required for uploads and ffprobe is not available (or could not read this file). Either pass --duration <seconds> or install ffmpeg so ffprobe is on PATH.'
      );
    }
    durationSeconds = probed;
    process.stderr.write(`ffprobe duration: ${durationSeconds.toFixed(1)}s\n`);
  }

  const api = new TranscribeAPI(getConfig({ allowCustomHost: argv.allowCustomHost }));
  try {
    const res = await api.request('/uploads', {
      method: 'POST',
      body: {
        filename: basename(file),
        content_type: contentType,
        file_size: size,
      },
    });
    const uploadUrl: string = res.json.upload_url;
    process.stderr.write(`uploading ${basename(file)} (${size} bytes)...\n`);
    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: readFileSync(file),
    });
    if (!putResponse.ok) {
      const text = await putResponse.text();
      printJson({
        error: {
          code: 'upload_put_failed',
          message: `PUT to presigned URL failed with ${putResponse.status}: ${text.slice(0, 300)}`,
        },
      });
      process.stderr.write(`upload PUT failed (${putResponse.status})\n`);
      process.exit(EXIT.TRANSIENT);
    }
    printJson({
      upload_id: res.json.upload_id,
      duration_seconds: durationSeconds,
      filename: basename(file),
      file_size: size,
      content_type: contentType,
      next: `transcribe-so create --source upload --upload-id ${res.json.upload_id} --duration ${durationSeconds}`,
    });
  } catch (err) {
    handleFailure(err);
  }
}
