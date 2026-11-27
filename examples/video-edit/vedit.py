#!/usr/bin/env python3
"""Edit video or audio from transcribe.so word timings. Standard library only; `render` needs ffmpeg + ffprobe.

Subcommands (all times in seconds unless a name says _ms):
  words TRANSCRIPTION_ID [-o words.json]
      Save every word timing of a completed transcribe.so transcription (needs TRANSCRIBE_API_KEY).
  roughcut WORDS.json [--gap 0.6] [--pad 0.12] [--fillers um,uh,...] [--keep-retakes] [-o cuts.json]
      Keep speech; cut silences between words longer than --gap, filler words, and false starts (a
      sentence the same speaker abandons and restarts with mostly the same words). Writes
      {"keep": [[start, end], ...], "removed": [{start, end, reason, text}], "stats": {...}}.
  snap WORDS.json RANGES.json [--max 60] [-o clips.json]
      RANGES.json = [{"start": s, "end": s, "title": "..."}] in SECONDS (posting_chapters items carry
      start_ms: divide by 1000). Moves each start back to its sentence start and each end forward to a
      sentence end, never longer than --max. Writes {"clips": [...], "skipped": [...]}.
  render SOURCE CUTS.json OUT.mp4 [--vertical] [--encoder auto|videotoolbox|x264] [--words WORDS.json]
      A roughcut file renders one output of all kept spans; a snap file renders one output per clip
      (OUT-1.mp4, OUT-2.mp4, ...). Audio-only sources render .m4a. With --words also writes OUT.srt and
      OUT.captions.json (Remotion @remotion/captions Caption[]) on the edited timeline.
  captions WORDS.json [--start s] [--end s] [-o out.srt]
      SRT for a window of the original timeline (default: all of it).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

TERMINAL = re.compile(r"[.?!。？！]['\")\]」』]*$")
DEFAULT_FILLERS = "um,uh,erm,er,hmm,mm,ah,uhm,umm"
CLIP_TAIL = 0.25
CLIP_HEAD = 0.08
BATCH = 40


def warn(msg):
    print(msg, file=sys.stderr)


def load_words(path):
    data = json.load(open(path))
    words = data["words"] if isinstance(data, dict) else data
    out = []
    for w in words:
        text = (w.get("text") or "").strip()
        punct = w.get("punctuation") or ""
        if punct and not text.endswith(punct):
            text = text + punct
        if not text or w.get("start_ms") is None or w.get("end_ms") is None:
            continue
        s, e = w["start_ms"] / 1000.0, w["end_ms"] / 1000.0
        out.append({"text": text, "s": s, "e": max(e, s), "speaker": w.get("speaker")})
    out.sort(key=lambda w: w["s"])
    return out


def norm(t):
    return re.sub(r"[^\w']+", "", t.lower())


def sentences(words):
    cur, out = [], []
    for i, w in enumerate(words):
        cur.append(i)
        nxt = words[i + 1] if i + 1 < len(words) else None
        long_pause = nxt is not None and nxt["s"] - w["e"] > 1.2
        speaker_change = nxt is not None and nxt.get("speaker") != w.get("speaker")
        if TERMINAL.search(w["text"]) or long_pause or speaker_change or nxt is None:
            out.append(cur)
            cur = []
    return out


def is_retake(this, nxt):
    """`this` (normalized words) is an abandoned attempt that `nxt` restarts."""
    if len(this) < 2 or len(this) > 14:
        return False
    common = 0
    for a, b in zip(this, nxt):
        if a != b:
            break
        common += 1
    # The restart must go further than the attempt: an identical complete repeat is emphasis, not a retake.
    return common >= 2 and common >= 0.75 * len(this) and len(nxt) > len(this)


def cmd_roughcut(a):
    words = load_words(a.words)
    if not words:
        sys.exit("no timed words in " + a.words)
    fillers = {f.strip().lower() for f in a.fillers.split(",") if f.strip()}
    reason = {}
    for i, w in enumerate(words):
        if norm(w["text"]) in fillers:
            reason[i] = "filler"
    if not a.keep_retakes:
        sents = sentences(words)
        for j in range(len(sents) - 1):
            cur, nxt = sents[j], sents[j + 1]
            if words[cur[0]].get("speaker") != words[nxt[0]].get("speaker"):
                continue
            if words[nxt[0]]["s"] - words[cur[-1]]["e"] > 6:
                continue
            this = [norm(words[i]["text"]) for i in cur if i not in reason]
            again = [norm(words[i]["text"]) for i in nxt if i not in reason]
            if is_retake(this, again):
                for i in cur:
                    reason.setdefault(i, "retake")
    spans, prev_kept, removed = [], None, []
    for i, w in enumerate(words):
        if i in reason:
            continue
        s, e = max(0.0, w["s"] - a.pad), w["e"] + a.pad
        dropped = [] if prev_kept is None else [k for k in range(prev_kept + 1, i) if k in reason]
        if spans and dropped:
            spans[-1][1] = min(spans[-1][1], max(words[prev_kept]["e"], words[dropped[0]]["s"]))
            s = max(s, words[dropped[-1]]["e"])
            spans.append([s, e])
        elif spans and w["s"] - words[prev_kept]["e"] <= a.gap:
            spans[-1][1] = max(spans[-1][1], e)
        else:
            if spans and s < spans[-1][1]:
                mid = (words[prev_kept]["e"] + w["s"]) / 2
                spans[-1][1], s = mid, mid
            spans.append([s, e])
        prev_kept = i
    group = None
    for i, w in enumerate(words):
        if i in reason:
            if group and group["reason"] == reason[i] and i == group["last"] + 1:
                group["end"], group["text"], group["last"] = w["e"], group["text"] + " " + w["text"], i
            else:
                group = {"start": w["s"], "end": w["e"], "reason": reason[i], "text": w["text"], "last": i}
                removed.append(group)
    for g in removed:
        g.pop("last", None)
        g["start"], g["end"] = round(g["start"], 3), round(g["end"], 3)
    total = words[-1]["e"]
    kept_s = sum(e - s for s, e in spans)
    res = {"mode": "roughcut", "keep": [[round(s, 3), round(e, 3)] for s, e in spans], "removed": removed,
           "stats": {"source_s": round(total, 1), "kept_s": round(kept_s, 1),
                     "removed_pct": round(100 * (1 - kept_s / total), 1) if total else 0,
                     "fillers_removed": sum(1 for r in reason.values() if r == "filler"),
                     "retakes_removed": sum(1 for g in removed if g["reason"] == "retake"), "spans": len(spans)}}
    write(res, a.o or "cuts.json")
    for g in removed:
        if g["reason"] == "retake":
            warn(f"retake removed at {g['start']:.1f}s: {g['text']}")


def cmd_snap(a):
    words = load_words(a.words)
    ranges = json.load(open(a.ranges))
    if not words:
        sys.exit("no timed words in " + a.words)
    sents = sentences(words)
    sent_of = {i: si for si, idxs in enumerate(sents) for i in idxs}
    duration = words[-1]["e"]
    clips, skipped = [], []
    budget = a.max - CLIP_HEAD - CLIP_TAIL
    for r in ranges:
        start = float(r["start"])
        end = float(r["end"]) if r.get("end") is not None else start + a.max
        if start >= duration or end <= start:
            skipped.append({**r, "why": "start past the end of the transcript (was it start_ms?)" if start >= duration
                            else "end is not after start"})
            continue
        inside = [i for i, w in enumerate(words) if w["e"] > start and w["s"] < end]
        if not inside:
            skipped.append({**r, "why": "no words in range"})
            continue
        first, last = inside[0], inside[-1]
        s_idx = sents[sent_of[first]][0]
        if start - words[s_idx]["s"] > 4:
            s_idx = first
        e_idx = sents[sent_of[last]][-1]
        if words[e_idx]["e"] - end > 8:
            e_idx = last
        while e_idx > s_idx and words[e_idx]["e"] - words[s_idx]["s"] > budget:
            ends = [i for i in range(s_idx, e_idx) if TERMINAL.search(words[i]["text"])
                    and words[i]["e"] - words[s_idx]["s"] >= 10]
            e_idx = ends[-1] if ends else e_idx - 1
        clips.append({"start": round(max(0.0, words[s_idx]["s"] - CLIP_HEAD), 3),
                      "end": round(words[e_idx]["e"] + CLIP_TAIL, 3), "title": r.get("title"),
                      "first_words": " ".join(w["text"] for w in words[s_idx:s_idx + 8]),
                      "last_words": " ".join(w["text"] for w in words[max(s_idx, e_idx - 7):e_idx + 1])})
    for sk in skipped:
        warn(f"skipped range {sk.get('start')}-{sk.get('end')}: {sk['why']}")
    write({"mode": "clips", "clips": clips, "skipped": skipped}, a.o or "clips.json")


def write(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    summary = {"stats": obj["stats"]} if "stats" in obj else {"clips": len(obj.get("clips", [])),
                                                               "skipped": len(obj.get("skipped", []))}
    print(json.dumps({"out": path, **summary}))


def probe(src):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", src],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"ffprobe could not read {src}: {r.stderr.strip()[-300:]}")
    kinds = set(r.stdout.split())
    return "video" in kinds, "audio" in kinds


def encoder_args(choice):
    if choice == "auto":
        encs = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        choice = "videotoolbox" if "h264_videotoolbox" in encs else "x264"
    if choice == "videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "6M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


def run_ffmpeg(head, fc, tail):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(fc)
        script = f.name
    try:
        # ffmpeg >= 7.1 reads an option value from a file with "-/opt"; older builds only know -filter_complex_script.
        r = subprocess.run(head + ["-/filter_complex", script] + tail, capture_output=True, text=True)
        if r.returncode != 0 and "Unrecognized option" in r.stderr:
            r = subprocess.run(head + ["-filter_complex_script", script] + tail, capture_output=True, text=True)
    finally:
        os.remove(script)
    if r.returncode != 0:
        sys.exit(f"ffmpeg failed: {r.stderr.strip()[-600:]}")


def render_batch(src, spans, out, has_v, has_a, vertical, venc):
    """One intermediate file (h264 + PCM in Matroska) for up to BATCH spans, input seeked to the batch."""
    t0 = max(0.0, spans[0][0] - 1.0)
    t1 = spans[-1][1] + 1.0
    parts, labels = [], ""
    for i, (s, e) in enumerate(spans):
        rs, re_ = s - t0, e - t0
        if has_v:
            parts.append(f"[0:v]trim=start={rs:.3f}:end={re_:.3f},setpts=PTS-STARTPTS[v{i}];")
            labels += f"[v{i}]"
        if has_a:
            fade_out = max(0.0, re_ - rs - 0.02)
            parts.append(f"[0:a]atrim=start={rs:.3f}:end={re_:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,"
                         f"afade=t=out:st={fade_out:.3f}:d=0.02[a{i}];")
            labels += f"[a{i}]"
    outs = ("[cv]" if has_v else "") + ("[ca]" if has_a else "")
    fc = "".join(parts) + f"{labels}concat=n={len(spans)}:v={int(has_v)}:a={int(has_a)}{outs}"
    maps = []
    if has_v:
        vlabel = "[cv]"
        if vertical:
            fc += ";[cv]crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920,setsar=1[vv]"
            vlabel = "[vv]"
        maps += ["-map", vlabel] + venc
    if has_a:
        maps += ["-map", "[ca]", "-c:a", "pcm_s16le"]
    head =["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", src]
    run_ffmpeg(head, fc, maps + [out])


def render_spans(src, spans, out, vertical, enc):
    has_v, has_a = probe(src)
    if not has_v and not has_a:
        sys.exit(f"{src} has no audio or video stream")
    if not has_v and out.endswith(".mp4"):
        out = out[:-4] + ".m4a"
    venc = encoder_args(enc) if has_v else []
    batches = [spans[i:i + BATCH] for i in range(0, len(spans), BATCH)]
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for n, b in enumerate(batches, 1):
            part = os.path.join(tmp, f"part{n:04d}.mkv")
            render_batch(src, b, part, has_v, has_a, vertical, venc)
            parts.append(part)
            if len(batches) > 1:
                warn(f"rendered batch {n}/{len(batches)}")
        listing = os.path.join(tmp, "parts.txt")
        with open(listing, "w") as f:
            f.writelines(f"file '{p}'\n" for p in parts)
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listing]
        if has_v:
            cmd += ["-c:v", "copy"]
        if has_a:
            cmd += ["-c:a", "aac", "-b:a", "160k"]
        cmd += ["-movflags", "+faststart", out]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"ffmpeg concat failed: {r.stderr.strip()[-600:]}")
    return out


def retime(words, spans):
    out, offset = [], 0.0
    for s, e in spans:
        for w in words:
            if w["s"] >= s - 1e-3 and w["e"] <= e + 1e-3:
                out.append({**w, "s": w["s"] - s + offset, "e": w["e"] - s + offset})
        offset += e - s
    return out


def cues(words, max_words=6, max_s=2.2):
    cur, out = [], []
    for w in words:
        if cur and (len(cur) >= max_words or w["e"] - cur[0]["s"] > max_s or w["s"] - cur[-1]["e"] > 0.6):
            out.append(cur)
            cur = []
        cur.append(w)
        if TERMINAL.search(w["text"]):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def ts(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt(words, path):
    with open(path, "w") as f:
        for n, c in enumerate(cues(words), 1):
            f.write(f"{n}\n{ts(c[0]['s'])} --> {ts(c[-1]['e'])}\n{' '.join(w['text'] for w in c)}\n\n")


def write_remotion(words, path):
    caps = [{"text": (" " if i else "") + w["text"], "startMs": round(w["s"] * 1000), "endMs": round(w["e"] * 1000),
             "timestampMs": round((w["s"] + w["e"]) * 500), "confidence": None} for i, w in enumerate(words)]
    with open(path, "w") as f:
        json.dump(caps, f)


def cmd_render(a):
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found (macOS: brew install ffmpeg)")
    cuts = json.load(open(a.cuts))
    words = load_words(a.words) if a.words else None
    base, ext = os.path.splitext(a.out)
    if cuts.get("mode") == "roughcut":
        jobs = [(a.out, cuts["keep"])]
    else:
        jobs = [(f"{base}-{i}{ext}", [[c["start"], c["end"]]]) for i, c in enumerate(cuts["clips"], 1)]
    if not jobs or not all(spans for _, spans in jobs):
        sys.exit("nothing to render")
    for out, spans in jobs:
        bad = [sp for sp in spans if sp[1] <= sp[0]]
        if bad:
            sys.exit(f"invalid span(s) {bad[:3]} in {a.cuts}")
        out = render_spans(a.source, spans, out, a.vertical, a.encoder)
        if words:
            rw = retime(words, spans)
            write_srt(rw, os.path.splitext(out)[0] + ".srt")
            write_remotion(rw, os.path.splitext(out)[0] + ".captions.json")
        print(json.dumps({"out": out, "seconds": round(sum(e - s for s, e in spans), 2)}))


def cmd_captions(a):
    words = load_words(a.words)
    if a.start is not None or a.end is not None:
        words = retime(words, [[a.start or 0.0, a.end if a.end is not None else 1e9]])
    write_srt(words, a.o or "captions.srt")


def api_get(path):
    key = os.environ.get("TRANSCRIBE_API_KEY")
    if not key:
        sys.exit("TRANSCRIBE_API_KEY is not set (create a key at https://transcribe.so/settings/api-keys)")
    base = os.environ.get("TRANSCRIBE_API_BASE", "https://transcribe.so/api/v1")
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {key}",
                                                       "User-Agent": "transcribe-so-vedit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")


def cmd_words(a):
    words, offset, language = [], 0, None
    while True:
        page = api_get(f"/transcriptions/{int(a.id)}/words?offset={offset}&limit=5000")
        if not page.get("available", True):
            sys.exit(f"word timings not available: {page.get('reason')}")
        language = page.get("language") or language
        batch = page.get("words") or []
        words.extend({k: w.get(k) for k in ("text", "start_ms", "end_ms", "speaker", "segment_id", "punctuation")}
                     for w in batch)
        if not page.get("has_more") or not batch:
            break
        offset += len(batch)
    out = a.o or f"words-{int(a.id)}.json"
    with open(out, "w") as f:
        json.dump({"transcription_id": int(a.id), "language": language, "words": words}, f)
    print(json.dumps({"out": out, "words": len(words), "language": language}))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    w = sp.add_parser("words"); w.add_argument("id"); w.add_argument("-o")
    r = sp.add_parser("roughcut"); r.add_argument("words"); r.add_argument("--gap", type=float, default=0.6)
    r.add_argument("--pad", type=float, default=0.12); r.add_argument("--fillers", default=DEFAULT_FILLERS)
    r.add_argument("--keep-retakes", action="store_true"); r.add_argument("-o")
    s = sp.add_parser("snap"); s.add_argument("words"); s.add_argument("ranges"); s.add_argument("--max", type=float, default=60)
    s.add_argument("-o")
    d = sp.add_parser("render"); d.add_argument("source"); d.add_argument("cuts"); d.add_argument("out")
    d.add_argument("--vertical", action="store_true"); d.add_argument("--encoder", default="auto"); d.add_argument("--words")
    c = sp.add_parser("captions"); c.add_argument("words"); c.add_argument("--start", type=float); c.add_argument("--end", type=float)
    c.add_argument("-o")
    a = p.parse_args()
    {"words": cmd_words, "roughcut": cmd_roughcut, "snap": cmd_snap, "render": cmd_render,
     "captions": cmd_captions}[a.cmd](a)


if __name__ == "__main__":
    main()
