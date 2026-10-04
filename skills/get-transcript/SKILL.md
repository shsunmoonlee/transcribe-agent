---
name: get-transcript
description: "Retrieve a finished transcription from transcribe.so: chapters, sections, cited Q&A, speaker-labelled timestamped segments, word-level timings, subtitle files (SRT/VTT/karaoke), paste-ready timestamps, hosted captioned MP4 clips, and live cited Q&A over one transcription or the whole library. Use when the user asks for a transcript, subtitles, show notes, quotes, clips, or answers grounded in their recordings."
---

# Get a transcript and derived artifacts

All tools below live on the bundled `transcribe-so` MCP server. They work for
jobs submitted from this plugin, the REST API, or the transcribe.so web app:
same library everywhere.

## Reading results

- `getTranscriptionResult`: the main read. `include` defaults to
  `chapters,sections,qna`; add `segments` (speaker-labelled
  `{start_seconds, end_seconds, speaker, text}`), `acts`, `posting_chapters`,
  or `all`. There is no single full-text field: join segments (or sections).
- `waitForTranscription`: long-poll a running job (~90 s per call;
  `_timed_out: true` = call again).
- `search`: keyword search over titles and transcript text across the
  user's library; `fetch`: one transcription as plain text.
- `searchSegments`: "who said X, and when": each hit is the SEGMENT, with its
  own speaker label, `start_ms`/`end_ms` and a deep-link `url`. Speaker labels
  are recording-local and `null` means unknown; never attribute a `null` line.
- `getTranscript`: the transcript as one text body (`txt` or `md`), built
  from every segment; the source is never capped. The inline `content` is cut
  at this tool's response budget: when `truncated` is true it is a prefix and
  only `download_url` is complete. Use this for full text, not a windowed
  `segments` read.
- `getTranscriptionTimestamps`: paste-ready chapter timestamps (formats:
  youtube, spotify, apple_podcasts, markdown, x, threads, instagram_caption,
  linkedin, plain; variants: standard, highlights, clips, quoted_sections,
  show_notes, original). `cta` is opt-in and off by default. `not_ready` with
  `reason: "artifact_missing"` is fixed by ONE `regeneratePostingChapters`
  call.
- `getTranscriptionWords`: paginated word-level timings in ms (limit up to
  2000/page; check `available`; `no_word_timestamps` means sentence-level
  only). For karaoke captions and overlays, not for reading.
- `getSubtitles`: SRT / VTT / karaoke VTT / JSON subtitle file (`content`
  inline up to 60k chars, `download_url` beyond; presets: youtube,
  tiktok-shorts, instagram-reels, netflix, podcast, broadcast).

## Clips

- `getClipQuote`: preview before rendering. Pass `transcription_id`,
  `start_seconds` and `end_seconds`; it renders nothing and writes nothing,
  and returns `charge_usd` (what `renderClip` would use from the user's
  existing transcribe.so account for that range) plus the normalized range and
  `clip_seconds`. It runs the same range checks as `renderClip`, so it doubles
  as a dry run. It does not check what the account can cover or how many
  clips are already rendering; `renderClip` enforces those when it runs.
- `renderClip`: hosted captioned MP4 of a 1-60 s range of a completed
  transcription with word timestamps. A clip always uses the account, so
  first call `getClipQuote` for the same range, tell the user its
  `charge_usd` and wait for a go-ahead, unless it is within a limit the user
  already gave. Pass the agreed figure as `max_charge_usd`. If the real
  figure is higher the call is refused with `max_charge_exceeded` before
  anything is held and nothing is rendered: report the figure and ask; do not
  raise the ceiling yourself.
  Retries: pass `idempotency_key`; without one `renderClip` is not idempotent
  (check `getClip` before retrying a timed-out call). Keep the SAME key
  unless the NEW-key case below applies:
  - SAME key: a retry with the same arguments replays the first result. A
    `not_ready` saying a request with this key is already in flight also
    keeps the same key, and so does one saying the earlier request just
    completed with an error (nothing was recorded). If the in-flight answer
    carries `stale: true` (no result recorded after 120 seconds), a clip may
    already have been rendered and drawn: do not send a new key on your own;
    tell the user.
  - NEW key: refusals are replayed under the key for 24 hours too, so a new
    key is needed only after a refusal you actually received that says
    nothing was drawn, once its cause is fixed (for example
    `max_charge_exceeded` or `insufficient_funds` after the user resolved it,
    `not_ready` once the transcription has completed, `rate_limited` once
    clips in flight have finished; check with `getClip`). Changed arguments
    after such a refusal are a new request and take the new key.
  - Key rejected because the arguments differ, and you never got an answer to
    the first call: it may have gone through. Re-send the SAME key with the
    original arguments, or check `getClip`, before rendering again; never
    switch keys just to get past that rejection.
- `getClip`: pass `wait_seconds` (up to 45) to long-poll; `completed`
  carries a presigned `mp4_url` valid one hour (call again for a fresh one).
  Renders take several times the clip length; expect multiple calls.

## Live Q&A (daily allowance)

- `askTranscription` (one transcription) and `askLibrary` (whole library or
  up to 50 ids) return a markdown `answer` with `[N]` markers plus
  `citations[]` carrying deep-link `url` + `start_seconds`; render those.
  Each call takes ~10 s and consumes the account's daily Q&A allowance;
  `no_answer: true` consumes nothing. Cached pairs from
  `getTranscriptionResult include=["qna"]` do not consume the allowance; read
  those first.

## Authentication

OAuth 2.0 (automatic browser flow) or a `tsk_live_*` API key as Bearer.
Guide: https://transcribe.so/auth.md

## Related

- Submit new jobs: see the `transcribe-audio` skill
- REST shapes: https://transcribe.so/api/v1/openapi.yaml
