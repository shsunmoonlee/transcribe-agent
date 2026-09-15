#!/usr/bin/env bash
# "Who said X, and when" across every completed transcription in the library.
# Usage: ./who-said-what.sh "<query>" [transcription-id]
# Requires: transcribe-so on PATH, TRANSCRIBE_API_KEY exported, jq.
#
# Each hit is the SEGMENT containing the match, with its own speaker label and
# a deep-link url, so a quote is attributed to the line it came from rather
# than to the recording as a whole.

set -euo pipefail

QUERY="${1:?usage: who-said-what.sh \"<query>\" [transcription-id]}"
ID="${2:-}"

# Speaker labels are RECORDING-LOCAL: "SPEAKER_00" in one transcription is not
# the same person as "SPEAKER_00" in another, and null means unknown. Say
# "unknown speaker" rather than attributing the line.
fmt='.hits[] | "\(.transcription_id)  \(.start_ms/1000 | floor)s  \(.speaker // "unknown"): \(.text)\n  \(.url)"'

if [ -n "$ID" ]; then
  transcribe-so search "$QUERY" --id "$ID" --limit 20 | jq -r "$fmt"
else
  transcribe-so search "$QUERY" --limit 20 | jq -r "$fmt"
fi

# Paging: there is no total count on purpose (counting every match is the
# expensive half of the query). Page on has_more:
#
#   transcribe-so search "$QUERY" --limit 20 --offset 20
#
# offset is capped at 1000 — narrow the query or pass --id instead of deep
# paging. For the full text of one recording, `transcribe-so transcript <id>`
# returns every segment and is never capped.
