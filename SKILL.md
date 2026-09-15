---
name: transcribe-so
description: Transcribe audio and video with the transcribe.so CLI. Turns YouTube videos, podcasts (Apple Podcasts, Spotify, SoundCloud, Vimeo, Twitch, Loom), direct media URLs, and local audio or video files into speaker-labelled transcripts with timestamped segments, chapters, sections, cited Q&A, subtitle files (SRT, VTT, karaoke VTT), full transcript exports, segment search ("who said X, and when"), and paste-ready captions for Instagram, X, Threads, LinkedIn, YouTube, Spotify and Apple Podcasts. Use when the user wants a transcript, show notes, chapters, subtitles, captions, quotes, or answers grounded in a recording. 52 languages and dialects.
homepage: https://transcribe.so/agent
metadata: {"openclaw":{"emoji":"🎙️","requires":{"bins":["transcribe-so"],"env":["TRANSCRIBE_API_KEY"]}}}
---

## Install transcribe-so if it doesn't exist

```bash
npm install -g transcribe-so
# or
pnpm install -g transcribe-so
```

npm package: https://www.npmjs.com/package/transcribe-so
github: https://github.com/shsunmoonlee/transcribe-agent
official website: https://transcribe.so

---

| Property | Value |
|----------|-------|
| **name** | transcribe-so |
| **description** | Speech-to-text CLI: media in, speaker-labelled transcript + chapters + cited Q&A out |
| **allowed-tools** | Bash(transcribe-so:*) |

---

## Hard Rules (Read First)

**Rule 0 - Money.** Check the price before creating a job; stay within the user's authorized budget; ask before exceeding it or starting another paid attempt. `quote` is free and tells you the price. `--max-charge-usd` makes the ceiling binding server-side. After a refusal, report the real price and ask - never raise a ceiling on your own, and never re-run `retry` to "see if it works".

**Rule 1 - Quote before create.** `quote` is free; `create` charges the wallet. Show the user the price for anything non-trivial. The quote's `transcription_id` is NOT the job id - never pass it to `wait` or `result`. Only the id in the `create` (or `run`) 202 response is the job.

**Rule 2 - Local files go through `upload` first.** `create` never accepts a filesystem path. Run `transcribe-so upload <file>`, then pass the returned `upload_id` plus `--duration` with `--source upload`. URL sources (`youtube`, `platform_url`, `external_url`) must be publicly fetchable without auth.

**Rule 3 - `status: "queued"` on create is SUCCESS, not an error.** It means the account's concurrency cap is reached and the job waits FIFO for a slot. Never re-submit a queued job. A GET showing `quoted` is different: that row is a quote that was never started (see Rule 1) and will never progress. Exception: `source=upload` is REJECTED at the cap with a fair-use error instead of being queued - wait for a running job to finish; do not hammer retry.

**Rule 4 - Never hand-roll polling.** Use `wait <id>` or `run`; they drive the server's long-poll endpoint in capped windows. A `waiting for a concurrency slot` line on stderr is normal.

**Rule 5 - stdout is JSON everywhere except three raw-output commands.** `subtitles`, `transcript`, and `captions` (without `--json`) print a raw body so it can be piped to a file; every other command prints one JSON document, and so does every error from every command. All progress and chatter goes to stderr, so `| jq .` always works on the JSON commands and `> file` always works on the raw ones.

**Rule 6 - `delete` and `retry` require `--yes`.** Deletion is irreversible (row, derived data, stored media). Retry re-charges from scratch; the original failed charge is not refunded. A retry is a NEW paid attempt: pass `--max-charge-usd` again, because the create call's ceiling does not carry over.

**Rule 7 - Know which budget you hit.** Transcription bills per minute from the wallet; `ask` uses a daily Q&A allowance (never the wallet); `me` shows the balance. Exit 4 means the account needs funds (top up or raise the key's spend cap). Exit 6 means the CLI's own `--max-usd` refused before anything was sent - raise `--max-usd`, do NOT top up. Exit 7 means the SERVER refused against `--max-charge-usd`: nothing was held or charged and no job started, so the account is fine - report the real price (`error.charge_usd`) and ask.

**Rule 8 - A 409 `not_ready` carries a `reason`, and only ONE of them resolves by waiting.** `transcription_processing` -> wait (`transcript --wait-seconds N` does this for you, honouring `Retry-After`). `transcription_failed` / `transcription_cancelled` -> terminal, there is nothing to wait for. `not_started` -> the row is a quote that was never started. `artifact_missing` -> completed but the artifact was never generated; for `captions` the fix is ONE `POST /timestamps/regenerate` (`--regenerate`), and for `transcript` nothing helps. Never poll a reason that is not `transcription_processing`.

**Rule 9 - A windowed transcript is not the transcript.** `result --include segments` returns one window and a `segments_meta {offset, limit, total, has_more}`. If `has_more` is true you are holding a PARTIAL transcript - page with `--segments-offset`, or use `transcript <id>`, which returns every segment and is never capped.

---

## Authentication

```bash
export TRANSCRIBE_API_KEY=tsk_live_...   # https://transcribe.so/settings/api-keys
transcribe-so auth:status
```

New accounts start with free credit. The CLI refuses to send the key to a non-default or non-https `TRANSCRIBE_API_URL` unless `--allow-custom-host` is passed.

## Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | success | parse stdout |
| 1 | API or generic error (including `not_ready`, `qna_quota_exceeded`) | read `error.code`, then `error.reason` for `not_ready` (Rule 8); a used-up Q&A allowance frees on a rolling 24h window |
| 2 | usage error / custom-host refusal | fix the flags |
| 3 | auth (401, `scope_forbidden`, missing key) | check TRANSCRIBE_API_KEY and its scopes |
| 4 | payment (`insufficient_funds`, `spend_cap_exceeded`) | top up or raise the key's cap |
| 5 | transient (rate limit, wait timeout, 5xx) | retry later; per-minute rate limits are already auto-retried with Retry-After |
| 6 | local budget refusal (`max_usd_exceeded`) | the free quote exceeded `--max-usd`; nothing was sent. Raise `--max-usd`; do not top up |
| 7 | server charge ceiling (`max_charge_exceeded`) | the API refused `--max-charge-usd` before any hold; nothing charged, no job. Report `error.charge_usd` and ask - do not raise the ceiling yourself |

Non-2xx API responses print the API's JSON error envelope verbatim on stdout: `{"error": {"code", "message", "request_id", "doc_url"}}` - plus `reason` on `not_ready`, and `charge_usd` / `max_charge_usd` on `max_charge_exceeded`. Codes 0-6 are unchanged from 0.1.x; 7 is new in 0.2.0.

## Core Workflow

```bash
# 1. Check auth and balance
transcribe-so me | jq '{email, wallet_balance_usd}'

# 2. Price it (free)
transcribe-so quote --source youtube --url "https://www.youtube.com/watch?v=..." | jq .retail_usd

# 3. One command end to end (quote -> budget gate -> create -> wait -> result)
transcribe-so run --source youtube --url "https://www.youtube.com/watch?v=..." --max-usd 2

# Or step by step:
ID=$(transcribe-so create --source youtube --url "https://..." | jq -r .id)
transcribe-so wait "$ID"
transcribe-so result "$ID" | jq '.chapters[] | {title, start_seconds, url}'
```

`run` requires an explicit `--max-usd` budget; there is no default. The request body the CLI sends for a YouTube job looks like [examples/youtube.json](examples/youtube.json).

## Essential Commands

```bash
transcribe-so auth:status                      # is the key valid?
transcribe-so me                               # account, wallet, limits, key scopes
transcribe-so pipelines                        # per-minute pricing + supported languages
transcribe-so quote --source ... --url ...     # free price preview
transcribe-so create --source ... --url ...    # submit (202: {id, retail_usd, ...})
transcribe-so wait <id> [--timeout 1800]       # long-poll to terminal state
transcribe-so result <id> [--include all]      # chapters,sections,qna by default
transcribe-so run --source ... --max-usd <n>   # the whole flow, budget-gated
transcribe-so list [--limit 50] [--api-only]   # newest first, cursor-paginated
transcribe-so get <id>                         # status/stage/progress snapshot
transcribe-so upload <file> [--duration <s>]   # presigned PUT; prints upload_id
transcribe-so subtitles <id> [--format srt]    # RAW body to stdout (pipe to file)
transcribe-so transcript <id> [--format md]    # RAW full transcript, never capped
transcribe-so captions <id> --for instagram    # RAW paste-ready caption (--json for the envelope)
transcribe-so search "<q>" [--id <id>]         # who said X, and when
transcribe-so capabilities                     # account + pipelines + every enum, one JSON object
transcribe-so ask <id> -q "..."                # cited Q&A (daily allowance)
transcribe-so delete <id> --yes                # irreversible
transcribe-so retry <id> --yes --max-charge-usd <n>   # re-charges from scratch
```

Budget flags: `run --max-usd <n>` is LOCAL (the free quote is checked before anything is created; exit 6). `--max-charge-usd <n>` on `create` / `run` / `retry` is the SERVER ceiling, enforced at the wallet hold (exit 7). `run` sends its `--max-usd` as the server ceiling too, unless you pass `--no-server-ceiling`. A plan-covered job is charged $0 and passes any ceiling, including `0`.

Sources: `--source youtube|platform_url|external_url|upload`. `youtube` for any youtube.com or youtu.be URL; `platform_url` for hosted pages (Apple Podcasts, Spotify episodes, SoundCloud, Vimeo, Twitch VODs, Loom); `external_url` for direct public media URLs; `upload` for files sent with `upload` (needs `--upload-id` and `--duration`).

## Recipes by intent

Six things people actually ask for. Pick by intent, not by endpoint.

**1. "Transcribe this."** Price it, then run it under a budget that is enforced on both sides.

```bash
transcribe-so quote --source youtube --url "$URL" | jq '{billed_minutes, retail_usd}'
transcribe-so run --source youtube --url "$URL" --max-usd 2     # also sent as max_charge_usd
```

**2. "Give me the transcript."** Not `result --include segments` (that is one window) - `transcript`, which is never capped.

```bash
transcribe-so transcript "$ID" > talk.txt                        # plain text
transcribe-so transcript "$ID" --format md --out talk.md         # title + chapters + turns
transcribe-so transcript "$ID" --no-timestamps --no-speaker-labels   # prose only
transcribe-so transcript "$ID" --wait-seconds 300                # if it may still be processing
```

**3. "Who said X, and when?"** Segment search, library-wide or scoped. Each hit carries its own speaker and a deep link. Full script: [examples/who-said-what.sh](examples/who-said-what.sh).

```bash
transcribe-so search "pricing" --limit 20 \
  | jq -r '.hits[] | "\(.speaker // "unknown") @\(.start_ms/1000|floor)s: \(.text)\n  \(.url)"'
transcribe-so search "pricing" --id "$ID"     # within one transcription
```

Speaker labels are RECORDING-LOCAL: `SPEAKER_00` in one transcription is not the same person as `SPEAKER_00` in another, and `null` means unknown. Say "unknown speaker" rather than attributing the line.

**4. "Write the Instagram caption / YouTube chapters / LinkedIn post."** One command per destination. Full script: [examples/ig-caption.sh](examples/ig-caption.sh).

```bash
transcribe-so captions "$ID" --for youtube                       # chapter list, paste-ready
transcribe-so captions "$ID" --for instagram --variant highlights
transcribe-so captions "$ID" --for linkedin                      # one 3,000-char post, no links
transcribe-so captions "$ID" --for x --variant quoted_sections --json | jq -r '.thread[]'
```

Destinations: `instagram` (maps to the API's `instagram_caption`), `x`, `threads`, `linkedin`, `youtube`, `spotify`, `apple_podcasts`, `markdown`, `plain`. Variants: `standard` (chapter list), `highlights` (5-item text outline), `clips` (3 video ideas), `quoted_sections` (verbatim pull quotes), `show_notes`, `original`. `--cta` adds the transcribe.so footer and is OFF by default - the caption belongs to the user. Warnings print on stderr; surface them, because a silently shortened quote is a misquote. `artifact_missing` -> re-run with `--regenerate` (one 30-90s regeneration, then it retries).

**5. "Subtitles for this video."**

```bash
transcribe-so subtitles "$ID" --format srt > talk.srt
transcribe-so subtitles "$ID" --format vtt --preset tiktok-shorts > clip.vtt
```

**6. "What did they say about X?"** Cited Q&A - read the free cached pairs first.

```bash
transcribe-so result "$ID" --include qna | jq '.qna'   # free, already generated
transcribe-so ask "$ID" -q "What did the guest say about pricing?"   # daily allowance
```

**Don't know what the account or the CLI supports?** One call, no guessing:

```bash
transcribe-so capabilities | jq '{wallet: .account.wallet_balance_usd, captions: .formats.captions}'
```

## Common Patterns

**Local file, start to finish** - full walk-through in [examples/upload-flow.md](examples/upload-flow.md):

```bash
UP=$(transcribe-so upload ./interview.mp3)   # duration probed with ffprobe if installed
transcribe-so run --source upload \
  --upload-id "$(echo "$UP" | jq -r .upload_id)" \
  --duration  "$(echo "$UP" | jq -r .duration_seconds)" \
  --max-usd 5
```

**Batch a folder** - see [examples/batch-transcribe.sh](examples/batch-transcribe.sh). Submit sequentially and let the server queue at the concurrency cap; remember Rule 3's upload exception.

**Podcast to chapters/show notes:**

```bash
transcribe-so run --source platform_url --url "https://podcasts.apple.com/..." --max-usd 3 \
  | jq -r '.chapters[] | "\(.start_seconds | floor)s  \(.title)"'
```

**Watch-folder heartbeat (OpenClaw)** - [examples/heartbeat-openclaw.json](examples/heartbeat-openclaw.json) runs the batch script on a schedule so anything dropped into a folder gets transcribed.

**Subtitles for vertical video:**

```bash
transcribe-so subtitles "$ID" --format vtt --preset tiktok-shorts > clip.vtt
```

**Fire-and-forget with a webhook** - pass `--callback-url https://your-endpoint` to `create`; the 202's `callback.secret` is the HMAC key for the signed `transcription.completed` / `transcription.failed` POST. No polling needed.

## Gotchas

- The quote's `transcription_id` is not the job id (Rule 1). `run` handles this for you.
- `create` responses are slim 202 acks; `billed_minutes` and `retail_usd` appear there but NOT on later GETs.
- `result` has no single full-text field: for the whole transcript use `transcript <id>`. `--include segments` returns ONE window plus `segments_meta`; check `has_more` before treating it as complete (Rule 9), and page with `--segments-offset` / `--segments-limit`.
- `--include segments` can be large; the default `chapters,sections,qna` is usually what you want.
- Chapters, sections, and citations carry a pre-computed `url` deep link - use it VERBATIM; never rebuild timestamp URLs yourself.
- `ask` needs `status=completed` (409 `not_ready` otherwise) and consumes the daily allowance; cached pairs via `result --include qna` are free - read those first.
- Uploads over 50 MB warn (single-shot presigned PUT, 900s expiry); over 500 MB the CLI refuses and points at the resumable tus flow or the web app.
- Rate limit is 60 requests/min per key, shared with the MCP server. Per-minute limits auto-retry; fair-use and allowance exhaustion never do.
- `search` never returns a count: `total` is always `null` by design. Page on `has_more`; `offset` is capped at 1000, so narrow the query or pass `--id` instead of deep-paging.
- `--idempotency-key` is what makes a retry safe ACROSS PROCESSES. The CLI auto-generates a fresh UUID per invocation, which protects a retry inside one run but NOT a re-run of the same command: that is a second key and therefore a second charge. If a `create` or `run` dies without printing an id (network drop, killed shell, timeout), re-run it with the SAME explicit `--idempotency-key` and the API returns the original job instead of creating and charging a new one. Pick the key before the first attempt; it is your only handle on an in-flight charge.

## Quick Reference

| Task | Command |
|------|---------|
| Price a video | `quote --source youtube --url <u>` |
| Transcribe under budget | `run --source youtube --url <u> --max-usd 2` |
| Hard server-side cap | `create --source youtube --url <u> --max-charge-usd 2` (exit 7 if higher) |
| Full text | `transcript <id> > out.txt` (never capped) |
| Markdown export | `transcript <id> --format md --out out.md` |
| Chapter list | `result <id> \| jq '.chapters[] \| {title, start_seconds}'` |
| Paste-ready chapters | `captions <id> --for youtube` |
| IG caption | `captions <id> --for instagram --variant highlights` |
| Who said X | `search "x" \| jq -r '.hits[] \| "\(.speaker): \(.text)"'` |
| SRT file | `subtitles <id> > out.srt` |
| Cited answer | `ask <id> -q "..."` |
| What can I ask for? | `capabilities` |
| Local file | `upload <file>` then `run --source upload --upload-id ... --duration ...` |

Also available as a remote MCP server (https://transcribe.so/mcp) and a Claude Code plugin (`/plugin marketplace add shsunmoonlee/transcribe-agent`, then `/plugin install transcribe-so@transcribe-agent`). REST reference: https://transcribe.so/openapi.json and https://transcribe.so/developers/docs.
