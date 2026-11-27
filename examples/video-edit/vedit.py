#!/usr/bin/env python3
"""Edit video from transcribe.so word timings. Stdlib only; needs ffmpeg/ffprobe for `render`.

Subcommands (all times in seconds unless the name says _ms):
  words TRANSCRIPTION_ID [-o words.json]
      Save every word timing of a completed transcribe.so transcription (needs TRANSCRIBE_API_KEY).
  roughcut WORDS.json [--gap 0.6] [--pad 0.12] [--fillers um,uh,...] [--keep-retakes] [-o cuts.json]
      Keep speech, drop pauses longer than --gap, filler words and false starts (a sentence that is
      restarted with the same opening words). Writes {"keep": [[start, end], ...], "stats": {...}}.
  snap WORDS.json RANGES.json [--max 60] [-o cuts.json]
      RANGES.json = [{"start": s, "end": s, "title": "..."}] (from posting_chapters clips, Claude, etc).
      Moves each start back to the sentence start and each end forward to the sentence end so no
      word is clipped. Writes {"clips": [{"start", "end", "title"}]}.
  render SOURCE CUTS.json OUT.mp4 [--vertical] [--encoder auto|videotoolbox|x264] [--words WORDS.json]
      Roughcut file: one video of all kept spans. Snap file: one video per clip (OUT-1.mp4 ...).
      With --words also writes OUT.srt and OUT.captions.json (Remotion @remotion/captions Caption[])
      re-timed to the edited timeline.
  captions WORDS.json [--start s --end s] [-o out.srt]
      SRT for a span of the original timeline (or all of it).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

TERMINAL = re.compile(r"[.?!]['\")\]]*$")
DEFAULT_FILLERS = "um,uh,erm,er,hmm,mm,ah,uhm,umm"


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
        out.append({"text": text, "s": w["start_ms"] / 1000.0, "e": w["end_ms"] / 1000.0, "speaker": w.get("speaker")})
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
        if TERMINAL.search(w["text"]) or long_pause or nxt is None:
            out.append(cur)
            cur = []
    return out


def cmd_roughcut(a):
    words = load_words(a.words)
    fillers = {f.strip() for f in a.fillers.split(",") if f.strip()}
    drop = set()
    filler_n = 0
    for i, w in enumerate(words):
        if norm(w["text"]) in fillers:
            drop.add(i)
            filler_n += 1
    retakes = 0
    if not a.keep_retakes:
        sents = sentences(words)
        for j in range(len(sents) - 1):
            this = [norm(words[i]["text"]) for i in sents[j] if i not in drop]
            nxt = [norm(words[i]["text"]) for i in sents[j + 1] if i not in drop]
            k = min(3, len(this), len(nxt))
            gap = words[sents[j + 1][0]]["s"] - words[sents[j][-1]]["e"]
            if k >= 2 and this[:k] == nxt[:k] and gap < 6 and len(this) <= len(nxt) + 2:
                drop.update(sents[j])
                retakes += 1
    kept = [w for i, w in enumerate(words) if i not in drop]
    spans = []
    for w in kept:
        s, e = max(0.0, w["s"] - a.pad), w["e"] + a.pad
        if spans and s - spans[-1][1] <= a.gap:
            spans[-1][1] = max(spans[-1][1], e)
        elif spans and s <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], e)
        else:
            spans.append([s, e])
    total = words[-1]["e"] if words else 0
    kept_s = sum(e - s for s, e in spans)
    res = {"mode": "roughcut", "keep": [[round(s, 3), round(e, 3)] for s, e in spans],
           "stats": {"source_s": round(total, 1), "kept_s": round(kept_s, 1),
                     "removed_pct": round(100 * (1 - kept_s / total), 1) if total else 0,
                     "fillers_removed": filler_n, "retakes_removed": retakes, "spans": len(spans)}}
    write(res, a.o or "cuts.json")


def cmd_snap(a):
    words = load_words(a.words)
    ranges = json.load(open(a.ranges))
    sents = sentences(words)
    sent_of = {}
    for si, idxs in enumerate(sents):
        for i in idxs:
            sent_of[i] = si
    clips = []
    for r in ranges:
        start, end = float(r["start"]), float(r.get("end") or float(r["start"]) + a.max)
        first = next((i for i, w in enumerate(words) if w["e"] > start), None)
        if first is None:
            continue
        s_idx = sents[sent_of[first]][0]
        if start - words[s_idx]["s"] > 4:
            s_idx = first
        last = max((i for i, w in enumerate(words) if w["s"] < end), default=first)
        e_idx = sents[sent_of[last]][-1]
        if words[e_idx]["e"] - end > 8:
            e_idx = last
        while words[e_idx]["e"] - words[s_idx]["s"] > a.max and e_idx > s_idx:
            prev_end = max((i for i in range(s_idx, e_idx) if TERMINAL.search(words[i]["text"])), default=None)
            e_idx = prev_end if prev_end is not None and words[prev_end]["e"] - words[s_idx]["s"] >= 10 else e_idx - 1
        clips.append({"start": round(max(0.0, words[s_idx]["s"] - 0.08), 3), "end": round(words[e_idx]["e"] + 0.25, 3),
                      "title": r.get("title"), "first_words": " ".join(w["text"] for w in words[s_idx:s_idx + 8]),
                      "last_words": " ".join(w["text"] for w in words[max(s_idx, e_idx - 7):e_idx + 1])})
    write({"mode": "clips", "clips": clips}, a.o or "clips.json")


def write(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    print(json.dumps({"out": path, **({"stats": obj["stats"]} if "stats" in obj else {"clips": len(obj.get("clips", []))})}))


def encoder_args(choice):
    if choice == "auto":
        try:
            encs = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        except FileNotFoundError:
            sys.exit("ffmpeg not found")
        choice = "videotoolbox" if "h264_videotoolbox" in encs else "x264"
    if choice == "videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "6M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


def render_spans(src, spans, out, vertical, enc):
    parts, labels = [], ""
    for i, (s, e) in enumerate(spans):
        parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}];"
                     f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,"
                     f"afade=t=out:st={max(0.0, e - s - 0.02):.3f}:d=0.02[a{i}];")
        labels += f"[v{i}][a{i}]"
    fc = "".join(parts) + f"{labels}concat=n={len(spans)}:v=1:a=1[cv][ca]"
    if vertical:
        fc += ";[cv]crop='min(iw,ih*9/16)':ih,scale=1080:1920,setsar=1[vv]"
    vmap = "[vv]" if vertical else "[cv]"
    script = out + ".filter.txt"
    with open(script, "w") as f:
        f.write(fc)
    tail = ["-map", vmap, "-map", "[ca]", *encoder_args(enc), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]
    head = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", src]
    # ffmpeg >= 7.1 reads an option value from a file with "-/opt"; older builds only know -filter_complex_script.
    r = subprocess.run(head + ["-/filter_complex", script] + tail, capture_output=True, text=True)
    if r.returncode != 0 and "Unrecognized option" in r.stderr:
        r = subprocess.run(head + ["-filter_complex_script", script] + tail, capture_output=True, text=True)
    os.remove(script)
    if r.returncode != 0:
        sys.exit(f"ffmpeg failed: {r.stderr.strip()[-600:]}")


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
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (brew install ffmpeg)")
    cuts = json.load(open(a.cuts))
    words = load_words(a.words) if a.words else None
    base, ext = os.path.splitext(a.out)
    jobs = [(a.out, cuts["keep"])] if cuts.get("mode") == "roughcut" else \
        [(f"{base}-{i}{ext}", [[c["start"], c["end"]]]) for i, c in enumerate(cuts["clips"], 1)]
    for out, spans in jobs:
        render_spans(a.source, spans, out, a.vertical, a.encoder)
        if words:
            rw = retime(words, spans)
            write_srt(rw, os.path.splitext(out)[0] + ".srt")
            write_remotion(rw, os.path.splitext(out)[0] + ".captions.json")
        print(json.dumps({"out": out, "seconds": round(sum(e - s for s, e in spans), 2)}))


def cmd_captions(a):
    words = load_words(a.words)
    if a.start is not None:
        words = retime(words, [[a.start, a.end if a.end is not None else 1e9]])
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
