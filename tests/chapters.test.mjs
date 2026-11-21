import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, chapterList, toFfmetadata, parseFfmetadata, toChapterText, toChapterJson } from '../engine/lib/chapters.mjs'
import { timelineOf } from './fixtures.mjs'

const SEGS = [{ title: 'One' }, { title: 'Empty' }, { title: 'Two' }, {}]
const TURNS = [{ segment: 0, start: 2.6 }, { segment: 0, start: 9 }, { segment: 2, start: 61.25 }, { segment: 3, start: 3700 }]

test('clock writes M:SS and H:MM:SS', () => {
  assert.equal(clock(0), '0:00'); assert.equal(clock(59.999), '0:59'); assert.equal(clock(60), '1:00'); assert.equal(clock(754.2), '12:34'); assert.equal(clock(3725), '1:02:05')
})

test('chapters: the first starts at zero, each ends where the next starts, the last ends with the episode', () => {
  const c = chapterList(SEGS, TURNS, 3800)
  assert.deepEqual(c, [{ title: 'One', start: 0, end: 61.25 }, { title: 'Two', start: 61.25, end: 3700 }, { title: 'Part 4', start: 3700, end: 3800 }])
})

test('line breaks and runs of spaces in a chapter title become one space', () => {
  const c = chapterList([{ title: 'Two\nlines  here ' }, { title: ' \n ' }], [{ segment: 0, start: 1 }, { segment: 1, start: 5 }], 9)
  assert.deepEqual(c.map((x) => x.title), ['Two lines here', 'Part 2'])
  assert.equal(toChapterText(c), '0:00 Two lines here\n0:05 Part 2\n')
})

test('chapters cover the whole episode with no hole and no overlap', () => {
  const { timeline } = timelineOf(), c = timeline.chapters
  assert.equal(c.length, 2); assert.equal(c[0].start, 0); assert.equal(c[c.length - 1].end, timeline.total)
  for (let i = 1; i < c.length; i++) assert.equal(c[i].start, c[i - 1].end)
  assert.equal(c[1].start, timeline.turns.find((t) => t.segment === 1).start)
})

test('ffmetadata is in milliseconds, escapes special characters and reads back the same', () => {
  const list = [{ title: 'A = B; #1', start: 0, end: 20.295 }, { title: 'Recap', start: 20.295, end: 69.493 }]
  const text = toFfmetadata(list, { title: 'What a compiler does', track: 1, empty: '', none: undefined })
  assert.ok(text.startsWith(';FFMETADATA1\ntitle=What a compiler does\ntrack=1\n'))
  assert.ok(text.includes('TIMEBASE=1/1000\nSTART=0\nEND=20295\ntitle=A \\= B\\; \\#1'))
  assert.ok(!text.includes('empty') && !text.includes('none'))
  assert.deepEqual(parseFfmetadata(text), list)
})

test('a chapter in the file is never zero length', () => {
  assert.ok(toFfmetadata([{ title: 'x', start: 5, end: 5 }]).includes('START=5000\nEND=5001'))
})

test('text list and JSON chapters', () => {
  const list = [{ title: 'The question', start: 0, end: 20.3 }, { title: 'Recap', start: 59.652, end: 69 }]
  assert.equal(toChapterText(list), '0:00 The question\n0:59 Recap\n')
  assert.deepEqual(JSON.parse(toChapterJson(list)), { version: '1.2.0', chapters: [{ startTime: 0, title: 'The question' }, { startTime: 59.652, title: 'Recap' }] })
})
