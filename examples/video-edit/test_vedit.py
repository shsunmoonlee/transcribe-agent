#!/usr/bin/env python3
"""Unit tests for vedit.py (standard library only): python3 examples/video-edit/test_vedit.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vedit  # noqa: E402


def words_file(tmp, items, speaker="A"):
    data = {"words": [{"text": t, "start_ms": int(s * 1000), "end_ms": int(e * 1000), "speaker": speaker}
                      for t, s, e in items]}
    p = os.path.join(tmp, "w.json")
    json.dump(data, open(p, "w"))
    return p


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "vedit.py"), *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return r


class RoughCut(unittest.TestCase):
    def cut(self, items, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "c.json")
            run("roughcut", words_file(tmp, items), "-o", out, *extra)
            return json.load(open(out))

    def test_filler_between_close_words_is_cut(self):
        c = self.cut([("So", 0.0, 0.25), ("um", 0.3, 0.7), ("hello", 0.75, 1.1), ("world.", 1.15, 1.4)])
        self.assertEqual(c["stats"]["fillers_removed"], 1)
        self.assertEqual(len(c["keep"]), 2)
        self.assertLessEqual(c["keep"][0][1], 0.3 + 1e-6)
        self.assertGreaterEqual(c["keep"][1][0], 0.7 - 1e-6)

    def test_short_gap_merges_long_gap_splits(self):
        c = self.cut([("one", 0.0, 0.3), ("two", 0.5, 0.8), ("three.", 2.0, 2.3)])
        self.assertEqual(len(c["keep"]), 2)

    def test_parallel_sentences_are_not_retakes(self):
        items, t = [], 0.0
        for sent in ("We need to ship faster.", "We need to listen to customers.", "We need to learn every day."):
            for w in sent.split():
                items.append((w, t, t + 0.25))
                t += 0.3
            t += 0.3
        c = self.cut(items)
        self.assertEqual(c["stats"]["retakes_removed"], 0)

    def test_abandoned_start_is_a_retake_and_listed(self):
        items = [("So", 0.0, 0.2), ("the", 0.25, 0.4), ("reason", 0.45, 0.8), ("is.", 0.85, 1.0),
                 ("So", 2.0, 2.2), ("the", 2.25, 2.4), ("reason", 2.45, 2.8), ("we", 2.85, 3.0), ("grew.", 3.05, 3.4)]
        c = self.cut(items)
        self.assertEqual(c["stats"]["retakes_removed"], 1)
        self.assertEqual(c["removed"][0]["text"], "So the reason is.")
        self.assertGreaterEqual(c["keep"][0][0], 1.0)

    def test_identical_repeat_is_emphasis_not_retake(self):
        items = [("You", 0.0, 0.2), ("can", 0.25, 0.4), ("do", 0.45, 0.6), ("this.", 0.65, 0.9),
                 ("You", 1.2, 1.4), ("can", 1.45, 1.6), ("do", 1.65, 1.8), ("this.", 1.85, 2.1)]
        self.assertEqual(self.cut(items)["stats"]["retakes_removed"], 0)

    def test_keep_retakes_flag(self):
        items = [("So", 0.0, 0.2), ("the", 0.25, 0.4), ("reason.", 0.45, 0.8),
                 ("So", 1.0, 1.2), ("the", 1.25, 1.4), ("reason", 1.45, 1.8), ("is", 1.85, 2.0), ("growth.", 2.05, 2.4)]
        self.assertEqual(self.cut(items, "--keep-retakes")["stats"]["retakes_removed"], 0)


class Snap(unittest.TestCase):
    def snap(self, items, ranges, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            rp = os.path.join(tmp, "r.json")
            json.dump(ranges, open(rp, "w"))
            out = os.path.join(tmp, "s.json")
            run("snap", words_file(tmp, items), rp, "-o", out, *extra)
            return json.load(open(out))

    ITEMS = [("First", 0.0, 0.3), ("sentence", 0.35, 0.8), ("here.", 0.85, 1.2),
             ("Second", 1.5, 1.8), ("one", 1.85, 2.1), ("ends", 2.15, 2.5), ("now.", 2.55, 2.9)]

    def test_snaps_to_sentence_bounds(self):
        c = self.snap(self.ITEMS, [{"start": 1.9, "end": 2.2}])["clips"][0]
        self.assertAlmostEqual(c["start"], 1.5 - vedit.CLIP_HEAD, places=3)
        self.assertAlmostEqual(c["end"], 2.9 + vedit.CLIP_TAIL, places=3)

    def test_bad_ranges_are_skipped_not_rendered(self):
        r = self.snap(self.ITEMS, [{"start": 2000, "end": 2050}, {"start": 2.0, "end": 1.0}, {"start": 0.0}])
        self.assertEqual(len(r["skipped"]), 2)
        self.assertEqual(len(r["clips"]), 1)

    def test_max_is_respected(self):
        items, t = [], 0.0
        for n in range(40):
            items.append((f"w{n}." if n % 5 == 4 else f"w{n}", t, t + 0.9))
            t += 1.0
        c = self.snap(items, [{"start": 0.0, "end": 39.0}], "--max", "20")["clips"][0]
        self.assertLessEqual(c["end"] - c["start"], 20 + 1e-6)


class Captions(unittest.TestCase):
    def test_retime_offsets_each_span(self):
        ws = [{"text": "a", "s": 1.0, "e": 1.2}, {"text": "b", "s": 5.0, "e": 5.2}]
        out = vedit.retime(ws, [[0.9, 1.3], [4.9, 5.3]])
        self.assertAlmostEqual(out[0]["s"], 0.1, places=6)
        self.assertAlmostEqual(out[1]["s"], 0.4 + 0.1, places=6)

    def test_cjk_sentence_end(self):
        self.assertTrue(vedit.TERMINAL.search("です。"))


@unittest.skipUnless(all(map(lambda t: __import__("shutil").which(t), ("ffmpeg", "ffprobe"))), "needs ffmpeg")
class Render(unittest.TestCase):
    def test_many_spans_batch_and_keep_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src.mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-c:a", "aac",
                            "-shortest", src], check=True)
            spans = [[i * 0.3, i * 0.3 + 0.2] for i in range(90)]
            cuts = os.path.join(tmp, "c.json")
            json.dump({"mode": "roughcut", "keep": spans}, open(cuts, "w"))
            out = os.path.join(tmp, "o.mp4")
            run("render", src, cuts, out, "--encoder", "x264")
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
                                       capture_output=True, text=True).stdout)
            self.assertAlmostEqual(dur, 90 * 0.2, delta=0.6)

    def test_audio_only_source_renders_m4a(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "a.m4a")
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=5", "-c:a", "aac", src], check=True)
            cuts = os.path.join(tmp, "c.json")
            json.dump({"mode": "roughcut", "keep": [[0.5, 1.5], [2.0, 3.0]]}, open(cuts, "w"))
            r = run("render", src, cuts, os.path.join(tmp, "o.mp4"))
            self.assertTrue(json.loads(r.stdout)["out"].endswith(".m4a"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
