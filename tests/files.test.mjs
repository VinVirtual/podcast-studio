// What touches the project folder: the stale-timeline guard, clean, and where Playwright is loaded from.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTimeline, cleanTakes, paths } from '../engine/lib/audio.mjs'
import { flattenTurns, withDefaults, scriptHash } from '../engine/lib/episode.mjs'
import { findPlaywright } from '../engine/lib/env.mjs'
import { EPISODE, clone } from './fixtures.mjs'

const project = () => { const P = mkdtempSync(join(tmpdir(), 'podcast-files-')); mkdirSync(join(P, 'build', 'takes'), { recursive: true }); return P }

test('loadTimeline refuses a timeline made from another version of the script, and says what to run', (t) => {
  const P = project(); t.after(() => rmSync(P, { recursive: true, force: true }))
  const ep = withDefaults(clone(EPISODE))
  writeFileSync(paths(P).timeline, JSON.stringify({ total: 1, scriptHash: scriptHash(ep, flattenTurns(ep)) }))
  assert.equal(loadTimeline(P, ep).total, 1); assert.equal(loadTimeline(P).total, 1)
  const changed = withDefaults(clone(EPISODE)); changed.segments[0].turns[0].say = 'Something else.'
  assert.throws(() => loadTimeline(P, changed), /episode\.json changed since the audio was made.*Run: podcast audio/)
  writeFileSync(paths(P).timeline, JSON.stringify({ total: 1 }))
  assert.throws(() => loadTimeline(P, ep), /changed since the audio was made/)
  rmSync(paths(P).timeline); assert.throws(() => loadTimeline(P, ep), /no timeline yet/)
})

test('clean removes only recordings that no line uses', (t) => {
  const P = project(); t.after(() => rmSync(P, { recursive: true, force: true }))
  const ep = withDefaults(clone(EPISODE)), keys = flattenTurns(ep).flatMap((x) => x.takes.map((k) => k.key)), dir = paths(P).takes
  for (const k of [...keys, 'stale1', 'stale2']) for (const ext of ['.wav', '.json']) writeFileSync(join(dir, k + ext), '')
  assert.equal(cleanTakes(P, ep), 2)
  assert.deepEqual(readdirSync(dir).sort(), keys.flatMap((k) => [k + '.json', k + '.wav']).sort())
  assert.equal(cleanTakes(P, ep), 0)
})

test('Playwright is never loaded from the current working folder', (t) => {
  const P = project(), mod = join(P, 'node_modules', 'playwright-core'), was = process.cwd()
  mkdirSync(mod, { recursive: true })
  writeFileSync(join(mod, 'package.json'), '{"name":"playwright-core","main":"index.js"}')
  writeFileSync(join(mod, 'index.js'), "module.exports = { chromium: 'planted' }")
  t.after(() => { process.chdir(was); rmSync(P, { recursive: true, force: true }) })
  process.chdir(P)
  let found = null
  try { found = findPlaywright() } catch (e) { assert.match(e.message, /Playwright not found/) }
  if (found) { assert.notEqual(found.chromium, 'planted'); assert.ok(!found.from.startsWith(P)) }
  assert.ok(existsSync(join(mod, 'index.js')))
})
