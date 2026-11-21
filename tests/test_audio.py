"""Tests for the signal helpers in engine/audio.py. They need numpy only: no voice model, no audio files.

Run with pytest, or without it: python tests/run_py_tests.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))
import audio as A  # noqa: E402

R = A.R


def tone(seconds: float, freq: float = 220.0, amp: float = 0.3, rate: int = R) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (np.sin(2 * np.pi * freq * t) * amp).astype(np.float32)


def silence(seconds: float, rate: int = R) -> np.ndarray:
    return np.zeros(int(seconds * rate), np.float32)


def test_trim_removes_silence_at_both_ends_and_keeps_a_small_pad() -> None:
    x = np.concatenate([silence(0.5), tone(1.0), silence(0.7)])
    y = A.trim(x)
    assert abs(len(y) / R - 1.04) < 0.03
    assert len(A.trim(silence(0.3))) == len(silence(0.3))


def test_runs_finds_every_stretch_of_true() -> None:
    assert A.runs(np.array([0, 1, 1, 0, 1, 0, 0, 1], bool)) == [(1, 3), (4, 5), (7, 8)]
    assert A.runs(np.array([1, 1], bool)) == [(0, 2)]
    assert A.runs(np.array([], bool)) == []


def test_find_pauses_reports_inner_silences_only() -> None:
    x = np.concatenate([tone(0.6), silence(0.3), tone(0.5), silence(0.03), tone(0.4)])
    pauses = A.find_pauses(x)
    assert len(pauses) == 1
    assert abs(pauses[0][0] - 0.6) < 0.03 and abs(pauses[0][1] - 0.9) < 0.03
    assert A.find_pauses(np.concatenate([silence(0.3), tone(0.5), silence(0.3)])) == []
    assert A.find_pauses(silence(0.5)) == []


def test_active_rms_ignores_the_silent_parts() -> None:
    loud = tone(1.0, amp=0.3)
    assert abs(A.active_rms(loud) - 0.3 / np.sqrt(2)) < 0.005
    assert abs(A.active_rms(np.concatenate([loud, silence(3.0)])) - A.active_rms(loud)) < 0.005
    assert A.active_rms(silence(1.0)) == 0.0


def test_level_gains_bring_speakers_to_the_same_level() -> None:
    g = A.level_gains({"a": 0.1, "b": 0.2})
    assert abs(0.1 * g["a"] - 0.2 * g["b"]) < 1e-6
    assert abs(g["a"] * g["b"] - 1.0) < 1e-6
    assert abs(A.level_gains({"a": 0.1})["a"] - 1.0) < 1e-6
    wide = A.level_gains({"a": 0.001, "b": 1.0})
    assert abs(wide["a"] - 10 ** (6 / 20)) < 1e-6  # never more than 6 dB
    assert A.level_gains({"a": 0.0, "b": 0.2})["a"] == 1.0


def test_pan_gains_keep_the_power_constant() -> None:
    for pan in (-1, -0.18, 0, 0.18, 1, 5):
        left, right = A.pan_gains(pan)
        assert abs(left ** 2 + right ** 2 - 1) < 1e-9
    assert abs(A.pan_gains(0)[0] - A.pan_gains(0)[1]) < 1e-9
    assert A.pan_gains(-0.5)[0] > A.pan_gains(-0.5)[1]


def test_place_adds_at_the_right_sample_and_drops_what_falls_outside() -> None:
    buf = np.zeros(R, np.float32)
    A.place(buf, 0.5, np.ones(100, np.float32))
    assert buf[int(0.5 * R) - 1] == 0 and buf[int(0.5 * R)] == 1 and buf[int(0.5 * R) + 99] == 1 and buf[int(0.5 * R) + 100] == 0
    A.place(buf, 0.999, np.ones(1000, np.float32))
    assert len(buf) == R
    A.place(buf, 2.0, np.ones(10, np.float32))
    A.place(buf, 0.5, np.ones(100, np.float32))
    assert buf[int(0.5 * R)] == 2


TL = {"total": 60.0, "speechStart": 2.5, "speechEnd": 56.0, "music": {"intro": 2.5, "under": 5.0, "outro": 3.0, "tail": 4.0}}


def test_music_envelope_is_full_in_the_intro_gone_in_the_middle_and_back_for_the_outro() -> None:
    env = A.music_envelope(int(60 * R), TL)
    at = lambda s: float(env[int(s * R)])  # noqa: E731
    assert at(0) == 0 and at(1.0) == 1 and at(2.4) == 1
    assert 0.4 < at(5.0) < 0.6
    assert at(8.0) == 0 and at(30.0) == 0 and at(52.9) == 0
    assert 0.4 < at(54.5) < 0.6
    assert at(56.5) == 1
    assert at(59.5) < 0.3 and float(env[-1]) < 0.01
    assert env.min() >= 0 and env.max() <= 1


def test_duck_envelope_is_low_under_speech_and_full_in_silence() -> None:
    voice = np.concatenate([silence(1.0), tone(1.0, amp=0.3), silence(1.0)])
    d = A.duck_envelope(voice)
    assert d[int(0.3 * R)] == 1 and d[int(2.7 * R)] == 1
    assert abs(d[int(1.5 * R)] - 0.28) < 0.02
    assert d.min() >= 0.27


def test_chords_are_built_on_the_right_notes() -> None:
    a_minor = A.chord_freqs("Am")
    assert abs(a_minor[0] - 220) < 0.01 and abs(a_minor[1] / a_minor[0] - 2 ** (3 / 12)) < 1e-9
    c_major = A.chord_freqs("C")
    assert abs(c_major[0] - 261.63) < 0.05 and abs(c_major[2] / c_major[0] - 2 ** (7 / 12)) < 1e-9
    assert abs(A.chord_freqs("Bb")[0] - 233.08) < 0.05
    assert abs(A.chord_freqs("F#m")[0] * 2 - 369.99) < 0.05


def test_generated_music_is_stereo_repeatable_and_does_not_clip() -> None:
    m = A.gen_music(6.0)
    assert m.shape == (6 * R, 2)
    assert 0.05 < float(np.abs(m).max()) < 1.0
    assert np.array_equal(m, A.gen_music(6.0))
    assert not np.array_equal(m[:, 0], m[:, 1])
    assert A.gen_music(0).shape == (0, 2)


def test_longest_quiet_finds_the_longest_gap_between_two_times() -> None:
    x = np.concatenate([tone(1.0), silence(0.4), tone(1.0), silence(1.2), tone(1.0), silence(3.0)])
    db = A.envelope_db(x, R, 0.02)
    length, at = A.longest_quiet(db, 0.02, 0.0, 4.6)
    assert abs(length - 1.2) < 0.05 and abs(at - 2.4) < 0.05
    assert A.longest_quiet(A.envelope_db(tone(2.0), R, 0.02), 0.02, 0.0, 2.0) == (0.0, None)


def speechlike(seconds: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * R)) / R
    shape = np.abs(np.sin(2 * np.pi * rng.uniform(1.5, 3.5) * t + rng.uniform(0, 3))) ** 2 * np.abs(np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 3)))
    return (rng.standard_normal(len(t)) * shape * 0.2).astype(np.float32)


def test_best_match_finds_a_turn_where_it_is_and_not_where_it_is_not() -> None:
    ref = np.concatenate([silence(1.0), speechlike(3.0, 1), silence(1.0), speechlike(3.0, 2), silence(1.0)])
    frame = 0.02
    rdb = A.envelope_db(ref, R, frame)
    corr, lag = A.best_match(rdb, A.envelope_db(ref * 2 + 0.001, R, frame), frame, 1.0, 4.0)
    assert corr > 0.95 and lag == 0.0
    shifted = np.concatenate([silence(0.1), ref])
    corr, lag = A.best_match(rdb, A.envelope_db(shifted, R, frame), frame, 1.0, 4.0)
    assert corr > 0.9 and abs(lag - 0.1) < 0.021
    missing = ref.copy()
    missing[int(1.0 * R):int(4.0 * R)] = 0
    corr, _ = A.best_match(rdb, A.envelope_db(missing, R, frame), frame, 1.0, 4.0)
    assert corr < 0.5
    swapped = np.concatenate([silence(1.0), speechlike(3.0, 9), silence(5.0)])
    corr, _ = A.best_match(rdb, A.envelope_db(swapped, R, frame), frame, 1.0, 4.0)
    assert corr < 0.6


def test_spectrum_frames_give_one_row_per_video_frame_and_follow_the_pitch() -> None:
    x = np.concatenate([tone(1.0, 200.0), tone(1.0, 3000.0), silence(1.0)])
    spec, level = A.spectrum_frames(x, R, fps=30, bands=40)
    assert spec.shape == (91, 40) and level.shape == (91,)
    assert spec.dtype == np.uint8 and level.dtype == np.uint8
    low, high, quiet = spec[15], spec[45], spec[85]
    assert int(np.argmax(low)) < 15 < 25 < int(np.argmax(high))
    assert quiet.max() == 0 and level[85] == 0 and level[15] > 200
