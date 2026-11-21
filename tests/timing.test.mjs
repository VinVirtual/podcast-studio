import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gapBefore, GAPS, jitter, wordTimes, matchPauses, layout, estimateMetas, speakerTable, syllables, LEAD, TAIL, MIN_PAUSE } from '../engine/lib/timing.mjs'
import { EPISODE, timelineOf, clone } from './fixtures.mjs'

const turn = (o) => ({ index: 1, segment: 0, speaker: 'a', say: 'A full sentence that is long enough.', ...o })
const near = (x, base) => Math.abs(x - base) <= GAPS.jitter + 1e-9

test('the first turn has no gap and every other gap is positive', () => {
  assert.equal(gapBefore(null, turn({})), 0)
  for (let i = 1; i < 40; i++) assert.ok(gapBefore(turn({ speaker: 'b' }), turn({ index: i })) > 0)
})

test('gap rules: new chapter is longest, an answer after a question is quick, a short reaction is quickest', () => {
  const prev = turn({ speaker: 'b', index: 0 })
  assert.ok(near(gapBefore(prev, turn({})), GAPS.turn))
  assert.ok(near(gapBefore(prev, turn({ segment: 1 })), GAPS.chapter))
  assert.ok(near(gapBefore(prev, turn({ speaker: 'b' })), GAPS.sameSpeaker))
  assert.ok(near(gapBefore(turn({ speaker: 'b', say: 'Why is that?' }), turn({})), GAPS.afterQuestion))
  assert.ok(near(gapBefore(prev, turn({ say: 'Oh, right.' })), GAPS.reaction))
  assert.ok(GAPS.chapter > GAPS.sameSpeaker && GAPS.sameSpeaker > GAPS.turn && GAPS.turn > GAPS.afterQuestion && GAPS.afterQuestion > GAPS.reaction)
})

test('a gap set on the turn wins, pace scales the rest, and a gap is never negative', () => {
  const prev = turn({ speaker: 'b', index: 0 })
  assert.equal(gapBefore(prev, turn({ gap: 1.5 })), 1.5); assert.equal(gapBefore(prev, turn({ gap: -2 })), 0)
  assert.ok(Math.abs(gapBefore(prev, turn({}), 2) - 2 * gapBefore(prev, turn({}), 1)) < 0.002)
})

test('jitter is repeatable and stays within one unit', () => {
  for (let i = 0; i < 100; i++) { assert.ok(Math.abs(jitter(i)) <= 1); assert.equal(jitter(i), jitter(i)) }
  assert.ok(new Set([...Array(11).keys()].map(jitter)).size > 5)
})

test('words share a sentence by syllables, in order, and end with the recording', () => {
  const w = wordTimes(['A', 'compiler', 'translates.'], 2, [])
  assert.equal(w[0].t, 0); assert.equal(w[2].e, 2)
  for (let i = 1; i < w.length; i++) assert.ok(w[i].t >= w[i - 1].e - 1e-9)
  assert.ok(w[1].e - w[1].t > w[0].e - w[0].t)
  assert.deepEqual(wordTimes([], 1, []), [])
  assert.equal(syllables('compiler'), 3); assert.equal(syllables('—'), 1)
})

test('a real pause is pinned to its comma: the word before ends at the pause and the next starts after it', () => {
  const w = wordTimes(['Hello,', 'big', 'world.'], 2, [[0.5, 0.7]])
  assert.equal(w[0].e, 0.5); assert.equal(w[1].t, 0.7); assert.equal(w[2].e, 2)
})

test('silences shorter than a pause, or touching the ends, are ignored', () => {
  const plain = wordTimes(['Hello,', 'big', 'world.'], 2, [])
  assert.deepEqual(wordTimes(['Hello,', 'big', 'world.'], 2, [[0.5, 0.5 + MIN_PAUSE / 2]]), plain)
  assert.deepEqual(wordTimes(['Hello,', 'big', 'world.'], 2, [[0, 0.4], [1.7, 2]]), plain)
  assert.deepEqual(wordTimes(['No', 'commas', 'here'], 2, [[0.8, 1.2]]), wordTimes(['No', 'commas', 'here'], 2, []))
})

test('with fewer pauses than commas each pause goes to the nearest comma, in order', () => {
  assert.deepEqual(matchPauses([1, 2], [0.2, 1.1, 2.2]), [1, 2]); assert.deepEqual(matchPauses([0.3], [0.2, 1.1, 2.2]), [0])
  assert.deepEqual(matchPauses([1, 1.2], [0.9, 1.0, 3]), [0, 1]); assert.deepEqual(matchPauses([], [1]), [])
  const words = 'Good, because I write some code, press a button, and it runs.'.split(' ')
  const w = wordTimes(words, 4.2, [[1.7, 2.05], [2.8, 3.0]])
  assert.equal(w[5].e, 1.7); assert.equal(w[6].t, 2.05); assert.equal(w[8].e, 2.8); assert.equal(w[9].t, 3)
})

test('layout: turns never overlap, follow the script order and start after the intro music', () => {
  const { ep, timeline } = timelineOf()
  assert.equal(timeline.speechStart, ep.music.intro); assert.equal(timeline.turns[0].start, ep.music.intro)
  timeline.turns.forEach((t, i) => { assert.ok(t.end > t.start); if (i) assert.ok(t.start > timeline.turns[i - 1].end) })
  assert.equal(timeline.total, Math.round((timeline.speechEnd + ep.music.tail) * 1000) / 1000)
})

test('layout without music starts after a short lead and ends after a short tail', () => {
  const { timeline } = timelineOf(EPISODE, { music: { on: false } })
  assert.equal(timeline.speechStart, LEAD); assert.ok(Math.abs(timeline.total - timeline.speechEnd - TAIL) < 0.002); assert.deepEqual(timeline.music, { on: false })
})

test('layout: every word lies inside its turn and words run forward in time', () => {
  const { timeline } = timelineOf()
  for (const t of timeline.turns) {
    assert.equal(t.words.length, t.say.split(/\s+/).length)
    t.words.forEach((w, i) => { assert.ok(w.t >= t.start - 1e-6 && w.e <= t.end + 1e-6); if (i) assert.ok(w.t >= t.words[i - 1].t) })
  }
})

test('layout: sentences of one turn are separated by the sentence gap and takes sit where the mix will put them', () => {
  const { timeline } = timelineOf(), t = timeline.turns[3]
  assert.equal(t.takes.length, 2)
  assert.ok(Math.abs(t.takes[1].start - (t.takes[0].start + t.takes[0].dur + GAPS.sentence)) < 0.002)
  assert.ok(Math.abs(t.end - (t.takes[1].start + t.takes[1].dur)) < 0.002)
})

test('layout fails clearly when a recording is missing', () => {
  const { ep, turns } = timelineOf(), metas = estimateMetas(turns); delete metas[turns[2].takes[0].key]
  assert.throws(() => layout(ep, turns, metas), /no recording for turn t03/)
})

test('a slower speaker takes longer for the same words', () => {
  const a = clone(EPISODE), b = clone(EPISODE); b.speakers.ana.speed = 0.8
  assert.ok(timelineOf(b).timeline.total > timelineOf(a).timeline.total)
})

test('speakers get a colour and sit slightly left and right; one speaker sits in the centre', () => {
  const two = speakerTable(EPISODE)
  assert.ok(two.ana.pan < 0 && two.ben.pan > 0 && two.ana.pan === -two.ben.pan); assert.match(two.ana.color, /^#[0-9a-f]{6}$/)
  assert.equal(speakerTable({ speakers: { solo: { voice: 'af_heart' } } }).solo.pan, 0)
  assert.equal(speakerTable({ speakers: { solo: { voice: 'af_heart', pan: 5, color: '#123456' } } }).solo.pan, 1)
})
