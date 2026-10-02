# Changelog

All notable changes to the `transcribe-so` CLI (0.x) and to the plugin
manifests (1.x, tracking the MCP server version).

## Plugin 1.7.0

Plugin manifests and skills only; the CLI stays at 0.2.0. Tracks MCP server
1.7.0.

### Changed

- `skills/get-transcript`, Clips: call the new read tool `getClipQuote` for
  the range first, tell the user its `charge_usd` and wait for a go-ahead
  (unless it is within a limit the user already gave), then pass the agreed
  figure to `renderClip` as `max_charge_usd`. On `max_charge_exceeded` nothing
  is held or rendered: report the figure and ask, never raise the ceiling.
- Codex `commerce_description` now covers clips (`getClipQuote` preview and
  the `renderClip` ceiling).
- README: the MCP tool count is corrected to 24 (it said 21).
- Narrowed `idempotency_key` guidance for `transcribe` and `renderClip` in
  both skills: use a new key only after a refusal where nothing was started
  or drawn and the user has resolved it; if the same key is rejected because
  the arguments differ, the first call may have gone through, so re-send the
  same key with the original arguments or check the job or clip first.
- Every plugin manifest is 1.7.0; the Codex release notes name MCP server
  1.7.0 and the clip preview.
- `scripts/check-api-coverage.ts`: `getClipQuote` added to the skip list with
  the other clip operations (no CLI clip commands yet).

## Plugin 1.6.1

Plugin manifests only (`.codex-plugin`, `.claude-plugin`, `.cursor-plugin`,
`.grok-plugin`, `gemini-extension.json`); the CLI stays at 0.2.0.

### Changed

- Directory-safe copy in `skills/transcribe-audio`, `skills/get-transcript`
  and `commands/transcribe.md`: the model-readable text describes what
  `getQuote` reports and that the agent waits for the user's go-ahead; it
  carries no money, promotion or account-tier wording and no em-dashes. The
  skills are based on the copy OpenAI's directory scan accepted, with factual
  corrections: `getTranscript` inline truncation (`truncated`,
  `download_url`), `idempotency_key` on `transcribe` and `renderClip`,
  `artifact_missing` as a `not_ready` reason, and the approval rule (go ahead
  when `retail_usd` is 0 or within a limit the user already gave, otherwise
  ask first).
- Plugin versions now track the MCP server version (1.6.1) in every manifest
  instead of a separate 1.x line.

### Added

- `.codex-plugin/plugin.json`: Codex listing block (`interface`) and review
  metadata (`extensions.com.openai.review` test cases, commerce declaration,
  `extensions.com.openai.publication.release_notes`). The demo recording URL
  is injected at build time, never committed.
- `scripts/build-openai-plugin.mjs` (`pnpm run build:openai-plugin`): builds
  the OpenAI directory submission ZIP into `out/` and fails on listing-tier
  copy violations. See README, "Directories".

## 0.2.0

Targets transcribe.so API 1.1.0.

### Added

- **`transcript <id>`** — the COMPLETE transcript as a raw body, never capped
  (`--format txt|md`, `--no-speaker-labels`, `--no-timestamps`, `--out FILE`).
  A 409 `not_ready` is acted on by its `reason`: only
  `transcription_processing` is retried (honouring `Retry-After`, bounded by
  `--wait-seconds`, default `0` = no waiting). Every other reason exits
  non-zero immediately with the recovery on stderr, because retrying it can
  never succeed.
- **`captions <id> --for <destination>`** — paste-ready captions and chapter
  timestamps. Destinations: `instagram`, `x`, `threads`, `linkedin`,
  `youtube`, `spotify`, `apple_podcasts`, `markdown`, `plain`. Variants:
  `standard`, `highlights`, `clips`, `quoted_sections`, `show_notes`,
  `original`. `--cta` appends the transcribe.so footer (off by default — the
  caption belongs to the user). Prints the text raw; `--json` prints the full
  envelope (`warnings`, `ok_to_paste`, `thread[]`, `constraints`). On
  `artifact_missing` it prints the exact recovery, and `--regenerate` runs
  that one `POST /timestamps/regenerate` for you and retries. `--regenerate`
  is not side-effect free: it regenerates and REPLACES all four cached
  caption/chapter variants and burns 1 of the 10 regenerations allowed per
  transcription. Once those are gone the API answers 429 `rate_limited` with
  no `Retry-After`, which the CLI maps to exit 1 (not the transient exit 5),
  because only a re-transcribe resets the count.
- **`search <q> [--id <id>] [--limit N] [--offset N]`** — "who said X, and
  when" across the library, or scoped to one transcription. Hits carry
  `speaker`, `start_ms`, `end_ms` and a deep-link `url`.
- **`capabilities`** — one JSON object: live `/me` and `/pipelines`, the API
  version from the spec, every format enum this CLI accepts, and the exit-code
  table. No guessing flag values.
- **`--max-charge-usd <n>`** on `create`, `run` and `retry` — a server-side
  charge ceiling (`max_charge_usd`) enforced at the wallet hold. `run` sends
  its `--max-usd` as the ceiling by default; `--no-server-ceiling` opts out.
  A retry is a new paid attempt with its own hold, so the ceiling has to be
  sent again there.
- **Exit code 7** for 402 `max_charge_exceeded` — distinct from 4 (the account
  cannot pay) and from 6 (the local `--max-usd` refusal). Nothing was charged
  and no job was started; the remedy is to report the real price, not to top
  up. Exit codes 0-6 are unchanged.
- **`--segments-offset` / `--segments-limit`** on `result` and `wait`, with
  `segments_meta` surfaced on stderr. A windowed transcript now says so
  instead of looking complete.
- Examples: [`examples/ig-caption.sh`](examples/ig-caption.sh),
  [`examples/who-said-what.sh`](examples/who-said-what.sh).
- `pnpm run test` — unit tests for the mapping/parsing helpers.
- Multi-runtime manifests so the same repo installs outside Claude Code:
  `.cursor-plugin/plugin.json` (Cursor plugin: both skills plus the hosted MCP
  server) and `gemini-extension.json` (Gemini CLI extension bundling
  `https://transcribe.so/mcp`). The README Install section now leads with
  per-runtime instructions for Claude Code, Codex, Cursor, Gemini CLI, ChatGPT,
  and any skills.sh agent.

### Changed

- stdout is JSON everywhere except the three raw-output commands:
  `subtitles`, `transcript`, and `captions` (without `--json`).
- `not_ready` hints now name the specific `reason` and its recovery instead of
  always suggesting `wait`.
- API coverage gate: `transcript`, `search` (both routes), `timestamps` and
  `timestamps/regenerate` moved from the skip list to covered.

## 0.1.0

Initial release: `auth:status`, `me`, `pipelines`, `quote`, `create`, `wait`,
`result`, `run`, `list`, `get`, `delete`, `retry`, `upload`, `subtitles`,
`ask`.
