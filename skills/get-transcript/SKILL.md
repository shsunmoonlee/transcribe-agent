---
name: get-transcript
description: "Retrieve a finished transcription from transcribe.so: chapters, sections, cited Q&A, speaker-labelled timestamped segments, word-level timings, subtitle files (SRT/VTT/karaoke), paste-ready timestamps, hosted captioned MP4 clips, and live cited Q&A over one transcription or the whole library. Use when the user asks for a transcript, subtitles, show notes, quotes, clips, or answers grounded in their recordings."
---

# Get a transcript and derived artifacts

All tools below live on the bundled `transcribe-so` MCP server. They work for
jobs submitted from this plugin, the REST API, or the transcribe.so web app —
same library everywhere.

## Reading results

- `getTranscriptionResult` — the main read. `include` defaults to
  `chapters,sections,qna`; add `segments` (speaker-labelled
  `{start_seconds, end_seconds, speaker, text}`), `acts`, `posting_chapters`,
  or `all`. There is no single full-text field: join segments (or sections).
- `waitForTranscription` — long-poll a running job (~90 s per call;
  `_timed_out: true` = call again).
- `search` — keyword search over titles and transcript text across the
  user's library; `fetch` — one transcription as plain text.
- `getTranscriptionTimestamps` — paste-ready chapter timestamps (formats:
  youtube, spotify, apple_podcasts, markdown, x, threads, instagram_caption,
  plain; variants: standard, highlights, clips, quoted_sections, show_notes).
- `getTranscriptionWords` — paginated word-level timings in ms (limit up to
  2000/page; check `available` — `no_word_timestamps` means sentence-level
  only). For karaoke captions and overlays, not for reading.
- `getSubtitles` — SRT / VTT / karaoke VTT / JSON subtitle file (`content`
  inline up to 60k chars, `download_url` beyond; presets: youtube,
  tiktok-shorts, instagram-reels, netflix, podcast, broadcast).

## Clips (paid)

- `renderClip` — hosted captioned MP4 of a 1-60 s range of a completed
  transcription with word timestamps. Flat $0.05 per started 60 s from the
  account wallet. NOT idempotent — check `getClip` before retrying.
- `getClip` — pass `wait_seconds` (up to 45) to long-poll; `completed`
  carries a presigned `mp4_url` valid one hour (call again for a fresh one).
  Renders take several times the clip length — expect multiple calls.

## Live Q&A (daily allowance, never the wallet)

- `askTranscription` (one transcription) and `askLibrary` (whole library or
  up to 50 ids) return a markdown `answer` with `[N]` markers plus
  `citations[]` carrying deep-link `url` + `start_seconds` — render those.
  Each call takes ~10 s and consumes the account's daily Q&A allowance;
  `no_answer: true` costs nothing. Cached pairs from
  `getTranscriptionResult include=["qna"]` are always free — read those first.

## Authentication

OAuth 2.0 (automatic browser flow) or a `tsk_live_*` API key as Bearer.
Guide: https://transcribe.so/auth.md

## Related

- Submit new jobs: see the `transcribe-audio` skill
- CLI alternative for shell workflows (`transcribe-so result/subtitles/ask`):
  `npm install -g transcribe-so`; see the root SKILL.md of
  https://github.com/shsunmoonlee/transcribe-agent
- REST shapes: https://transcribe.so/api/v1/openapi.yaml
