import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stamp, cues, toVtt, toSrt, splitLong } from '../engine/lib/captions.mjs'
import { timelineOf } from './fixtures.mjs'

const W = (text, t0 = 0, step = 0.3) => text.split(' ').map((w, i) => ({ w, t: +(t0 + i * step).toFixed(3), e: +(t0 + i * step + step * 0.9).toFixed(3) }))
const TL = { total: 20, speakers: { a: { name: 'Ana' }, b: { name: 'Ben & <Co>' } }, turns: [
  { id: 't01', speaker: 'a', words: W('Hello there. This is a rather long sentence that will need more than one caption, because it keeps on going for a while.', 1) },
  { id: 't02', speaker: 'b', words: W('Is 1 < 2?', 12) },
] }

test('stamp formats hours, minutes, seconds and milliseconds', () => {
  assert.equal(stamp(0), '00:00:00.000'); assert.equal(stamp(3725.0416), '01:02:05.042'); assert.equal(stamp(1.5, ','), '00:00:01,500')
})

test('cues keep every word once, in order, and never cross a turn', () => {
  const q = cues(TL)
  assert.equal(q.map((c) => c.text).join(' '), TL.turns.map((t) => t.words.map((w) => w.w).join(' ')).join(' '))
  for (const c of q) assert.ok(c.text.length <= 64, c.text)
  assert.deepEqual([...new Set(q.map((c) => c.turn))], ['t01', 't02'])
  assert.deepEqual(q.filter((c) => c.first).map((c) => c.turn), ['t01', 't02'])
})

test('cues run forward, do not overlap and end soon after their last word', () => {
  const q = cues(TL)
  q.forEach((c, i) => { assert.ok(c.end > c.start); if (i) assert.ok(c.start >= q[i - 1].end - 1e-9) })
  const last = q[q.length - 1]
  assert.ok(last.end <= last.words[last.words.length - 1].e + 0.4 + 1e-9)
})

test('long sentences are cut near a comma and never leave a single word alone when it fits', () => {
  const pieces = splitLong(W('one two three four five six, seven eight nine ten eleven twelve'), 40)
  assert.ok(pieces.length >= 2); assert.ok(pieces[0][pieces[0].length - 1].w.endsWith(','))
  for (const p of pieces) assert.ok(p.map((w) => w.w).join(' ').length <= 40)
  assert.equal(splitLong(W('short one'), 40).length, 1)
  const tail = splitLong(W('aaaa bbbb cccc dddd eeee ffff g'), 16)
  assert.ok(tail.every((p) => p.map((w) => w.w).join(' ').length <= 16))
})

test('vtt has a voice tag on every cue and escapes markup', () => {
  const vtt = toVtt(TL)
  assert.ok(vtt.startsWith('WEBVTT\n\n1\n00:00:01.000 --> '))
  assert.ok(vtt.includes('<v Ana>Hello there.')); assert.ok(vtt.includes('<v Ben Co>Is 1 &lt; 2?'))
  assert.equal((vtt.match(/<v /g) || []).length, cues(TL).length)
})

test('srt names the speaker on the first cue of each turn only', () => {
  const srt = toSrt(TL), blocks = srt.trim().split('\n\n')
  assert.match(blocks[0], /^1\n00:00:01,000 --> \d\d:\d\d:\d\d,\d{3}\nAna: Hello there\./)
  assert.equal((srt.match(/^Ana: /gm) || []).length, 1); assert.equal((srt.match(/^Ben & <Co>: /gm) || []).length, 1)
  blocks.forEach((b, i) => assert.ok(b.startsWith(`${i + 1}\n`)))
})

test('captions from a laid out episode cover each turn inside its time', () => {
  const { timeline } = timelineOf()
  for (const c of cues(timeline)) { const t = timeline.turns.find((x) => x.id === c.turn); assert.ok(c.start >= t.start - 1e-6 && c.start < t.end) }
})
