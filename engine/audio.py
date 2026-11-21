"""podcast-studio audio: record sentences with Kokoro, mix the episode, draw data for the video, verify the result.

usage:  python audio.py phonemes <job.json> how the voice will pronounce some text (IPA), without recording
        python audio.py synth  <job.json>   record every take in the job that is not in the cache yet
        python audio.py mix    <job.json>   place the takes on the timeline, add the music bed, write mix and voice WAVs
        python audio.py viz    <job.json>   spectrum bars and level per video frame, from the finished audio
        python audio.py verify <job.json>   numeric checks of the finished audio against the timeline

Run by `podcast audio`, `podcast video` and `podcast verify`; the job files are written by engine/lib/audio.mjs.
Only `synth` needs kokoro-onnx. Everything else needs numpy and soundfile.

env     KOKORO_HOME    folder holding the model files (default ~/kokoro)
        KOKORO_MODEL   path of kokoro-v1.0.onnx (default $KOKORO_HOME/kokoro-v1.0.onnx)
        KOKORO_VOICES  path of voices-v1.0.bin  (default $KOKORO_HOME/voices-v1.0.bin)
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, NoReturn

import numpy as np

Samples = np.ndarray  # float32 audio: one axis for mono, samples x 2 for stereo

R = 24000  # Kokoro's sample rate; the mix is made at this rate and resampled once at the end


def die(msg: str) -> NoReturn:
    sys.exit("audio.py: " + msg)


def note(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- small signal helpers (pure)

def smooth(x: Samples, seconds: float, rate: int = R) -> Samples:
    """moving average of |x| over a window"""
    n = max(1, int(seconds * rate))
    return np.convolve(np.abs(x), np.ones(n, np.float32) / n, "same")


def trim(x: Samples, rate: int = R, thr: float = 0.01, pad: float = 0.02) -> Samples:
    """cut the silence before the first and after the last sound, keeping `pad` seconds"""
    idx = np.where(smooth(x, 0.01, rate) > thr)[0]
    if len(idx) == 0: return x
    return x[max(0, idx[0] - int(pad * rate)):min(len(x), idx[-1] + int(pad * rate))]


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[(start, end)] index pairs of every run of True in a boolean array"""
    if len(mask) == 0: return []
    edges = np.flatnonzero(np.diff(np.concatenate(([0], mask.astype(np.int8), [0]))))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def find_pauses(x: Samples, rate: int = R, min_len: float = 0.07, rel: float = 0.06) -> list[list[float]]:
    """silences inside a recording, as [[start, end], ...] in seconds. Quiet means under `rel` times the
    loud level of the recording. Silence touching either end is not a pause."""
    env = smooth(x, 0.012, rate)
    if len(env) == 0 or env.max() <= 0: return []
    quiet = env < rel * np.percentile(env, 95)
    out = []
    for s, e in runs(quiet):
        if s == 0 or e >= len(x) or (e - s) / rate < min_len: continue
        out.append([round(s / rate, 3), round(e / rate, 3)])
    return out


def active_rms(x: Samples, rate: int = R, frame: float = 0.05, floor_db: float = -30.0) -> float:
    """RMS of the frames that hold speech: those within `floor_db` of the loudest frame"""
    n = int(frame * rate)
    if len(x) < n: return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    f = x[:len(x) // n * n].reshape(-1, n)
    p = np.mean(f.astype(np.float64) ** 2, axis=1)
    keep = p > p.max() * 10 ** (floor_db / 10)
    return float(np.sqrt(p[keep].mean())) if keep.any() else 0.0


def level_gains(rms_by_speaker: dict[str, float], limit_db: float = 6.0) -> dict[str, float]:
    """gain per speaker that brings every speaker to the same speech level (their geometric mean)"""
    vals = {k: v for k, v in rms_by_speaker.items() if v > 0}
    if not vals: return {k: 1.0 for k in rms_by_speaker}
    target = float(np.exp(np.mean([np.log(v) for v in vals.values()])))
    lim = 10 ** (limit_db / 20)
    return {k: (float(np.clip(target / v, 1 / lim, lim)) if v > 0 else 1.0) for k, v in rms_by_speaker.items()}


def pan_gains(pan: float) -> tuple[float, float]:
    """constant-power left and right gains for pan in [-1, 1]; 0 is the centre"""
    a = (float(np.clip(pan, -1, 1)) + 1) * np.pi / 4
    return float(np.cos(a)), float(np.sin(a))


def place(buf: Samples, at: float, sig: Samples, rate: int = R) -> None:
    """add `sig` into `buf` (samples, or samples x channels) starting `at` seconds; what falls outside is dropped"""
    s = int(round(at * rate)); e = min(len(buf), s + len(sig))
    if s < 0 or s >= len(buf): return
    buf[s:e] += sig[:e - s]


def music_envelope(n: int, tl: dict[str, Any], rate: int = R, fade_in: float = 0.25, fade_out: float = 2.2) -> Samples:
    """how loud the music is over the episode (0..1) before ducking: full during the intro, fading out under
    the first `under` seconds of speech; rising under the last `outro` seconds of speech, full after the
    last word and fading out at the end"""
    m = tl["music"]; t = np.arange(n) / rate
    intro = np.where(t < m["intro"], 1.0, np.clip(1 - (t - m["intro"]) / max(m["under"], 1e-3), 0, 1)) * np.clip(t / fade_in, 0, 1)
    rise = np.clip((t - (tl["speechEnd"] - m["outro"])) / max(m["outro"], 1e-3), 0, 1)
    outro = rise * np.clip((tl["total"] - t) / fade_out, 0, 1)
    return np.maximum(intro, outro).astype(np.float32)


def duck_envelope(voice_mono: Samples, rate: int = R, depth: float = 0.72, knee: float = 0.04, window: float = 0.16) -> Samples:
    """gain for the music (1 - depth .. 1): low while someone speaks, back up in the gaps"""
    return (1 - depth * np.clip(smooth(voice_mono, window, rate) / knee, 0, 1)).astype(np.float32)


NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def chord_freqs(name: str) -> list[float]:
    """three frequencies for a chord name such as Dm, Bb or F#"""
    m = re.match(r"^([A-G])([#b]?)(m?)$", name.strip())
    if not m: die(f'music chord "{name}" is not understood (use names like C, Am, Bb, F#m)')
    root = NOTE[m[1]] + (1 if m[2] == "#" else -1 if m[2] == "b" else 0)
    r = (root - 9) % 12  # semitones above A
    base = 220 * 2 ** (r / 12) * (0.5 if r >= 5 else 1)
    return [base * 2 ** (s / 12) for s in ([0, 3, 7] if m[3] else [0, 4, 7])]


def gen_music(seconds: float, bpm: float = 84, chords: str = "Dm-Bb-F-C", rate: int = R) -> Samples:
    """a calm generated bed: a soft pad per bar, a low root note and a plucked arpeggio. Stereo, peak under 1."""
    n = int(seconds * rate); out = np.zeros((n, 2), np.float32)
    beat = 60 / bpm; bar = beat * 4; prog = [chord_freqs(c) for c in chords.split("-") if c.strip()]
    if not prog or n == 0: return out
    for b in range(int(seconds / bar) + 1):
        at = b * bar; ch = prog[b % len(prog)]
        d = bar * 1.15; ts = np.arange(int(d * rate)) / rate
        env = np.clip(ts / 0.45, 0, 1) * np.clip((d - ts) / (bar * 0.3), 0, 1)
        for side, cents in ((0, -4), (1, 4)):
            k = 2 ** (cents / 1200)
            pad = sum(np.sin(2 * np.pi * f * k * ts) + 0.22 * np.sin(4 * np.pi * f * k * ts) for f in ch)
            place(out[:, side], at, (pad * env * 0.055).astype(np.float32), rate)
        db = bar * 0.9; tb = np.arange(int(db * rate)) / rate
        bass = (np.sin(2 * np.pi * ch[0] / 2 * tb) * np.exp(-tb / 0.9) * np.clip(tb / 0.02, 0, 1) * 0.16).astype(np.float32)
        place(out[:, 0], at, bass, rate); place(out[:, 1], at, bass, rate)
        order = [0, 1, 2, 1, 0, 2, 1, 2]
        for i in range(8):
            f = ch[order[i]] * 2; dp = 0.6; tp = np.arange(int(dp * rate)) / rate
            pluck = (np.sin(2 * np.pi * f * tp) + 0.3 * np.sin(4 * np.pi * f * tp)) * np.exp(-tp / 0.16) * np.clip(tp / 0.004, 0, 1) * 0.07
            left, right = pan_gains(-0.4 if i % 2 == 0 else 0.4)
            place(out[:, 0], at + i * beat / 2, (pluck * left).astype(np.float32), rate)
            place(out[:, 1], at + i * beat / 2, (pluck * right).astype(np.float32), rate)
    return out


def envelope_db(x: Samples, rate: int, frame: float = 0.02) -> np.ndarray:
    """RMS level in dBFS of consecutive frames (mono)"""
    n = max(1, int(frame * rate))
    f = x[:len(x) // n * n].reshape(-1, n).astype(np.float64)
    return 10 * np.log10(np.mean(f ** 2, axis=1) + 1e-12)


def longest_quiet(db: np.ndarray, frame: float, from_s: float, to_s: float, below: float = -50.0) -> tuple[float, float | None]:
    """(length, start) in seconds of the longest stretch under `below` dBFS between two times"""
    a, b = int(from_s / frame), int(to_s / frame)
    best = (0.0, None)
    for s, e in runs(db[a:b] < below):
        if (e - s) * frame > best[0]: best = (round((e - s) * frame, 3), round((a + s) * frame, 3))
    return best


def best_match(ref_db: np.ndarray, got_db: np.ndarray, frame: float, start: float, end: float, search: float = 0.3) -> tuple[float, float]:
    """how well the level curve of the reference voice matches the finished audio around one turn:
    (correlation, lag in seconds) at the lag that fits best. A turn that is missing, or at another time, scores low."""
    a, b = int(start / frame), int(end / frame)
    r = np.clip(ref_db[a:b], -60, 0)
    if len(r) < 5 or r.std() < 1e-6: return 0.0, 0.0
    best = (-1.0, 0.0)
    for lag in range(-int(search / frame), int(search / frame) + 1):
        if a + lag < 0 or b + lag > len(got_db): continue
        g = np.clip(got_db[a + lag:b + lag], -60, 0)
        if g.std() < 1e-6: continue
        c = float(np.corrcoef(r, g)[0, 1])
        if c > best[0]: best = (c, lag * frame)
    return round(best[0], 3), round(best[1], 3)


def spectrum_frames(x: Samples, rate: int, fps: int = 30, bands: int = 40, lo: float = 90.0, hi: float = 6000.0) -> tuple[np.ndarray, np.ndarray]:
    """bars for the video: per frame, `bands` values 0..255 from the spectrum around that moment, and one level
    value 0..255. Bands are spaced evenly in pitch between `lo` and `hi` Hz."""
    size = 1 << int(np.ceil(np.log2(rate * 0.05)))
    frames = int(np.ceil(len(x) / rate * fps)) + 1
    win = np.hanning(size).astype(np.float32)
    freqs = np.fft.rfftfreq(size, 1 / rate)
    edges = np.geomspace(lo, min(hi, rate / 2 * 0.95), bands + 1)
    which = [np.flatnonzero((freqs >= edges[i]) & (freqs < edges[i + 1])) for i in range(bands)]
    nearest = [int(np.argmin(np.abs(freqs - np.sqrt(edges[i] * edges[i + 1])))) for i in range(bands)]
    padded = np.concatenate([np.zeros(size // 2, np.float32), x.astype(np.float32), np.zeros(size, np.float32)])
    power = np.zeros((frames, bands)); level = np.zeros(frames)
    for f0 in range(0, frames, 1024):
        idx = np.arange(f0, min(frames, f0 + 1024))
        starts = np.minimum((idx / fps * rate).astype(np.int64), len(padded) - size)
        seg = padded[starts[:, None] + np.arange(size)[None, :]]
        level[idx] = np.mean(seg.astype(np.float64) ** 2, axis=1)
        spec = np.abs(np.fft.rfft(seg * win, axis=1)) ** 2
        for b in range(bands):
            power[idx, b] = spec[:, which[b]].mean(axis=1) if len(which[b]) else spec[:, nearest[b]]
    def scale(p: np.ndarray, span: float) -> np.ndarray:
        db = 10 * np.log10(p + 1e-12); top = np.percentile(db, 99.7)
        return (np.clip((db - (top - span)) / span, 0, 1) ** 1.25 * 255).astype(np.uint8)
    tilt = 10 ** (np.linspace(0, 18, bands) / 10)  # speech falls off with pitch; lift the upper bars so the row is even
    return scale(power * tilt[None, :], 42.0), scale(level, 36.0)


# ---------------------------------------------------------------- commands

def load_job(path: str) -> dict[str, Any]:
    try: return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e: die(f"cannot read job file {path}: {e}")


def read_wav(path: str | Path, rate: int | None = None) -> tuple[Samples, int]:
    import soundfile as sf
    if not Path(path).is_file(): die(f"audio file not found: {path}")
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if rate and sr != rate: die(f"{path} is {sr} Hz, expected {rate} Hz")
    return x, sr


def load_kokoro() -> Any:
    try:
        from kokoro_onnx import Kokoro
    except ImportError as e:
        die(f"{e}. Install the voice packages into this Python: pip install kokoro-onnx soundfile numpy")
    home = Path(os.environ.get("KOKORO_HOME") or Path.home() / "kokoro")
    model = Path(os.environ.get("KOKORO_MODEL") or home / "kokoro-v1.0.onnx")
    voices = Path(os.environ.get("KOKORO_VOICES") or home / "voices-v1.0.bin")
    for f in (model, voices):
        if not f.is_file(): die(f"Kokoro model file not found: {f}\n  Download kokoro-v1.0.onnx and voices-v1.0.bin (see README.md) or set KOKORO_HOME.")
    return Kokoro(str(model), str(voices))


def cmd_phonemes(job: dict[str, Any]) -> None:
    kokoro = load_kokoro()
    out = [{**item, "ipa": kokoro.tokenizer.phonemize(item["text"], item.get("lang", "en-us"))} for item in job["items"]]
    Path(job["out"]).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")


def cmd_synth(job: dict[str, Any]) -> None:
    import soundfile as sf
    cache = Path(job["cache"]); cache.mkdir(parents=True, exist_ok=True)
    todo = [t for t in job["takes"] if not ((cache / f"{t['key']}.wav").is_file() and (cache / f"{t['key']}.json").is_file())]
    if not todo: return
    kokoro = load_kokoro()
    for i, t in enumerate(todo):
        try: audio, sr = kokoro.create(t["text"], voice=t["voice"], speed=float(t["speed"]), lang=t["lang"])
        except Exception as e: die(f'could not record "{t["text"][:60]}" with voice {t["voice"]} ({t["lang"]}): {e}')
        if sr != R: die(f"the voice model returned {sr} Hz audio, expected {R} Hz")
        y = trim(np.asarray(audio, np.float32))
        if len(y) < R * 0.05 or float(np.max(np.abs(y))) < 0.005: die(f'the voice returned silence for "{t["text"][:60]}"')
        sf.write(str(cache / f"{t['key']}.wav"), y, R, subtype="FLOAT")
        meta = {"dur": round(len(y) / R, 3), "pauses": find_pauses(y), "rms": round(active_rms(y), 5), "text": t["text"], "voice": t["voice"], "speed": t["speed"], "lang": t["lang"]}
        (cache / f"{t['key']}.json").write_text(json.dumps(meta), encoding="utf-8")
        note(f"recorded {i + 1}/{len(todo)}  {t['voice']:12s} {meta['dur']:5.2f}s  {t['text'][:56]}")


def cmd_mix(job: dict[str, Any]) -> None:
    import soundfile as sf
    tl = job["timeline"]; cache = Path(job["cache"]); ch = int(job.get("channels", 2))
    n = int(round(tl["total"] * R))
    clips = {}
    for turn in tl["turns"]:
        for take in turn["takes"]:
            if take["key"] not in clips: clips[take["key"]] = read_wav(cache / f"{take['key']}.wav", R)[0][:, 0]
    by_speaker = {}
    for turn in tl["turns"]: by_speaker.setdefault(turn["speaker"], []).extend(clips[t["key"]] for t in turn["takes"])
    gains = level_gains({k: active_rms(np.concatenate(v)) for k, v in by_speaker.items()})
    voice = np.zeros((n, 2), np.float32)
    for turn in tl["turns"]:
        left, right = pan_gains(tl["speakers"][turn["speaker"]]["pan"] if ch == 2 else 0)
        for take in turn["takes"]:
            y = clips[take["key"]] * gains[turn["speaker"]]
            place(voice[:, 0], take["start"], y * left); place(voice[:, 1], take["start"], y * right)
    music = np.zeros((n, 2), np.float32)
    if tl["music"].get("on"):
        m = tl["music"]
        intro_len = min(tl["total"], m["intro"] + m["under"] + 0.5); outro_at = max(0.0, tl["speechEnd"] - m["outro"]); outro_len = tl["total"] - outro_at
        if job.get("music_file"):
            src = read_wav(job["music_file"], R)[0]
            src = src if src.shape[1] == 2 else np.repeat(src[:, :1], 2, axis=1)
            if len(src) < R: die("the music file is shorter than one second")
            need = int(max(intro_len, outro_len) * R) + 1
            src = np.tile(src, (need // len(src) + 1, 1))[:need]
            bed_in, bed_out = src[:int(intro_len * R)], src[:int(outro_len * R)]
        else:
            bed_in = gen_music(intro_len, m["bpm"], m["chords"]); bed_out = gen_music(outro_len, m["bpm"], m["chords"])
        place(music, 0, bed_in)
        if outro_at >= intro_len: place(music, outro_at, bed_out)
        else: music[int(intro_len * R):] = 0  # an episode this short gets one continuous bed
        env = music_envelope(n, tl) * duck_envelope(voice.mean(axis=1))
        music *= (env * float(m["volume"]))[:, None]
    mix = voice + music
    if ch == 1: mix = mix.mean(axis=1, keepdims=True) * np.sqrt(2); voice = voice.mean(axis=1, keepdims=True) * np.sqrt(2)
    sf.write(job["out_mix"], mix, R, subtype="FLOAT"); sf.write(job["out_voice"], voice, R, subtype="FLOAT")
    report = {"speaker_gain_db": {k: round(20 * float(np.log10(v)), 2) for k, v in gains.items()}, "samples": n, "peak": round(float(np.max(np.abs(mix))), 4)}
    Path(job["out_report"]).write_text(json.dumps(report), encoding="utf-8")


def cmd_viz(job: dict[str, Any]) -> None:
    x, sr = read_wav(job["wav"]); fps = int(job.get("fps", 30)); bands = int(job.get("bands", 40))
    spec, level = spectrum_frames(x.mean(axis=1), sr, fps, bands)
    out = {"fps": fps, "bands": bands, "frames": int(spec.shape[0]), "spectrum": base64.b64encode(spec.tobytes()).decode(), "level": base64.b64encode(level.tobytes()).decode()}
    Path(job["out"]).write_text(json.dumps(out), encoding="utf-8")


def cmd_verify(job: dict[str, Any]) -> None:
    tl = job["timeline"]; frame = 0.02
    got, sr = read_wav(job["wav"]); ref, _ = read_wav(job["voice"], R)
    if sr != R: die(f"verify expects audio decoded to {R} Hz")
    mono = got.mean(axis=1); gdb = envelope_db(mono, sr, frame); rdb = envelope_db(ref.mean(axis=1), R, frame)
    peak = float(np.max(np.abs(got))); hot = np.abs(got).max(axis=1) >= 0.999
    quiet = longest_quiet(gdb, frame, tl["speechStart"], tl["speechEnd"])
    turns = []; levels = {}
    for t in tl["turns"]:
        corr, lag = best_match(rdb, gdb, frame, t["start"], t["end"])
        seg = mono[int(t["start"] * sr):int(t["end"] * sr)]
        rms = active_rms(seg, sr); db = round(20 * float(np.log10(rms + 1e-9)), 1)
        levels.setdefault(t["speaker"], []).append(rms)
        turns.append({"id": t["id"], "speaker": t["speaker"], "start": t["start"], "end": t["end"], "corr": corr, "lag": lag, "db": db})
    speaker_db = {k: round(20 * float(np.log10(np.sqrt(np.mean(np.square(v))) + 1e-9)), 1) for k, v in levels.items()}
    head = envelope_db(mono[:int(0.5 * sr)], sr, frame); tail = envelope_db(mono[-int(0.3 * sr):], sr, frame)
    out = {"duration": round(len(got) / sr, 3), "expected": tl["total"], "peak_db": round(20 * float(np.log10(peak + 1e-9)), 2),
           "clipped_samples": int(hot.sum()), "clipped_runs": int(sum(1 for s, e in runs(hot) if e - s >= 3)),
           "longest_quiet": quiet[0], "longest_quiet_at": quiet[1], "turns": turns, "speaker_db": speaker_db,
           "start_db": round(float(head.max()), 1), "end_db": round(float(tail.max()), 1)}
    Path(job["out"]).write_text(json.dumps(out), encoding="utf-8")


COMMANDS = {"phonemes": cmd_phonemes, "synth": cmd_synth, "mix": cmd_mix, "viz": cmd_viz, "verify": cmd_verify}

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in COMMANDS: die("usage: python audio.py phonemes|synth|mix|viz|verify <job.json>")
    COMMANDS[sys.argv[1]](load_job(sys.argv[2]))
