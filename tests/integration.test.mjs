// The real mix, normalise, encode and verify path, with a stub voice: every sentence is a harmonic tone
// with a syllable rhythm, written straight into the recording cache, so no voice model is needed.
// Needs Python with numpy and soundfile, and ffmpeg with libmp3lame; skipped when they are missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findPython, findFF } from '../engine/lib/env.mjs'
import { withDefaults, flattenTurns } from '../engine/lib/episode.mjs'
import { estimateMetas } from '../engine/lib/timing.mjs'
import { makeAudio, verify, paths } from '../engine/lib/audio.mjs'
import { EPISODE, clone } from './fixtures.mjs'

const RATE = 24000
function missingTools() {
  try { findFF() } catch (e) { return e.message }
  const py = spawnSync(findPython(), ['-c', 'import numpy, soundfile'], { encoding: 'utf8' })
  return py.status === 0 ? null : `Python with numpy and soundfile not found (${findPython()})`
}
const SKIP = missingTools()

/** mono 32-bit float WAV */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 4), head = Buffer.alloc(44)
  samples.forEach((v, i) => data.writeFloatLE(v, i * 4))
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(32, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** A stand-in for one recorded sentence: a voice-like tone whose loudness rises and falls like syllables,
    with a short sharp burst at the start of each syllable like a plosive. Its peaks sit well above its
    loudness, as real speech's do, so normalising to a loud target makes the limiter work. */
function stubTake(dur, f0, seed) {
  const n = Math.round(dur * RATE), out = new Float32Array(n), rate = 4.3 + (seed % 5) * 0.2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE, phase = (t * rate) % 1, syll = Math.sin(Math.PI * phase) ** 6, edge = Math.min(1, t / 0.02, (dur - t) / 0.02)
    let v = 0
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f0 * k * t * (1 + 0.02 * Math.sin(2 * Math.PI * 3 * t))) / k
    const burst = Math.exp(-phase / rate / 0.004) * Math.sin(2 * Math.PI * 2700 * t)
    out[i] = (0.12 * v * syll + 0.75 * burst) * edge; sum += out[i] ** 2
  }
  return { samples: out, rms: Math.sqrt(sum / n) }
}

function stubProject(lufs, formats) {
  const P = mkdtempSync(join(tmpdir(), `podcast-int-${-lufs}-`)), ep = withDefaults({ ...clone(EPISODE), audio: { channels: 2, lufs, formats, bitrate: '96k' } })
  writeFileSync(join(P, 'episode.json'), JSON.stringify(ep))
  const dir = paths(P).takes; mkdirSync(dir, { recursive: true })
  const turns = flattenTurns(ep), metas = estimateMetas(turns), F0 = { af_heart: 205, am_michael: 115 }
  turns.forEach((turn) => turn.takes.forEach((take, j) => {
    const { samples, rms } = stubTake(metas[take.key].dur, F0[take.voice], turn.index * 3 + j)
    writeFileSync(join(dir, `${take.key}.wav`), wav(samples))
    writeFileSync(join(dir, `${take.key}.json`), JSON.stringify({ dur: metas[take.key].dur, pauses: [], rms, text: take.text, voice: take.voice, speed: take.speed, lang: take.lang }))
  }))
  return { P, ep }
}

for (const [lufs, formats] of [[-16, ['mp3', 'm4a']], [-14, ['mp3']], [-12, ['mp3']]]) {
  test(`stub voices through the real pipeline reach ${lufs} LUFS with every true peak under the ceiling`, { skip: SKIP || false, timeout: 600000 }, async (t) => {
    const { P, ep } = stubProject(lufs, formats)
    t.after(() => rmSync(P, { recursive: true, force: true }))
    const { report, plan } = await makeAudio(P, ep)
    assert.equal(plan.record.length, 0, 'the stub takes are used, nothing is recorded')
    assert.equal(report.settled, true, JSON.stringify({ rounds: report.rounds, margin: report.margin, files: report.files }))
    assert.ok(report.mix.peak - report.mix.lufs > 15, `the stub is peaky like speech (${report.mix.peak - report.mix.lufs} dB)`)
    if (lufs > -16) assert.ok(report.limiterReduction > 0, 'at a loud target the limiter has to work')
    assert.equal(report.files.length, formats.length)
    for (const f of report.files) {
      assert.ok(existsSync(f.file))
      assert.ok(f.peak <= ep.audio.peak, `${f.format} true peak ${f.peak} over ${ep.audio.peak}`)
      assert.ok(Math.abs(f.lufs - lufs) <= 0.5, `${f.format} at ${f.lufs} LUFS, target ${lufs}`)
      assert.equal(f.chapters, 2)
    }
    const v = await verify(P, ep)
    assert.deepEqual(v.checks.filter((c) => !c.ok), [])
    assert.equal(v.measured.turns.length, 6)
  })
}
