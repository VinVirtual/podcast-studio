import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintEpisode, flagReason, flaggedWords, speakerShare, formatIssues, spelledNumbers, normText, LIMITS } from '../engine/lib/lintrules.mjs'
import { EPISODE, clone } from './fixtures.mjs'

const VOICES = ['af_heart', 'am_michael', 'bf_emma']
const lint = (ep, opts = {}) => lintEpisode(ep, { voices: VOICES, ...opts })
const rules = (ep, level, opts) => lint(ep, opts).filter((i) => !level || i.level === level).map((i) => i.rule)
const edit = (fn) => { const ep = clone(EPISODE); fn(ep); return ep }

test('a clean episode has no errors and no warnings', () => {
  assert.deepEqual(lint(EPISODE).filter((i) => i.level !== 'info'), [])
})

test('missing basics are errors and stop the other rules', () => {
  assert.deepEqual(rules({}, 'error'), ['missing', 'missing', 'missing', 'missing'])
  assert.equal(lint([])[0].level, 'error'); assert.equal(lint(null)[0].level, 'error')
})

test('an unknown speaker in a turn is an error that names the known speakers', () => {
  const i = lint(edit((e) => { e.segments[0].turns[0].speaker = 'carl' })).find((x) => x.rule === 'speaker')
  assert.equal(i.level, 'error'); assert.equal(i.where, 'turn t01'); assert.match(i.message, /unknown speaker "carl" \(speakers: ana, ben\)/)
})

test('an unknown or missing voice is an error; the same voice twice is a warning', () => {
  assert.ok(rules(edit((e) => { e.speakers.ana.voice = 'af_nobody' }), 'error').includes('voice'))
  assert.ok(rules(edit((e) => { delete e.speakers.ana.voice }), 'error').includes('voice'))
  assert.ok(rules(edit((e) => { e.speakers.ben.voice = 'af_heart' }), 'warn').includes('voice-shared'))
  assert.ok(!rules(edit((e) => { e.speakers.ana.voice = 'anything' }), 'error', { voices: null }).includes('voice'))
})

test('speed: nonsense is an error, unnatural is a warning', () => {
  assert.ok(rules(edit((e) => { e.speakers.ana.speed = 'fast' }), 'error').includes('speed'))
  assert.ok(rules(edit((e) => { e.speakers.ana.speed = 3 }), 'error').includes('speed'))
  assert.ok(rules(edit((e) => { e.speakers.ana.speed = 1.4 }), 'warn').includes('speed'))
  assert.ok(!rules(edit((e) => { e.speakers.ana.speed = 1.1 })).includes('speed'))
})

test('a turn or a sentence that is too long to sound natural is a warning', () => {
  const long = Array(LIMITS.turnWords + 5).fill('word').join(' ') + '.'
  const r = rules(edit((e) => { e.segments[0].turns[1].say = long }), 'warn')
  assert.ok(r.includes('turn-long')); assert.ok(r.includes('sentence-long'))
  const many = Array(8).fill('Eight short words make one small sentence here.').join(' ')
  const r2 = rules(edit((e) => { e.segments[0].turns[1].say = many }), 'warn')
  assert.ok(r2.includes('turn-long')); assert.ok(!r2.includes('sentence-long'))
})

test('an empty line is an error; stage directions and a speaker talking twice in a row are warnings', () => {
  assert.ok(rules(edit((e) => { e.segments[0].turns[0].say = '  ' }), 'error').includes('empty'))
  assert.ok(rules(edit((e) => { e.segments[0].turns[0].say = 'Well [laughs] yes.' }), 'warn').includes('stage-direction'))
  assert.ok(rules(edit((e) => { e.segments[0].turns[0].say = 'Well *sighs* yes.' }), 'warn').includes('stage-direction'))
  assert.ok(rules(edit((e) => { e.segments[0].turns[1].speaker = 'ben' }), 'warn').includes('same-speaker'))
  assert.ok(rules(edit((e) => { e.segments[0].turns[0].gap = -1 }), 'error').includes('gap'))
})

test('speaker share is counted in words and an unbalanced episode is a warning', () => {
  const share = speakerShare(EPISODE)
  assert.ok(Math.abs(share.ana + share.ben - 1) < 1e-9); assert.ok(share.ana > share.ben)
  const mono = edit((e) => { e.segments = [{ title: 'Only', turns: [{ speaker: 'ana', say: Array(50).fill('word').join(' ') + '.' }, { speaker: 'ben', say: 'Yes.' }] }] })
  const w = lint(mono).find((i) => i.rule === 'share' && i.level === 'warn')
  assert.equal(w.where, 'speaker ben'); assert.match(w.message, /only 2%/)
  assert.ok(lint(edit((e) => { e.speakers.cat = { name: 'Cat', voice: 'bf_emma' } })).some((i) => i.rule === 'share' && /never speaks/.test(i.message)))
})

test('words the voice may misread are flagged with a reason', () => {
  for (const [w, part] of [['CPU', 'capitals'], ['APIs.', 'capitals'], ['H2O', 'letters and digits'], ['km/h', 'symbol'], ['50%', 'symbol'], ['someone@example.org', '@'], ['www.example.org', 'web address'], ['example.org/docs', 'web address'], ['JavaScript', 'capital inside']])
    assert.match(flagReason(w) || '', new RegExp(part), w)
  for (const w of ['Hello', 'I', 'OK', "it's", 'well-known', '2020', '3.5', 'So:', '—']) assert.equal(flagReason(w), null, w)
})

test('a flagged word needs a pronunciation or an entry in spoken_ok', () => {
  const with_ = (extra) => edit((e) => { e.segments[0].turns[1].say = 'The CPU runs it.'; Object.assign(e, extra) })
  const w = lint(with_({})).filter((i) => i.rule === 'pronunciation')
  assert.equal(w.length, 1); assert.equal(w[0].where, 'turn t02'); assert.match(w[0].message, /"CPU"/)
  assert.equal(lint(with_({ pronounce: { '\\bCPU\\b': 'C P U' } })).filter((i) => i.rule === 'pronunciation').length, 0)
  assert.equal(lint(with_({ spoken_ok: ['cpu'] })).filter((i) => i.rule === 'pronunciation').length, 0)
  assert.deepEqual(flaggedWords(with_({ pronounce: { '\\bCPU\\b': 'C P U' } })), [{ word: 'CPU', turn: 't02', reason: 'an abbreviation in capitals', spoken: 'C P U' }])
})

test('check_words flags ordinary words; a flagged word is reported once', () => {
  const ep = edit((e) => { e.check_words = ['tide']; e.segments[1].turns[0].say = 'The tide. The tide again.' })
  assert.equal(lint(ep).filter((i) => i.rule === 'pronunciation').length, 1)
})

test('a broken pronounce pattern is an error and an unused one is a warning', () => {
  assert.ok(rules(edit((e) => { e.pronounce = { '(': 'x' } }), 'error').includes('pattern'))
  assert.ok(rules(edit((e) => { e.pronounce = { zebra: 'zeebra' } }), 'warn').includes('unused'))
})

test('claims: a missing list, unconfirmed claims, and numbers or quotes not listed are warnings', () => {
  assert.ok(rules(edit((e) => { delete e.claims }), 'warn').includes('claims'))
  const open = lint(edit((e) => { e.claims = [{ claim: 'Tides rise twice a day.', source: 'p1', confirmed: true }, { claim: 'The moon pulls on water.', source: 'p2' }, { claim: 'The sun pulls less.', source: 'p2', confirmed: 'yes' }] })).find((i) => i.rule === 'claims')
  assert.match(open.message, /2 of 3 factual claim/)
  const num = edit((e) => { e.segments[0].turns[1].say = "I'm Ana, a computer-generated voice. It rises 12 metres, 2 times a day."; e.claims = [{ claim: 'It happens 2 times a day.', source: 'p1', confirmed: true }] })
  assert.deepEqual(lint(num).filter((i) => i.rule === 'number').map((i) => i.message.match(/number (\S+)/)[1]), ['12'])
  const quote = (claims) => edit((e) => { e.segments[0].turns[1].say = "I'm Ana, a computer-generated voice. The report says \"the tide waits for nobody at all\"."; e.claims = claims })
  assert.ok(rules(quote([]), 'warn').includes('quote'))
  assert.ok(!rules(quote([{ claim: 'The report says: the tide waits for nobody at all', source: 'p3', confirmed: true }])).includes('quote'))
  assert.ok(rules(edit((e) => { e.claims = [{ source: 'x' }] }), 'error').includes('claims'))
})

test('every claim needs a source; a bare string is not enough', () => {
  const r = lint(edit((e) => { e.claims = ['Tides rise twice a day.', { claim: 'The moon pulls.', source: '  ' }, { claim: 'The sun pulls less.', source: 'p2' }] }))
  assert.deepEqual(r.filter((i) => i.rule === 'claim-source').map((i) => i.where), ['claim 1', 'claim 2'])
  assert.ok(r.every((i) => i.rule !== 'claim-source' || i.level === 'error'))
})

test('an empty claims list is a warning once the script has more than a few turns', () => {
  const msg = (ep) => lint(ep).filter((i) => i.rule === 'claims').map((i) => i.message).join(' ')
  assert.match(msg(edit((e) => { e.claims = [] })), /"claims" is empty but the script has 6 turns/)
  assert.equal(msg(edit((e) => { e.claims = []; e.segments[1].turns = e.segments[1].turns.slice(0, 2) })), '')
})

test('numbers match across thousands separators, and curly quotes match straight ones', () => {
  const say = (text, claim) => edit((e) => { e.segments[1].turns[1].say = text; e.claims = [...e.claims, { claim, source: 'p', confirmed: true }] })
  assert.ok(!rules(say('It moves 1,200 tonnes.', 'It moves 1200 tonnes.')).includes('number'))
  assert.ok(!rules(say('It moves 1200 tonnes.', 'It moves 1,200 tonnes.')).includes('number'))
  assert.ok(rules(say('It moves 1,300 tonnes.', 'It moves 1,200 tonnes.')).includes('number'))
  assert.ok(!rules(say('She wrote “the tide waits for nobody at all”.', 'She wrote "the tide waits for nobody at all".')).includes('quote'))
  assert.ok(!rules(say('She wrote "the tide waits for nobody at all".', 'She wrote “the tide waits for nobody at all”.')).includes('quote'))
})

test('spelled-out numbers must be in a claim too', () => {
  assert.deepEqual(spelledNumbers('Back in nineteen seventy, about half of it, twenty-five days, one hundred and ten. The one that left.'), ['nineteen seventy', 'half', 'twenty five', 'hundred and ten'])
  const say = (text) => lint(edit((e) => { e.segments[1].turns[1].say = text })).filter((i) => i.rule === 'number').map((i) => i.message)
  assert.match(say('It started in nineteen seventy.').join(), /"nineteen seventy" is spoken but appears in no claim/)
  assert.deepEqual(say('It happens twice a day.'), [])
  assert.deepEqual(say('This is the one I meant.'), [])
})

test('the opening must say the voices are computer-generated', () => {
  const r = (fn) => lint(edit(fn)).filter((i) => i.rule === 'disclosure')
  assert.equal(r(() => {}).length, 0)
  const missing = r((e) => { e.segments[0].turns[1].say = 'A tide is the sea rising and falling.' })
  assert.equal(missing.length, 1); assert.match(missing[0].message, /computer-generated/)
  assert.equal(r((e) => { e.segments[0].turns[1].say = 'Two synthetic voices explain tides.' }).length, 0)
  assert.equal(r((e) => { e.segments[0].turns[1].say = 'A tide.'; e.segments[1].turns[0].say = "I'm a computer-generated voice." }).length, 1)
  // switching the disclosure off is its own warning, so the opening check stays quiet
  assert.deepEqual(r((e) => { e.segments[0].turns[1].say = 'A tide.'; e.disclosure = false }).map((i) => /none of the first/.test(i.message)), [false])
})

test('settings: formats, styles, channels, loudness and files are checked', () => {
  assert.ok(rules(edit((e) => { e.video = { format: 'round' } }), 'error').includes('format'))
  assert.ok(rules(edit((e) => { e.video = { style: 'lines' } }), 'error').includes('style'))
  assert.ok(rules(edit((e) => { e.audio = { channels: 6 } }), 'error').includes('channels'))
  assert.ok(rules(edit((e) => { e.audio = { formats: ['ogg'] } }), 'error').includes('formats'))
  assert.ok(rules(edit((e) => { e.audio = { lufs: -3 } }), 'error').includes('lufs'))
  assert.ok(rules(edit((e) => { e.cover = { accent: 'orange' } }), 'warn').includes('colour'))
  const withFile = edit((e) => { e.cover = { image: 'cover.png' }; e.music = { file: 'bed.wav' } })
  assert.deepEqual(rules(withFile, 'error', { exists: () => false }), ['file', 'file']); assert.deepEqual(rules(withFile, 'error', { exists: () => true }), [])
  assert.deepEqual(rules(withFile, 'error', { exists: () => true, dir: '/proj' }), [])
})

test('files outside the project folder are refused, absolute or relative', () => {
  for (const f of ['/etc/passwd', '../bed.wav', 'music/../../bed.wav']) {
    const ep = edit((e) => { e.music = { file: f }; e.cover = { image: f } })
    assert.deepEqual(rules(ep, 'error', { exists: () => true, dir: '/proj' }), ['path', 'path'], f)
  }
  assert.deepEqual(rules(edit((e) => { e.music = { file: '/proj/music/bed.wav' } }), 'error', { exists: () => true, dir: '/proj' }), [])
})

test('numbers in settings must be numbers in range', () => {
  const bad = (fn) => lint(edit(fn)).filter((i) => i.level === 'error').map((i) => i.where + ':' + i.rule)
  assert.deepEqual(bad((e) => { e.music = { intro: '3' } }), ['music:number']); assert.deepEqual(bad((e) => { e.music = { tail: -1 } }), ['music:number'])
  assert.deepEqual(bad((e) => { e.music = { volume: 5, bpm: 'slow' } }), ['music:number', 'music:number'])
  assert.deepEqual(bad((e) => { e.music = { on: 'yes', chords: 'Dm Bb' } }), ['music:number', 'music:chords'])
  assert.deepEqual(bad((e) => { e.audio = { pace: 0 } }), ['audio:number']); assert.deepEqual(bad((e) => { e.audio = { pace: -1 } }), ['audio:number'])
  assert.deepEqual(bad((e) => { e.audio = { peak: 0 } }), ['audio:number']); assert.deepEqual(bad((e) => { e.audio = { peak: -8 } }), ['audio:number'])
  assert.deepEqual(bad((e) => { e.audio = { bitrate: '128' } }), ['audio:bitrate']); assert.deepEqual(bad((e) => { e.audio = { sampleRate: 1000 } }), ['audio:number'])
  assert.deepEqual(bad((e) => { e.audio = { pace: 1.2, peak: -1.5, bitrate: '96k', sampleRate: 48000 }; e.music = { intro: 2, on: false, chords: 'C-G-Am-F' } }), [])
})

test('a turn speed must be a number in range', () => {
  const r = (v, level) => rules(edit((e) => { e.segments[0].turns[0].speed = v }), level)
  assert.ok(r('fast', 'error').includes('speed')); assert.ok(r(3, 'error').includes('speed')); assert.ok(r(1.4, 'warn').includes('speed')); assert.ok(!r(1.05).includes('speed'))
})

test('the estimated length is reported and compared with target_seconds', () => {
  const info = lint(EPISODE).find((i) => i.rule === 'length')
  assert.equal(info.level, 'info'); assert.match(info.message, /about 0:\d\d \(\d+ s\) estimated from \d+ words in 6 turns/)
  assert.ok(rules(edit((e) => { e.target_seconds = 600 }), 'warn').includes('length'))
  const s = Number(info.message.match(/\((\d+) s\)/)[1])
  assert.ok(!rules(edit((e) => { e.target_seconds = s }), 'warn').includes('length'))
})

test('chapter titles, unknown fields and a switched off disclosure are warnings', () => {
  assert.ok(rules(edit((e) => { delete e.segments[0].title }), 'warn').includes('chapter-title'))
  assert.ok(rules(edit((e) => { e.segments[1].title = 'Opening' }), 'warn').includes('chapter-title'))
  assert.ok(rules(edit((e) => { e.segments[1].title = 'x'.repeat(80) }), 'warn').includes('chapter-title'))
  assert.ok(rules(edit((e) => { e.titel = 'typo' }), 'warn').includes('unknown-field'))
  assert.ok(rules(edit((e) => { e.disclosure = false }), 'warn').includes('disclosure'))
  assert.ok(rules(edit((e) => { e.segments[0].turns = [] }), 'error').includes('missing'))
})

test('issues are printed errors first with a count', () => {
  const text = formatIssues([{ level: 'warn', where: 'a', rule: 'r', message: 'second' }, { level: 'error', where: 'b', rule: 'r', message: 'first' }])
  assert.ok(text.indexOf('first') < text.indexOf('second')); assert.ok(text.endsWith('lint: 1 error(s), 1 warning(s)')); assert.equal(formatIssues([]), 'lint: no issues')
})
