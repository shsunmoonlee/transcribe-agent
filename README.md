# transcribe.so plugin for Claude Code

Transcribe audio and video into speaker-labelled transcripts — with chapters,
cited Q&A, word-level timings, subtitle files, and hosted captioned clips —
straight from Claude Code or Cowork.

## What's inside

- **Remote MCP server** (`https://transcribe.so/mcp`, streamable HTTP): 21
  tools covering quote → transcribe → wait → results, plus search, subtitles,
  word timings, clip rendering, and cited Q&A over your library.
- **Skills**: `transcribe-audio` (submitting jobs) and `get-transcript`
  (reading results and derived artifacts) so Claude knows the right flow
  without trial and error.
- **`/transcribe` command**: one-shot "transcribe this URL/file and give me
  chapters".

## Install

```
/plugin install transcribe-so@claude-plugins-official
```

or from this repo directly:

```
/plugin marketplace add shsunmoonlee/transcribe-so-claude-plugin
/plugin install transcribe-so
```

## Authentication

First tool call triggers the OAuth browser flow (sign in or create a
transcribe.so account — new accounts start with free credit). Alternatively
create a `tsk_live_*` API key at <https://transcribe.so/settings/api-keys>
and authenticate with `/mcp`.

## Pricing

Transcription is billed per minute from your transcribe.so wallet; quotes are
free (`getQuote` before committing). Clip renders are $0.05 per started 60 s.
Live Q&A uses a daily allowance, never the wallet. Details:
<https://transcribe.so/pricing>

## Privacy Policy

This plugin sends the media URLs, uploaded files, and questions you provide
to transcribe.so for processing. See the transcribe.so privacy policy at
<https://transcribe.so/privacy> for data collection, usage, storage,
retention, and contact information. No data is collected by the plugin
itself beyond what the MCP tools transmit.

- Docs: <https://transcribe.so/developers/docs>
- Auth guide: <https://transcribe.so/auth.md>
- Support: support@transcribe.so
