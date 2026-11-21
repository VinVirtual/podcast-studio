import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTakes, planSummary } from '../engine/lib/plan.mjs'
import { flattenTurns, withDefaults } from '../engine/lib/episode.mjs'
import { EPISODE, clone } from './fixtures.mjs'

const turnsOf = (ep) => flattenTurns(withDefaults(ep))
const keysOf = (ep) => new Set(turnsOf(ep).flatMap((t) => t.takes.map((k) => k.key)))

test('with an empty cache every sentence is recorded once', () => {
  const p = planTakes(turnsOf(EPISODE), new Set())
  assert.equal(p.total, 7); assert.equal(p.record.length, 7); assert.equal(p.reused, 0); assert.equal(p.changed.length, 6)
})

test('with a full cache nothing is recorded', () => {
  const p = planTakes(turnsOf(EPISODE), keysOf(EPISODE))
  assert.equal(p.record.length, 0); assert.equal(p.reused, 7); assert.deepEqual(p.changed, []); assert.deepEqual(p.stale, [])
})

test('changing one sentence records only that sentence', () => {
  const ep = clone(EPISODE); ep.segments[1].turns[1].say = 'The moon pulls on the water. The sun does too, but much less.'
  const p = planTakes(turnsOf(ep), keysOf(EPISODE))
  assert.deepEqual(p.record.map((t) => t.text), ['The sun does too, but much less.']); assert.deepEqual(p.changed, ['t04']); assert.equal(p.reused, 6); assert.equal(p.stale.length, 1)
})

test('changing a voice or a speed records every line of that speaker and no other', () => {
  for (const change of [{ voice: 'am_puck' }, { speed: 1.2 }]) {
    const ep = clone(EPISODE); Object.assign(ep.speakers.ben, change)
    const p = planTakes(turnsOf(ep), keysOf(EPISODE))
    assert.deepEqual(p.changed, ['t01', 't03', 't05']); assert.equal(p.record.length, 3); assert.ok(p.record.every((t) => t.voice === ep.speakers.ben.voice))
  }
})

test('a new pronunciation records only the sentences it touches', () => {
  const ep = clone(EPISODE); ep.pronounce = { '\\bmoon\\b': 'moone' }
  assert.deepEqual(planTakes(turnsOf(ep), keysOf(EPISODE)).changed, ['t04', 't05'])
})

test('changing titles, colours, music or the order of turns records nothing', () => {
  const ep = clone(EPISODE); ep.title = 'New'; ep.music = { on: false }; ep.speakers.ana.color = '#000000'; ep.segments[1].turns.reverse(); ep.segments[0].title = 'Hi'
  assert.equal(planTakes(turnsOf(ep), keysOf(EPISODE)).record.length, 0)
})

test('the same sentence said twice by one voice is recorded once', () => {
  const ep = clone(EPISODE); ep.segments[1].turns.push({ speaker: 'ben', say: 'Right.' })
  const p = planTakes(turnsOf(ep), new Set())
  assert.equal(p.total, 8); assert.equal(p.record.length, 7)
  assert.match(planSummary(p), /8 sentence\(s\): 7 to record, 0 reused/)
})
