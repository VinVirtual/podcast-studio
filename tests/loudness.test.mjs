import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEbur128, gainPlan, refineGain, withinTolerance, normaliseFilter, dbToLinear, linearToDb, nextMasterStep, PEAK_MARGIN, LUFS_TOLERANCE, LUFS_SETTLE } from '../engine/lib/loudness.mjs'

const LOG = `[Parsed_ebur128_0 @ 0x1] t: 69.4  TARGET:-23 LUFS    M: -40.1 S: -30.2     I: -99.0 LUFS       LRA:   9.9 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -22.8 LUFS
    Threshold: -33.0 LUFS

  Loudness range:
    LRA:         2.2 LU
    Threshold: -43.0 LUFS
    LRA low:   -24.3 LUFS
    LRA high:  -22.1 LUFS

  True peak:
    Peak:       -2.8 dBFS
`

test('the ffmpeg summary is read, not the running lines before it', () => {
  assert.deepEqual(parseEbur128(LOG), { lufs: -22.8, lra: 2.2, peak: -2.8 })
})

test('silence or a missing summary is an error, not a number', () => {
  assert.throws(() => parseEbur128('Summary:\n I: -inf LUFS'), /loudness/); assert.throws(() => parseEbur128('no output'), /loudness/)
})

test('gain is the distance to the target', () => {
  assert.equal(gainPlan({ lufs: -22.8, peak: -10 }, -16).gain, 6.8); assert.equal(gainPlan({ lufs: -12, peak: -20 }, -16).gain, -4); assert.equal(gainPlan({ lufs: -19, peak: -9 }, -19).gain, 0)
})

test('the limiter is needed exactly when the gained peak passes the ceiling', () => {
  assert.deepEqual(gainPlan({ lufs: -22.8, peak: -2.8 }, -16, -1), { gain: 6.8, over: 5, limited: true })
  assert.deepEqual(gainPlan({ lufs: -22.8, peak: -9 }, -16, -1), { gain: 6.8, over: 0, limited: false })
  assert.deepEqual(gainPlan({ lufs: -22.8, peak: -7.8 }, -16, -1), { gain: 6.8, over: 0, limited: false })
  assert.equal(gainPlan({ lufs: -22.8, peak: NaN }, -16, -1).limited, false)
})

test('a second pass adds what the first pass missed', () => {
  assert.equal(refineGain(6.8, -16.4, -16), 7.2); assert.equal(refineGain(6.8, -15.7, -16), 6.5); assert.equal(refineGain(3, -16, -16), 3)
  assert.ok(withinTolerance(-16.1, -16, 0.1)); assert.ok(!withinTolerance(-16.3, -16, 0.1))
})

test('decibel conversions', () => {
  assert.ok(Math.abs(dbToLinear(-6.0206) - 0.5) < 1e-4); assert.equal(dbToLinear(0), 1); assert.ok(Math.abs(linearToDb(dbToLinear(-1)) + 1) < 1e-9)
})

test('the filter chain resamples, sets channels, and limits at 4x the sample rate so peaks between samples are caught', () => {
  const f = normaliseFilter({ gain: 6.8, ceiling: -1, sampleRate: 44100, channels: 2 })
  assert.equal(f, 'aresample=44100:resampler=soxr,aformat=channel_layouts=stereo,aresample=176400:resampler=soxr,volume=6.80dB,alimiter=limit=0.8913:attack=4:release=60:level=false:latency=true,aresample=44100:resampler=soxr')
  assert.ok(normaliseFilter({ gain: -2, channels: 1, sampleRate: 48000 }).includes('channel_layouts=mono,aresample=192000:resampler=soxr,volume=-2.00dB'))
  assert.equal(normaliseFilter({ gain: 1, limit: false, sampleRate: 44100 }), 'aresample=44100:resampler=soxr,aformat=channel_layouts=stereo,volume=1.00dB')
  assert.ok(!normaliseFilter({ gain: 1, resampler: 'swr' }).includes('soxr'))
})

test('master loop: done when every file is under the ceiling and within the loudness tolerance', () => {
  const s = nextMasterStep({ files: [{ lufs: -16.2, peak: -1.2 }, { lufs: -15.9, peak: -1.0 }], master: { lufs: -16, peak: -1.3 }, target: -16, ceiling: -1, aim: -16, margin: PEAK_MARGIN })
  assert.equal(s.done, true); assert.equal(s.margin, PEAK_MARGIN); assert.equal(s.aim, -16)
  assert.equal(nextMasterStep({ files: [{ lufs: -16, peak: -2 }], master: { lufs: -16, peak: -0.8 }, target: -16, ceiling: -1, aim: -16, margin: 0.3 }).done, false, 'the master peak counts too')
})

test('master loop: a peak over the ceiling widens the margin by the overshoot plus a little', () => {
  const s = nextMasterStep({ files: [{ lufs: -16, peak: -0.7 }, { lufs: -16, peak: -1.4 }], target: -16, ceiling: -1, aim: -16, margin: 0.3 })
  assert.equal(s.done, false); assert.equal(s.peak, -0.7); assert.equal(s.margin, 0.7); assert.equal(s.aim, -16)
})

test('master loop: files that come out quiet raise the level the master aims at', () => {
  const s = nextMasterStep({ files: [{ lufs: -16.7, peak: -2 }, { lufs: -16.5, peak: -2 }], target: -16, ceiling: -1, aim: -16, margin: 0.3 })
  assert.equal(s.done, false); assert.equal(s.err, -0.6); assert.equal(s.aim, -15.4); assert.equal(s.margin, 0.3)
  const edge = nextMasterStep({ files: [{ lufs: -16.5, peak: -2 }], master: { lufs: -16, peak: -2 }, target: -16, ceiling: -1, aim: -16, margin: 0.3 })
  assert.equal(edge.done, false, 'inside what verify accepts, but the loop aims tighter'); assert.equal(edge.aim, -15.5)
  assert.equal(nextMasterStep({ files: [{ lufs: -16.3, peak: -2 }], target: -16, ceiling: -1, aim: -16, margin: 0.3 }).done, true)
  assert.ok(LUFS_SETTLE < LUFS_TOLERANCE)
})
