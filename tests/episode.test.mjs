import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, spoken, takeKey, flattenTurns, withDefaults, targetLufs, bitrateOf, langOf, parseArgs, numFlag, countWords, scriptHash, projectFile, insideProject } from '../engine/lib/episode.mjs'
import { EPISODE, clone } from './fixtures.mjs'

test('sentences split at . ? ! before a capital, not inside numbers or after abbreviations', () => {
  assert.deepEqual(splitSentences('It costs 3.5 units. Is that a lot? Not really!'), ['It costs 3.5 units.', 'Is that a lot?', 'Not really!'])
  assert.deepEqual(splitSentences('Ask Dr. Lee about it. She knows.'), ['Ask Dr. Lee about it.', 'She knows.'])
  assert.deepEqual(splitSentences('One sentence only'), ['One sentence only'])
  assert.deepEqual(splitSentences(''), [])
})

test('a one or two word sentence is spoken together with the next one', () => {
  assert.deepEqual(splitSentences('Exactly. Then it builds a tree.'), ['Exactly. Then it builds a tree.'])
  assert.deepEqual(splitSentences('It builds a tree. Right.'), ['It builds a tree.', 'Right.'])
})

test('pronounce patterns change what is spoken, not what is shown', () => {
  assert.equal(spoken('The CPU and the GPU.', { '\\bCPU\\b': 'C P U' }), 'The C P U and the GPU.')
  assert.equal(spoken('unchanged', {}), 'unchanged')
})

test('a take key changes with text, voice, speed or language and with nothing else', () => {
  const base = { text: 'Hello.', voice: 'af_heart', speed: 1, lang: 'en-us' }
  assert.equal(takeKey(base), takeKey({ ...base }))
  for (const change of [{ text: 'Hello!' }, { voice: 'af_bella' }, { speed: 1.1 }, { lang: 'en-gb' }]) assert.notEqual(takeKey(base), takeKey({ ...base, ...change }))
})

test('turns are flattened in order with ids, segment numbers and one take per sentence', () => {
  const turns = flattenTurns(withDefaults(EPISODE))
  assert.deepEqual(turns.map((t) => t.id), ['t01', 't02', 't03', 't04', 't05', 't06'])
  assert.deepEqual(turns.map((t) => t.segment), [0, 0, 1, 1, 1, 1])
  assert.equal(turns[3].takes.length, 2)
  assert.equal(turns[0].takes[0].speed, 1.1); assert.equal(turns[1].takes[0].speed, 1)
  assert.equal(turns[0].takes[0].voice, 'am_michael')
})

test('a turn can set its own speed, and the pronunciation is part of the take', () => {
  const ep = clone(EPISODE); ep.segments[0].turns[0].speed = 0.9; ep.pronounce = { tide: 'tyde' }
  const t = flattenTurns(withDefaults(ep))[0]
  assert.equal(t.takes[0].speed, 0.9); assert.equal(t.takes[0].text, 'Welcome back. What is a tyde?'); assert.equal(t.sentences[0], 'Welcome back. What is a tide?')
})

test('language comes from the speaker, then the episode, then the voice name', () => {
  assert.equal(langOf({}, { voice: 'bf_emma' }), 'en-gb'); assert.equal(langOf({ lang: 'es' }, { voice: 'bf_emma' }), 'es'); assert.equal(langOf({ lang: 'es' }, { voice: 'x', lang: 'it' }), 'it')
})

test('loudness target and bitrate follow the channel count unless set', () => {
  assert.equal(targetLufs({ channels: 2, lufs: null }), -16); assert.equal(targetLufs({ channels: 1, lufs: null }), -19); assert.equal(targetLufs({ channels: 2, lufs: -14 }), -14)
  assert.equal(bitrateOf({ channels: 1 }), '64k'); assert.equal(bitrateOf({ channels: 2 }), '128k'); assert.equal(bitrateOf({ channels: 2, bitrate: '96k' }), '96k')
})

test('the script hash changes with what shapes the audio, not with cover, video, claims or summary', () => {
  const hash = (fn) => { const ep = withDefaults(clone(EPISODE)); fn(ep); return scriptHash(ep, flattenTurns(ep)) }
  const base = hash(() => {})
  assert.equal(base, hash(() => {})); assert.match(base, /^[0-9a-f]{16}$/)
  for (const fn of [(e) => { e.cover.accent = '#000000' }, (e) => { e.video.format = 'square' }, (e) => { e.claims = [] }, (e) => { e.summary = 'x'; e.title = 'y' }]) assert.equal(hash(fn), base)
  for (const fn of [(e) => { e.segments[0].turns[0].say = 'Hi.' }, (e) => { e.segments[1].title = 'How' }, (e) => { e.speakers.ana.voice = 'af_bella' },
    (e) => { e.pronounce = { tide: 'tyde' } }, (e) => { e.audio.lufs = -14 }, (e) => { e.music.on = false }]) assert.notEqual(hash(fn), base)
})

test('files named in the script must stay inside the project folder', () => {
  assert.equal(projectFile('/proj', 'music/bed.wav'), '/proj/music/bed.wav'); assert.equal(projectFile('/proj/', '/proj/a.png'), '/proj/a.png')
  for (const f of ['../a.wav', '/etc/passwd', 'a/../../b', '.', '/proj']) assert.throws(() => projectFile('/proj', f, 'music.file'), /music.file must be a file inside the project folder/, f)
  assert.equal(insideProject('/proj', 'x.png'), true); assert.equal(insideProject('/proj', '../x.png'), false)
})

test('command line flags', () => {
  assert.deepEqual(parseArgs(['proj', '--size', '720', '--no-captions', '--gif', '--crf=28']), { flags: { size: '720', captions: false, gif: true, crf: '28' }, rest: ['proj'] })
  assert.throws(() => parseArgs(['--size']), /needs a value/)
  assert.equal(numFlag({ size: '720' }, 'size', 1080, 240, 2160), 720); assert.equal(numFlag({}, 'size', 1080, 240, 2160), 1080)
  assert.throws(() => numFlag({ size: 'big' }, 'size', 1080, 240, 2160), /must be a number/)
  assert.equal(countWords('So: split the text — fine.'), 5)
})
