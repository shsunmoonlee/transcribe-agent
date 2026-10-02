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
4. Retries: pass `idempotency_key`; without one `transcribe` is not idempotent
   (check `listTranscriptions` before retrying a timed-out call). Keep the
   SAME key unless one of the NEW-key cases below applies:
   - SAME key: a retry with the same arguments replays the first result.
     After `queue_full` or a server error (neither is stored under the key),
     wait `retry_after` seconds first. On `not_ready` the earlier call may
     still be running: keep retrying for up to 5 minutes.
   - NEW key: refusals are replayed under the key for 24 hours too, so a new
     key is needed only after a refusal you actually received that says
     nothing was started, once its cause is fixed (for example
     `insufficient_funds` or `max_charge_exceeded` after the user resolved
     it, or a corrected input), or when `not_ready` persists past those 5
     minutes and the job is not in `listTranscriptions` (match the
     `client_reference` you sent, if any). Changed arguments after such a
     refusal are a new request and take the new key.
   - Key rejected because the arguments differ, and you never got an answer
     to the first call: it may have gone through. Re-send the SAME key with
     the original arguments to get that result back, or check
     `listTranscriptions` / `getTranscription`, before transcribing again;
     never switch keys just to get past that rejection.

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
