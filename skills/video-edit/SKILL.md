---
name: video-edit
description: "Edit video and audio from transcribe.so word timings: rough-cut a long talking-head take (remove dead air and false starts), cut vertical shorts at clean sentence boundaries, re-time captions (SRT and Remotion caption JSON) to the edited timeline, and write post copy from the same transcript. Use when the user asks Claude to edit a video, cut a talking head, make shorts, reels or TikToks from a long recording, remove pauses, or caption a cut."
---

# Edit video from word timings

Claude cannot watch video. It edits from text: every word with its start and end time and its
speaker. transcribe.so supplies that layer (speaker labels, word timings, chapters, quotes, clip
ideas); ffmpeg does the cutting on the user's machine. The helper script `vedit.py` (Python 3,
standard library only) turns word timings into cut lists and renders them.

## Setup (once per project)

1. ffmpeg and ffprobe on PATH (`ffmpeg -version`). Homebrew's default build has no caption burn-in
   filter (no libass, no drawtext); the script writes caption files instead, see Captions.
2. Get the helper:
   `curl -fsSL -o vedit.py https://github.com/shsunmoonlee/transcribe-agent/raw/main/examples/video-edit/vedit.py`
3. An API key from https://transcribe.so/settings/api-keys in the environment variable
   `TRANSCRIBE_API_KEY`, used only by `vedit.py words` to save the timings to a file (they are too
   long to pass through the conversation).

## Step 1: transcribe the source

Upload the local file (the `transcribe-audio` skill covers quoting and starting the job; follow
its rules). Use the uploaded file, not a link, when the user wants the cut rendered from their
own footage. Wait for `completed`, then save every word timing:

`python3 vedit.py words <transcription_id> -o words.json`

## Workflow A: rough cut of a long take

`python3 vedit.py roughcut words.json -o cuts.json` keeps every spoken word, removes pauses longer
than `--gap` seconds (default 0.6), pads each kept span by `--pad` (0.12 s) so no word is clipped,
and drops a sentence the speaker immediately restarts with the same opening words (a false start;
`--keep-retakes` turns this off). Read the printed stats: `removed_pct` above 25 on a normal talking
head means a timing problem, so stop and check before rendering.

`python3 vedit.py render source.mp4 cuts.json edited.mp4 --words words.json` renders the cut and
writes `edited.srt` and `edited.captions.json` aligned to the new timeline.

Transcripts are clean verbatim: filler sounds such as "um" are usually not words in the
transcript, so they are cut only when they sit inside a removed pause. Say so if the user asks for
every filler to be removed.

## Workflow B: shorts from a long recording

1. Find candidate moments with `getTranscriptionResult` and `include=posting_chapters`:
   `clips` (three short-form ideas, each a start time and a title), `quoted_sections` (verbatim
   quotes with their start), and `highlights`. Or read the full text with `getTranscript` and pick
   ranges yourself. A good short opens on a complete, surprising sentence, stands alone without the
   rest of the video, and ends on a finished thought, usually 25 to 55 seconds.
2. Write the picks as JSON: `[{"start": 24.8, "end": 66.5, "title": "What problem do you solve?"}]`.
   Clip ideas have no end time; use start plus 55 and let the next step find the sentence end.
3. `python3 vedit.py snap words.json picks.json --max 60 -o clips.json` moves each start back to
   the beginning of its sentence and each end forward to the end of a sentence, never past `--max`.
   Show the user `first_words` and `last_words` of every clip and let them confirm or adjust.
4. `python3 vedit.py render source.mp4 clips.json short.mp4 --vertical --words words.json` writes
   `short-1.mp4`, `short-2.mp4` and so on at 1080x1920 (center crop), each with its own SRT and
   caption JSON.

If two picks overlap by more than a few seconds, keep the stronger one.

## Captions

- Every render with `--words` writes an SRT (short cues, broken at sentence ends) and a Remotion
  `Caption[]` JSON (`text`, `startMs`, `endMs`, `timestampMs`, `confidence`) on the edited
  timeline. Import the SRT into CapCut, Premiere Pro, DaVinci Resolve or Final Cut, or feed the JSON
  to `@remotion/captions` for word-by-word animated captions.
- For a ready-made captioned clip without a local editor, the hosted `renderClip` tool burns
  captions into a vertical clip (styles captions, karaoke, highlight, boxed, minimal). Call
  `getClipQuote` for the same range first and follow the confirmation rules in `get-transcript`.
- `getSubtitles` with preset `tiktok-shorts` or `instagram-reels` gives captions for the original,
  uncut timeline.

## Post copy from the same transcript

`getTranscriptionTimestamps` writes paste-ready text: `format=youtube` (chapter list for the
description), `format=x` or `threads` (a thread), `format=linkedin` (one post), with
`variant=quoted_sections` for verbatim quotes. For a long-form X article or a caption in the user's
own voice, write it from `getTranscript` and quote only words that appear in the transcript.

## Rules

- Never invent a timestamp or a quote. Every time comes from `words.json` or a tool result, and
  every quoted line must appear in the transcript.
- Show the cut list (or first and last words of each clip) before rendering anything long.
- Keep the source file untouched; write every output to a new path.
- When editing someone else's recording, keep their on-screen attribution and name them in the
  post copy.
