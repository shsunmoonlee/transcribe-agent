// Static enums the CLI knows about, mirrored from the live OpenAPI spec.
// Nothing here is invented: every list is an enum that exists on the wire.
// `capabilities` prints these alongside the live /me and /pipelines bodies.

export const SOURCES = ['youtube', 'platform_url', 'external_url', 'upload'] as const;

export const TRANSCRIPT_FORMATS = ['txt', 'md'] as const;

export const SUBTITLE_FORMATS = ['srt', 'vtt', 'vtt-karaoke', 'json'] as const;
export const SUBTITLE_PRESETS = [
  'youtube',
  'tiktok-shorts',
  'instagram-reels',
  'netflix',
  'podcast',
  'broadcast',
] as const;
export const SUBTITLE_MODES = ['auto', 'word', 'sentence'] as const;
export const SUBTITLE_SOURCES = ['auto', 'generated', 'materialized'] as const;

export const RESULT_INCLUDE_SECTIONS = [
  'chapters',
  'acts',
  'sections',
  'qna',
  'segments',
  'posting_chapters',
  'all',
] as const;

// `captions --for <destination>`: friendly name -> the API's `format` value.
// Only `instagram` differs from the wire name; the rest are identity so the
// flag stays one vocabulary rather than two.
export const CAPTION_DESTINATIONS: Record<string, string> = {
  instagram: 'instagram_caption',
  x: 'x',
  threads: 'threads',
  linkedin: 'linkedin',
  youtube: 'youtube',
  spotify: 'spotify',
  apple_podcasts: 'apple_podcasts',
  markdown: 'markdown',
  plain: 'plain',
};

export const CAPTION_DESTINATION_NAMES = Object.keys(CAPTION_DESTINATIONS);

export const CAPTION_VARIANTS = [
  'standard',
  'highlights',
  'clips',
  'quoted_sections',
  'show_notes',
  'original',
] as const;

// 409 not_ready reasons on /transcript and /timestamps. Only ONE resolves by
// waiting; the rest need a different action, so the CLI must not back off on them.
export const NOT_READY_REASONS = [
  'transcription_processing',
  'transcription_failed',
  'transcription_cancelled',
  'not_started',
  'artifact_missing',
] as const;

export type NotReadyReason = (typeof NOT_READY_REASONS)[number];

export function captionFormatFor(destination: string): string {
  const format = CAPTION_DESTINATIONS[destination];
  if (!format) {
    throw new Error(
      `unknown caption destination "${destination}"; expected one of: ${CAPTION_DESTINATION_NAMES.join(', ')}`
    );
  }
  return format;
}

// Recovery line printed for every non-waitable not_ready reason. The strings
// are the exact next action, not a restatement of the error.
export function notReadyRecovery(reason: string | undefined, id: number | string): string {
  switch (reason) {
    case 'transcription_processing':
      return `Still processing. Wait for it: transcribe-so wait ${id}`;
    case 'transcription_failed':
      return `The transcription failed; there is nothing to wait for. A retry is a NEW paid attempt: transcribe-so retry ${id} --yes --max-charge-usd <n>`;
    case 'transcription_cancelled':
      return `The transcription was cancelled; there is no transcript and waiting will not produce one.`;
    case 'not_started':
      return `This row is a quote (status=quoted) that was never started. Start a job with: transcribe-so create ...  (the quote's transcription_id is not a job id)`;
    case 'artifact_missing':
      return `Completed, but the artifact was never generated. Retrying the same call will not help.`;
    default:
      return `Not ready (reason=${reason ?? 'unknown'}).`;
  }
}

export function isWaitableNotReady(reason: string | undefined): boolean {
  return reason === 'transcription_processing';
}
