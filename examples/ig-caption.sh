#!/usr/bin/env bash
# Instagram caption from a finished transcription.
# Usage: ./ig-caption.sh <transcription-id> [variant]
# Requires: transcribe-so on PATH, TRANSCRIBE_API_KEY exported.
#
# `captions` prints the caption text RAW (like `subtitles` and `transcript`),
# so it pipes straight to a file. Warnings go to stderr — read them: a
# silently shortened quote is a misquote.

set -euo pipefail

ID="${1:?usage: ig-caption.sh <transcription-id> [variant]}"
# highlights = a 5-item text outline, the right shape for an IG caption.
# clips = 3 video clip ideas; quoted_sections = verbatim pull quotes.
VARIANT="${2:-highlights}"

# instagram maps to the API's `instagram_caption` format: no URLs, because
# Instagram does not make them clickable.
transcribe-so captions "$ID" --for instagram --variant "$VARIANT" > "ig-$ID.txt"

echo "wrote ig-$ID.txt" >&2
cat "ig-$ID.txt"

# If this exits non-zero with reason=artifact_missing, the curated cache was
# never generated for this transcription. One regeneration fixes it (30-90s):
#
#   transcribe-so captions "$ID" --for instagram --variant "$VARIANT" --regenerate
#
# Other destinations, same command: x, threads, linkedin, youtube, spotify,
# apple_podcasts, markdown, plain. For X and Threads with
# --variant quoted_sections, --json gives you `thread[]` already split into
# per-post chunks:
#
#   transcribe-so captions "$ID" --for x --variant quoted_sections --json \
#     | jq -r '.thread[]'
