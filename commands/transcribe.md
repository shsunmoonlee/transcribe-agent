---
description: Transcribe a recording (YouTube/podcast/file URL or local file) via transcribe.so and return the transcript with chapters
argument-hint: <url-or-file-path> [what you want back]
---

Transcribe this recording with the `transcribe-so` MCP server: $ARGUMENTS

Follow the `transcribe-audio` skill: pick the right source (`youtube`,
`platform_url`, `external_url`, or `createUpload` + `upload` for a local
file), call `getQuote` first (it starts nothing; it reports the length, the
detected title and what the job would use from the user's existing
transcribe.so account as `retail_usd`). When `retail_usd` is 0, or within a
limit the user already gave, go ahead; otherwise tell the user the figure and
wait for their go-ahead. Then `transcribe`, then `waitForTranscription` until
done (re-call on
`_timed_out`; for recordings over ~20 minutes give the user the dashboard
link instead of polling indefinitely).

When it completes, return what the user asked for; default to the chapter
list with timestamps and a tight summary of each chapter, and offer
follow-ups (full segments, subtitles via `getSubtitles`, paste-ready
timestamps via `getTranscriptionTimestamps`, cited Q&A via
`askTranscription`).
