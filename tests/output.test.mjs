// Show notes, the verify verdict, the report text and the frames picked for the review sheet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNotes, DISCLOSURE } from '../engine/lib/notes.mjs'
import { judge, formatChecks, THRESHOLDS } from '../engine/lib/verify.mjs'
import { tags, formatReport } from '../engine/lib/audio.mjs'
import { sheetTimes, videoPath } from '../engine/lib/video.mjs'
import { timelineOf } from './fixtures.mjs'

test('notes hold the title, summary, disclosure, chapters with times, voices and every line of the transcript', () => {
  const { ep, timeline } = timelineOf(), md = toNotes(ep, timeline)
  assert.ok(md.startsWith('# A test\n\n*Test Show · Episode 3 · '))
  assert.ok(md.includes('A summary.')); assert.ok(md.includes(`> ${DISCLOSURE}`))
  assert.ok(md.includes('## Chapters\n\n- `0:00` Opening\n- `0:')); assert.ok(md.includes('- **Ana**: explains (synthetic voice `af_heart`)'))
  for (const t of timeline.turns) assert.ok(md.includes(t.say), t.say)
  assert.ok(md.indexOf('### Opening') < md.indexOf('### Why')); assert.ok(md.indexOf('### Why') < md.indexOf('The moon pulls'))
  assert.equal((md.match(/\*\*Ben\*\* `/g) || []).length, 3); assert.ok(!/\n{3}/.test(md))
})

test('notes name the source when there is one and can leave the disclosure out', () => {
  const { ep, timeline } = timelineOf()
  assert.ok(toNotes({ ...ep, source: { title: 'Tides', url: 'https://example.org/tides', author: 'A. Writer' } }, timeline).includes('spoken version of [Tides](https://example.org/tides), by A. Writer.'))
  assert.ok(!toNotes({ ...ep, disclosure: false }, timeline).includes(DISCLOSURE)); assert.ok(!toNotes(ep, timeline).includes('## Source'))
})

const GOOD = { duration: 69.49, expected: 69.493, lufs: -16.2, target: -16, ceiling: -1, truePeak: -1.1, clipped_runs: 0, longest_quiet: 0.98, longest_quiet_at: 19.3,
  turns: [{ id: 't01', corr: 0.82, lag: 0, db: -19 }, { id: 't02', corr: 0.95, lag: 0.02, db: -18 }], speaker_db: { ana: -18.6, ben: -18.8 } }

test('a good file passes every check', () => {
  const c = judge(GOOD)
  assert.equal(c.length, 6); assert.ok(c.every((x) => x.ok)); assert.match(formatChecks(c), /^ok   duration/)
  assert.match(c[4].detail, /2 turns found; weakest match 0.82 \(t01\), largest offset 20 ms/)
})

test('each fault fails its own check', () => {
  const failed = (patch) => judge({ ...GOOD, ...patch }).filter((x) => !x.ok).map((x) => x.name)
  assert.deepEqual(failed({ duration: 60 }), ['duration']); assert.deepEqual(failed({ lufs: -19 }), ['loudness'])
  assert.deepEqual(failed({ truePeak: 0.2 }), ['no clipping']); assert.deepEqual(failed({ clipped_runs: 2 }), ['no clipping'])
  assert.deepEqual(failed({ longest_quiet: THRESHOLDS.quiet + 1 }), ['no long silence'])
  assert.deepEqual(failed({ turns: [GOOD.turns[0], { id: 't02', corr: 0.1, lag: 0, db: -70 }] }), ['every turn at its time'])
  assert.deepEqual(failed({ turns: [GOOD.turns[0], { id: 't02', corr: 0.9, lag: 0.25, db: -18 }] }), ['every turn at its time'])
  assert.deepEqual(failed({ turns: [] }), ['every turn at its time']); assert.deepEqual(failed({ speaker_db: { ana: -14, ben: -20 } }), ['speakers equally loud'])
  assert.match(formatChecks(judge({ ...GOOD, lufs: -19 })), /FAIL loudness/)
})

test('the peak limit comes from the episode ceiling, and every failure says how to fix it', () => {
  const peak = (truePeak, ceiling) => judge({ ...GOOD, truePeak, ceiling }).find((c) => c.name === 'no clipping').ok
  assert.equal(peak(-1.1, -1), true); assert.equal(peak(-0.9, -1), false); assert.equal(peak(-1.6, -1.5), true); assert.equal(peak(-1.4, -1.5), false); assert.equal(peak(-0.5, -0.3), true)
  const bad = judge({ ...GOOD, duration: 1, lufs: -12, truePeak: 0, longest_quiet: 5, turns: [], speaker_db: { a: -10, b: -20 } })
  assert.ok(bad.every((c) => !c.ok && c.fix && c.fix.length > 20), JSON.stringify(bad))
  assert.ok(judge(GOOD).every((c) => !c.fix))
  assert.match(formatChecks(judge({ ...GOOD, truePeak: -0.2 })), /FAIL no clipping .*\n {5}fix: lower audio\.lufs/)
  assert.match(judge({ ...GOOD, lufs: -16.6 }).find((c) => c.name === 'loudness').detail, /± 0.5/); assert.equal(judge({ ...GOOD, lufs: -16.6 })[1].ok, false)
})

test('tags carry the title, show, episode number and the disclosure', () => {
  const t = tags({ title: 'T', show: 'S', episode: 2 })
  assert.equal(t.title, 'T'); assert.equal(t.album, 'S'); assert.equal(t.artist, 'S'); assert.equal(t.track, 2); assert.equal(t.comment, DISCLOSURE)
  assert.equal(tags({ title: 'T', show: 'S', disclosure: false }).comment, undefined); assert.equal(tags({ title: 'T', show: 'S', author: 'A' }).artist, 'A')
})

test('the audio report says what was measured and whether the limiter worked', () => {
  const r = { total: 69.5, turns: 12, recorded: 1, reused: 19, target: -16, ceiling: -1, mix: { lufs: -22.8, peak: -2.8 }, gain: 7, limiterReduction: 5, speakerGainDb: { a: 0.24, b: -0.24 }, rounds: 2, margin: 0.6, settled: true, unused: 3,
    files: [{ format: 'mp3', lufs: -16.3, peak: -0.7, lra: 2.4, chapters: 4, bytes: 696206, file: 'out/episode.mp3' }] }
  const text = formatReport(r)
  assert.match(text, /1 sentence\(s\) recorded now, 19 reused/); assert.match(text, /\+7\.0 dB to reach -16 LUFS; the limiter holds true peaks under -1 dBFS \(up to 5\.0 dB/)
  assert.match(text, /2 round\(s\) of normalise, encode and measure; limiter set 0\.6 dB under the ceiling\n/)
  assert.match(text, /3 recording\(s\) in build\/takes are no longer in the script; podcast clean removes them/)
  assert.match(formatReport({ ...r, settled: false }), /NOT SETTLED/)
  assert.match(text, /mp3 +-16\.3 LUFS measured, true peak -0\.7 dBFS, range 2\.4 LU, 4 chapter\(s\), 696 kB/); assert.match(text, /a \+0\.24 dB, b -0\.24 dB/)
  assert.match(formatReport({ ...r, limiterReduction: 0 }), /no limiting needed/)
})

test('the review sheet shows the intro, the longest caption, every chapter and the outro, in time order', () => {
  const { timeline } = timelineOf(), picks = sheetTimes(timeline, 9), what = picks.map((p) => p.what)
  for (const w of ['intro', 'longest caption', 'chapter 1', 'chapter 2', 'outro']) assert.ok(what.includes(w), w)
  assert.ok(picks.length <= 9); picks.forEach((p, i) => { assert.ok(p.t >= 0 && p.t <= timeline.total); if (i) assert.ok(p.t >= picks[i - 1].t) })
  assert.ok(sheetTimes(timeline, 5).length <= 5)
})

test('video files are named after the format, and the size when it is not 1080', () => {
  assert.ok(videoPath('/p', { format: 'square', size: 1080 }).endsWith('/p/out/episode-square.mp4')); assert.ok(videoPath('/p', { format: 'vertical', size: 720 }).endsWith('episode-vertical-720.mp4'))
})
