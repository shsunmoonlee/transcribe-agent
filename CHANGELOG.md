# Changelog

All notable changes to the `transcribe-so` CLI.

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
  that one `POST /timestamps/regenerate` for you and retries.
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
