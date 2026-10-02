---
name: transcribe-audio
description: Transcribe audio or video from a YouTube URL, platform URL (Apple Podcasts, SoundCloud, Vimeo, Twitch, Loom), direct file URL, or local file upload into speaker-labelled, timestamped segments with chapters, sections, and cited Q&A. Use when the user wants a transcript, show notes, chapters, or analysis of any recording.
---

# Transcribe audio or video

The bundled `transcribe-so` MCP server turns recordings into speaker-labelled,
timestamped transcripts with automatic chapters, sections, and cited Q&A.

## Sources

- `youtube`: a YouTube video URL
- `platform_url`: a public page URL on a supported platform (Apple Podcasts,
  SoundCloud, Vimeo, Twitch, Loom and similar)
- `external_url`: a direct http(s) link to an audio or video file
- `upload`: a local file (shell agents only): call `createUpload` for a presigned PUT URL
  (15 minute TTL), PUT the bytes, then pass the returned `upload_id` together
  with `duration_seconds`

## Flow

1. Preview before creating a job: call `getQuote` first. It starts nothing;
   it returns the length, the detected title and what the job would use from
   the user's existing transcribe.so account (`retail_usd`, 0 when the account
   already includes it). When `retail_usd` is 0, or within a limit the user
   already gave, go ahead; otherwise tell the user the figure and wait for a
   go-ahead. Pass the figure the user agreed to as `max_charge_usd` to
   `transcribe`; the server enforces it: if the real figure is higher the call
   is refused with `max_charge_exceeded` and nothing is started. Report the
   refused figure and ask; do not raise the ceiling yourself.
2. Call `transcribe` with the source. It returns `id` immediately; jobs are
   asynchronous.
3. For short recordings, long-poll with `waitForTranscription` (each call
   covers ~90 s; `_timed_out: true` means still processing; call it again,
   this is the expected loop, not an error). For long recordings, hand the
   user the dashboard link (https://transcribe.so/transcriptions); they also
   get a completion email.
4. `transcribe` is not idempotent unless you pass `idempotency_key` (re-send
   the same key with the same arguments and the first result replays). Without
   a key, if a call times out, check `listTranscriptions` before retrying.

Agents with their own public endpoint can pass `callback_url` to `transcribe`
to receive a signed `transcription.completed` / `transcription.failed`
webhook instead of polling (the per-job HMAC secret comes back as
`callback.secret`).

## Authentication

The MCP server authenticates via OAuth 2.0 (browser flow starts automatically
on first use) or a `tsk_live_*` API key from
https://transcribe.so/settings/api-keys sent as the Bearer token.

## Related

- Retrieve results, subtitles, clips, Q&A: see the `get-transcript` skill
- REST equivalent of everything here: https://transcribe.so/api/v1/openapi.yaml
- Developer docs: https://transcribe.so/developers/docs
