# transcribe-agent

Make any agent transcribe. One repo with three ways in: a pure-JSON CLI
(`transcribe-so`), an agent skill for `npx skills add`, and a Claude Code
plugin bundling the transcribe.so remote MCP server.

transcribe.so turns YouTube videos, podcasts, direct media URLs, and local
files into speaker-labelled transcripts with timestamped segments, chapters,
sections, cited Q&A, subtitle files (SRT, VTT, karaoke VTT), full transcript
exports, segment search, and paste-ready captions for Instagram, X, Threads,
LinkedIn, YouTube, Spotify and Apple Podcasts.

## Install

### 1. Agent skill (Claude Code, OpenClaw, any skills.sh-compatible agent)

```bash
npx skills add shsunmoonlee/transcribe-agent
```

This installs [SKILL.md](SKILL.md), which teaches the agent the CLI workflow,
hard rules, and exit codes.

### 2. Claude Code plugin (remote MCP server + skills + /transcribe command)

```
/plugin marketplace add shsunmoonlee/transcribe-agent
/plugin install transcribe-so@transcribe-agent
```

The plugin connects Claude to the remote MCP server at
`https://transcribe.so/mcp` (21 tools) and bundles the `transcribe-audio` and
`get-transcript` skills plus a one-shot `/transcribe` command. First tool call
triggers the OAuth browser flow; alternatively authenticate with a
`tsk_live_*` API key via `/mcp`.

### 3. CLI (any script, cron job, or agent with a shell)

```bash
npm install -g transcribe-so     # or: pnpm install -g transcribe-so
export TRANSCRIBE_API_KEY=tsk_live_...   # https://transcribe.so/settings/api-keys
transcribe-so me
```

## CLI in 30 seconds

```bash
# Price it (free), then transcribe under an explicit budget
transcribe-so quote --source youtube --url "https://www.youtube.com/watch?v=..."
transcribe-so run   --source youtube --url "https://www.youtube.com/watch?v=..." --max-usd 2

# Local file
transcribe-so upload ./interview.mp3         # prints upload_id (+ ffprobe duration)
transcribe-so run --source upload --upload-id <id> --duration <s> --max-usd 5

# Artifacts
transcribe-so result <id> | jq '.chapters[]'
transcribe-so transcript <id> > out.txt                      # the whole transcript, never capped
transcribe-so subtitles <id> --format srt > out.srt
transcribe-so captions <id> --for instagram --variant highlights
transcribe-so search "pricing" | jq -r '.hits[] | "\(.speaker): \(.text)"'
transcribe-so ask <id> -q "What did the guest say about pricing?"
```

## Commands

| Command | What it does |
|---------|--------------|
| `auth:status` | Is `TRANSCRIBE_API_KEY` valid? |
| `me` | Account, wallet balance, plan limits, API-key scopes and spend |
| `capabilities` | One JSON object: account + pipeline catalog + every format enum + exit codes |
| `pipelines` | Per-minute pricing and supported languages |
| `quote` | Free price preview (does not queue anything) |
| `create` | Submit a job. `--max-charge-usd <n>` caps the charge server-side |
| `run` | quote → budget gate → create → wait → result, in one command |
| `wait <id>` | Long-poll to a terminal status |
| `result <id>` | Chapters, sections, Q&A (`--include`, `--segments-offset`, `--segments-limit`) |
| `transcript <id>` | **Raw**: the complete transcript, `txt` or `md`, never capped |
| `subtitles <id>` | **Raw**: SRT / VTT / karaoke VTT / JSON |
| `captions <id> --for <dest>` | **Raw**: paste-ready caption or chapter timestamps per platform |
| `search <q>` | "Who said X, and when", library-wide or `--id`-scoped |
| `ask <id> -q "..."` | Cited Q&A (daily allowance, never the wallet) |
| `list` / `get <id>` | Browse jobs; status/stage/progress snapshot |
| `upload <file>` | Presigned PUT for a local file; prints `upload_id` |
| `retry <id> --yes` | New paid attempt (pass `--max-charge-usd` again) |
| `delete <id> --yes` | Irreversible |

Design contract, made for agents:

- stdout is JSON everywhere except the three raw-output commands —
  `subtitles`, `transcript`, and `captions` (without `--json`) — which print a
  body you can pipe to a file. Errors are always the JSON envelope. All
  progress goes to stderr, so `| jq .` always works.
- Exit codes are meaningful: 0 ok, 1 API error, 2 usage, 3 auth, 4 payment,
  5 transient, 6 local `--max-usd` budget refusal, 7 server-side
  `max_charge_exceeded` (nothing charged, no job started).
- Two budgets, both explicit: `run --max-usd` refuses locally from the free
  quote; `--max-charge-usd` is sent to the API and enforced at the wallet
  hold. `run` sends its `--max-usd` as the server ceiling too unless you pass
  `--no-server-ceiling`.
- `create`/`run`/`quote`/`retry` always send an `Idempotency-Key`. Pass
  `--idempotency-key` explicitly to make a retry safe across processes — the
  auto-generated one is per invocation, so re-running a command is a second
  key and a second charge.
- A 409 `not_ready` is acted on by its `reason`: only
  `transcription_processing` is ever retried.
- The CLI refuses to send your API key to a non-default host unless you pass
  `--allow-custom-host`.

Full command reference and workflow rules: [SKILL.md](SKILL.md). Release
notes: [CHANGELOG.md](CHANGELOG.md). Worked examples:
[examples/](examples/).

## Pricing

Transcription is billed per minute from your transcribe.so wallet; quotes are
free (`quote` before committing). Clip renders are $0.05 per started 60 s.
Live Q&A uses a daily allowance, never the wallet. Details:
<https://transcribe.so/pricing>

## Privacy Policy

This tooling sends the media URLs, uploaded files, and questions you provide
to transcribe.so for processing. See the transcribe.so privacy policy at
<https://transcribe.so/privacy-policy> for data collection, usage, storage,
retention, and contact information. No data is collected by the CLI or plugin
itself beyond what the API and MCP tools transmit.

## Links

- Agent landing page: <https://transcribe.so/agent>
- Docs: <https://transcribe.so/developers/docs>
- OpenAPI: <https://transcribe.so/openapi.json>
- MCP server card: <https://transcribe.so/.well-known/mcp/server-card.json>
- Auth guide: <https://transcribe.so/auth.md>
- Support: support@transcribe.so
