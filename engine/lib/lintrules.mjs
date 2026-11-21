// Lint rules for an episode script. Pure: file checks go through an `exists(path)` function the caller supplies.
// Every rule returns issues shaped { level: 'error' | 'warn' | 'info', where, rule, message }.
import { flattenTurns, countWords, wordsOf, splitSentences, withDefaults, spoken, insideProject } from './episode.mjs'
import { layout, estimateMetas } from './timing.mjs'
import { clock } from './chapters.mjs'

export const LIMITS = { turnWords: 60, sentenceWords: 32, minShare: 0.15, chapterTitle: 60, title: 70, speedMin: 0.8, speedMax: 1.25, lengthTolerance: 0.15 }
export const EPISODE_FIELDS = ['show', 'title', 'episode', 'summary', 'lang', 'source', 'cover', 'speakers', 'pronounce', 'spoken_ok', 'check_words', 'audio', 'music', 'video',
  'claims', 'segments', 'target_seconds', 'disclosure', 'disclosure_text', 'author', 'date']
export const FORMATS = ['vertical', 'square', 'landscape']
export const STYLES = ['bars', 'wave']
export const AUDIO_FORMATS = ['mp3', 'm4a']
const issue = (level, where, rule, message) => ({ level, where, rule, message })
const bare = (w) => w.replace(/^[^\p{L}\p{N}$€£#@]+|[^\p{L}\p{N}%]+$/gu, '').replace(/['’]s$/, '')
const isHex = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c))
const COMMON_CAPS = new Set(['I', 'A', 'OK', 'AM', 'PM', 'TV', 'US', 'UK'])

/** why a word might be read wrongly by the voice, or null. Checked on the word without its punctuation. */
export function flagReason(word) {
  const w = bare(word)
  if (!w) return null
  if (/@/.test(w)) return 'contains @'
  if (/^(https?:\/\/|www\.)/i.test(w) || (/\.[a-z]{2,}(\/|$)/i.test(w) && /[a-z]\.[a-z]/i.test(w))) return 'a web address'
  if (/[\/_&+=#$€£%]/.test(w)) return 'contains a symbol'
  if (/\p{L}/u.test(w) && /\p{N}/u.test(w)) return 'mixes letters and digits'
  if (/^\p{Lu}{2,}s?$/u.test(w) && !COMMON_CAPS.has(w)) return 'an abbreviation in capitals'
  if (/\p{Ll}\p{Lu}/u.test(w)) return 'has a capital inside the word'
  return null
}

function structure(ep) {
  const out = []
  for (const k of Object.keys(ep)) if (!EPISODE_FIELDS.includes(k)) out.push(issue('warn', 'episode', 'unknown-field', `unknown field "${k}" (known: ${EPISODE_FIELDS.join(', ')})`))
  for (const k of ['show', 'title']) if (typeof ep[k] !== 'string' || !ep[k].trim()) out.push(issue('error', 'episode', 'missing', `"${k}" is missing`))
  if (typeof ep.title === 'string' && ep.title.length > LIMITS.title) out.push(issue('warn', 'episode', 'title-long', `the title has ${ep.title.length} characters; over ${LIMITS.title} it is set very small on the cover`))
  if (!ep.speakers || typeof ep.speakers !== 'object' || !Object.keys(ep.speakers).length) out.push(issue('error', 'episode', 'missing', '"speakers" is missing or empty'))
  if (!Array.isArray(ep.segments) || !ep.segments.length) out.push(issue('error', 'episode', 'missing', '"segments" is missing or empty'))
  if (ep.disclosure === false) out.push(issue('warn', 'episode', 'disclosure', 'the show notes will not say that the voices are computer-generated. Listeners should be told.'))
  return out
}

function speakers(ep, voices) {
  const out = [], list = Object.entries(ep.speakers || {}), seen = new Map()
  for (const [id, s] of list) {
    const where = `speaker ${id}`
    if (!s || typeof s !== 'object') { out.push(issue('error', where, 'speaker', 'must be an object with "name" and "voice"')); continue }
    if (!s.name) out.push(issue('warn', where, 'speaker-name', 'has no "name"; the id is shown instead'))
    if (!s.voice) out.push(issue('error', where, 'voice', 'has no "voice"'))
    else if (voices && !voices.includes(s.voice)) out.push(issue('error', where, 'voice', `unknown voice "${s.voice}". See engine/voices.json for the list.`))
    else if (seen.has(s.voice)) out.push(issue('warn', where, 'voice-shared', `uses the same voice as ${seen.get(s.voice)}; listeners will not tell them apart`))
    if (s.voice) seen.set(s.voice, id)
    if (s.speed !== undefined) {
      if (typeof s.speed !== 'number' || !Number.isFinite(s.speed) || s.speed < 0.5 || s.speed > 2) out.push(issue('error', where, 'speed', `speed must be a number from 0.5 to 2 (found ${JSON.stringify(s.speed)})`))
      else if (s.speed < LIMITS.speedMin || s.speed > LIMITS.speedMax) out.push(issue('warn', where, 'speed', `speed ${s.speed} is outside ${LIMITS.speedMin} to ${LIMITS.speedMax}, where the voice sounds most natural`))
    }
    if (s.color !== undefined && !isHex(s.color)) out.push(issue('warn', where, 'colour', `"color" should be a hex colour like #fca311`))
  }
  return out
}

function turns(ep) {
  const out = []
  ;(Array.isArray(ep.segments) ? ep.segments : []).forEach((seg, si) => {
    const where = `segment ${si + 1}`
    if (!seg || typeof seg.title !== 'string' || !seg.title.trim()) out.push(issue('warn', where, 'chapter-title', 'has no "title"; the chapter will be called "Part ' + (si + 1) + '"'))
    else if (seg.title.length > LIMITS.chapterTitle) out.push(issue('warn', where, 'chapter-title', `chapter title has ${seg.title.length} characters (guide: ${LIMITS.chapterTitle})`))
    if (!seg || !Array.isArray(seg.turns) || !seg.turns.length) out.push(issue('error', where, 'missing', 'has no "turns"'))
    else seg.turns.forEach((turn, ti) => {
      if (!turn || turn.speed === undefined) return
      const at = `${where} turn ${ti + 1}`
      if (typeof turn.speed !== 'number' || !Number.isFinite(turn.speed) || turn.speed < 0.5 || turn.speed > 2) out.push(issue('error', at, 'speed', `speed must be a number from 0.5 to 2 (found ${JSON.stringify(turn.speed)})`))
      else if (turn.speed < LIMITS.speedMin || turn.speed > LIMITS.speedMax) out.push(issue('warn', at, 'speed', `speed ${turn.speed} is outside ${LIMITS.speedMin} to ${LIMITS.speedMax}, where the voice sounds most natural`))
    })
  })
  const titles = (ep.segments || []).map((s) => s && s.title).filter(Boolean)
  if (new Set(titles).size < titles.length) out.push(issue('warn', 'episode', 'chapter-title', 'two chapters have the same title'))
  const flat = flattenTurns(ep)
  flat.forEach((t, i) => {
    const where = `turn ${t.id}`
    if (!t.speaker || !(ep.speakers || {})[t.speaker]) { out.push(issue('error', where, 'speaker', `unknown speaker "${t.speaker}" (speakers: ${Object.keys(ep.speakers || {}).join(', ') || 'none'})`)) }
    if (!t.say) { out.push(issue('error', where, 'empty', '"say" is empty')); return }
    const n = countWords(t.say)
    if (n > LIMITS.turnWords) out.push(issue('warn', where, 'turn-long', `${n} words in one turn (guide: ${LIMITS.turnWords}). Split it, or let the other speaker react.`))
    for (const s of splitSentences(t.say)) if (countWords(s) > LIMITS.sentenceWords) out.push(issue('warn', where, 'sentence-long', `a sentence of ${countWords(s)} words (guide: ${LIMITS.sentenceWords}): "${s.slice(0, 48)}…"`))
    if (/\[[^\]]+\]|\([^)]+\)|\*[^*]+\*|<[^>]+>/.test(t.say)) out.push(issue('warn', where, 'stage-direction', 'has text in brackets or asterisks. The voice cannot laugh, sigh or follow directions; it reads or skips them.'))
    const prev = flat[i - 1]
    if (prev && prev.speaker === t.speaker && prev.segment === t.segment) out.push(issue('warn', where, 'same-speaker', `${t.speaker} speaks twice in a row. Join the two turns or put a reaction between them.`))
    if (t.gap !== undefined && (!Number.isFinite(t.gap) || t.gap < 0)) out.push(issue('error', where, 'gap', '"gap" must be zero or more seconds; speakers cannot overlap'))
  })
  return out
}

/** each speaker's share of the spoken words: { id: 0..1 } */
export function speakerShare(ep) {
  const count = {}
  for (const id of Object.keys(ep.speakers || {})) count[id] = 0
  for (const t of flattenTurns(ep)) if (t.speaker in count) count[t.speaker] += countWords(t.say)
  const total = Object.values(count).reduce((a, b) => a + b, 0) || 1
  return Object.fromEntries(Object.entries(count).map(([k, v]) => [k, v / total]))
}

function balance(ep) {
  const share = speakerShare(ep), ids = Object.keys(share)
  if (ids.length < 2) return []
  const text = ids.map((id) => `${id} ${Math.round(share[id] * 100)}%`).join(', ')
  const out = [issue('info', 'episode', 'share', `share of the words: ${text}`)]
  for (const id of ids) {
    if (share[id] === 0) out.push(issue('warn', `speaker ${id}`, 'share', 'never speaks'))
    else if (share[id] < LIMITS.minShare) out.push(issue('warn', `speaker ${id}`, 'share', `says only ${Math.round(share[id] * 100)}% of the words (${text}). It will sound like a monologue with interruptions.`))
  }
  return out
}

/** every word that might be misread: [{ word, turn, reason, spoken }] where `spoken` is the word after "pronounce" */
export function flaggedWords(ep) {
  const check = new Set((ep.check_words || []).map((w) => String(w).toLowerCase())), seen = new Set(), out = []
  let rules = {}
  try { for (const k of Object.keys(ep.pronounce || {})) new RegExp(k); rules = ep.pronounce || {} } catch { rules = {} }
  for (const t of flattenTurns(ep)) for (const word of wordsOf(t.say)) {
    const w = bare(word), reason = check.has(w.toLowerCase()) ? 'listed in check_words' : flagReason(word)
    if (!reason || seen.has(w)) continue
    seen.add(w); out.push({ word: w, turn: t.id, reason, spoken: spoken(w, rules) })
  }
  return out
}

function pronunciations(ep) {
  const out = [], rules = []
  for (const [pattern, say] of Object.entries(ep.pronounce || {})) {
    try { rules.push({ pattern, re: new RegExp(pattern, 'g'), say }) } catch (e) { out.push(issue('error', 'pronounce', 'pattern', `"${pattern}" is not a valid pattern: ${e.message}`)) }
  }
  if (out.length) return out
  const ok = new Set((ep.spoken_ok || []).map((w) => String(w).toLowerCase())), check = new Set((ep.check_words || []).map((w) => String(w).toLowerCase()))
  const used = new Set(), reported = new Set()
  const valid = Object.fromEntries(rules.map((r) => [r.pattern, r.say]))
  for (const t of flattenTurns(ep)) {
    for (const r of rules) { r.re.lastIndex = 0; if (r.re.test(t.say)) used.add(r.pattern) }
    for (const word of wordsOf(t.say)) {
      const w = bare(word), reason = check.has(w.toLowerCase()) ? 'listed in check_words' : flagReason(word)
      if (!reason || ok.has(w.toLowerCase()) || reported.has(w)) continue
      if (spoken(word, valid) !== word) continue
      reported.add(w)
      out.push(issue('warn', `turn ${t.id}`, 'pronunciation', `"${w}" (${reason}) has no pronunciation. Add it to "pronounce" with a spoken spelling, or to "spoken_ok" once you know it is read correctly.`))
    }
  }
  for (const r of rules) if (!used.has(r.pattern)) out.push(issue('warn', 'pronounce', 'unused', `"${r.pattern}" matches nothing in the script`))
  return out
}

/** text made comparable: straight quotes, no thousands separators, single spaces */
export const normText = (s) => String(s).replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'").replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/\s+/g, ' ')
const numbersIn = (text) => (normText(text).match(/\d[\d.]*\d|\d/g) || []).map((n) => n.replace(/\.$/, ''))
const quotesIn = (text) => [...normText(text).matchAll(/"([^"]{12,})"/g)].map((m) => m[1].trim())
/** number words a voice reads out. "one" is left out: it is too often not a number ("the one that"). */
export const NUMBER_WORDS = new Set(('zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen ' +
  'twenty thirty forty fifty sixty seventy eighty ninety hundred hundreds thousand thousands million millions billion billions trillion ' +
  'half halves quarter quarters third thirds twice double triple dozen dozens percent').split(' '))
/** runs of spelled-out numbers in a text: "nineteen seventy", "twenty-five", "half" */
export function spelledNumbers(text) {
  const out = []; let cur = []
  const words = normText(text).toLowerCase().split(/[\s\-–]+/).map((w) => w.replace(/[^a-z]/g, ''))
  words.forEach((w, i) => {
    const joiner = w === 'and' && cur.length && NUMBER_WORDS.has(words[i + 1] || '')
    if (NUMBER_WORDS.has(w) || joiner) cur.push(w)
    else if (cur.length) { out.push(cur.join(' ')); cur = [] }
  })
  if (cur.length) out.push(cur.join(' '))
  return out
}

const DISCLOSE = /computer[\s-]generated|synthetic|text[\s-]to[\s-]speech|ai[\s-]generated|artificial voice/i
export const OPENING_TURNS = 4
function disclosure(ep, flat) {
  if (ep.disclosure === false) return []
  const opening = flat.filter((t) => t.segment === 0).slice(0, OPENING_TURNS)
  if (opening.some((t) => DISCLOSE.test(t.say))) return []
  return [issue('warn', 'episode', 'disclosure', `none of the first ${opening.length} turns says the voices are computer-generated. Let a speaker say it in the opening, e.g. "I'm Theo, a computer-generated voice."`)]
}

function claims(ep) {
  const out = [], flat = flattenTurns(ep)
  if (!Array.isArray(ep.claims)) return [issue('warn', 'episode', 'claims', 'there is no "claims" list. List every factual claim the speakers make so the user can confirm each one (an empty list means the episode states no facts).')]
  if (!ep.claims.length && flat.length > 4) out.push(issue('warn', 'episode', 'claims', `"claims" is empty but the script has ${flat.length} turns. An episode that states no facts at all is rare: list every factual claim, with where in the source it comes from.`))
  const texts = ep.claims.map((c) => (typeof c === 'string' ? c : String((c && c.claim) || '')))
  ep.claims.forEach((c, i) => {
    if (!texts[i].trim()) out.push(issue('error', `claim ${i + 1}`, 'claims', 'has no "claim" text'))
    if (typeof c === 'string' || !c || typeof c.source !== 'string' || !c.source.trim()) out.push(issue('error', `claim ${i + 1}`, 'claim-source', 'has no "source": say where in the source it comes from (section, paragraph or page), so the user can check it'))
  })
  const open = ep.claims.filter((c) => typeof c === 'string' || !c || c.confirmed !== true).length
  if (open) out.push(issue('warn', 'episode', 'claims', `${open} of ${ep.claims.length} factual claim(s) not yet confirmed by the user ("confirmed": true). Do not publish until every claim is confirmed.`))
  const all = normText(texts.join('\n')), allNumbers = numbersIn(all), allLower = all.toLowerCase().replace(/[\-–]/g, ' ')
  for (const t of flat) {
    for (const n of numbersIn(t.say)) if (!allNumbers.includes(n)) out.push(issue('warn', `turn ${t.id}`, 'number', `the number ${n} is spoken but appears in no claim. Every figure must come from the source and be listed.`))
    for (const n of spelledNumbers(t.say)) if (!allLower.includes(n)) out.push(issue('warn', `turn ${t.id}`, 'number', `the number "${n}" is spoken but appears in no claim. List it as said (or reword the line if it is not a fact).`))
    for (const q of quotesIn(t.say)) if (!all.includes(q)) out.push(issue('warn', `turn ${t.id}`, 'quote', `a quotation is spoken but appears in no claim: "${q.slice(0, 40)}…". Quote the source word for word and list it.`))
  }
  return out
}

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
export const SAMPLE_RATES = [22050, 24000, 32000, 44100, 48000]
function numbers(ep) {
  const out = [], m = ep.music || {}, a = ep.audio || {}
  const need = (block, key, v, lo, hi, what) => { if (v !== undefined && v !== null && !inRange(v, lo, hi)) out.push(issue('error', block, 'number', `${block}.${key} must be ${what} (found ${JSON.stringify(v)})`)) }
  for (const k of ['intro', 'under', 'outro', 'tail']) need('music', k, m[k], 0, 60, 'a number of seconds from 0 to 60')
  need('music', 'volume', m.volume, 0, 2, 'a number from 0 to 2'); need('music', 'bpm', m.bpm, 30, 240, 'a number from 30 to 240')
  if (m.on !== undefined && typeof m.on !== 'boolean') out.push(issue('error', 'music', 'number', 'music.on must be true or false'))
  if (m.chords !== undefined && !/^[A-G][#b]?m?(-[A-G][#b]?m?)*$/.test(String(m.chords))) out.push(issue('error', 'music', 'chords', 'music.chords must look like "Dm-Bb-F-C"'))
  if (a.pace !== undefined && !(inRange(a.pace, 0, 3) && a.pace > 0)) out.push(issue('error', 'audio', 'number', `audio.pace must be a number above 0 and up to 3 (found ${JSON.stringify(a.pace)})`))
  need('audio', 'peak', a.peak, -6, -0.1, 'a number of dBFS from -6 to -0.1 (-1 is usual)')
  if (a.bitrate !== undefined && a.bitrate !== null && !/^\d{2,3}k$/.test(String(a.bitrate))) out.push(issue('error', 'audio', 'bitrate', 'audio.bitrate must look like "64k" or "128k"'))
  if (a.sampleRate !== undefined && !SAMPLE_RATES.includes(a.sampleRate)) out.push(issue('error', 'audio', 'number', `audio.sampleRate must be one of ${SAMPLE_RATES.join(', ')}`))
  return out
}

function settings(ep, exists, dir) {
  const out = [], full = withDefaults(ep)
  if (!FORMATS.includes(full.video.format)) out.push(issue('error', 'video', 'format', `format must be one of ${FORMATS.join(', ')}`))
  if (!STYLES.includes(full.video.style)) out.push(issue('error', 'video', 'style', `style must be one of ${STYLES.join(', ')}`))
  if (![1, 2].includes(full.audio.channels)) out.push(issue('error', 'audio', 'channels', 'channels must be 1 (mono) or 2 (stereo)'))
  if (!Array.isArray(full.audio.formats) || !full.audio.formats.length || full.audio.formats.some((f) => !AUDIO_FORMATS.includes(f))) out.push(issue('error', 'audio', 'formats', `formats must be a list from: ${AUDIO_FORMATS.join(', ')}`))
  if (ep.audio && ep.audio.lufs !== undefined && ep.audio.lufs !== null && !inRange(ep.audio.lufs, -30, -9)) out.push(issue('error', 'audio', 'lufs', 'lufs must be a number from -30 to -9 (podcasts: -16 stereo, -19 mono)'))
  for (const k of ['background', 'ink', 'accent']) if (!isHex(full.cover[k])) out.push(issue('warn', 'cover', 'colour', `"${k}" should be a hex colour like #14213d`))
  for (const [block, key, label] of [['cover', 'image', 'image'], ['music', 'file', 'music file']]) {
    const f = full[block][key]
    if (!f) continue
    if (dir && !insideProject(dir, f)) out.push(issue('error', block, 'path', `${block}.${key} must be a file inside the project folder: ${f}`))
    else if (exists && !exists(f)) out.push(issue('error', block, 'file', `${label} not found: ${f}`))
  }
  return [...out, ...numbers(ep)]
}

function length(ep) {
  const full = withDefaults(ep), flat = flattenTurns(full)
  if (!flat.length || flat.some((t) => !t.say || !full.speakers[t.speaker])) return []
  const tl = layout(full, flat, estimateMetas(flat)), words = flat.reduce((n, t) => n + countWords(t.say), 0)
  const out = [issue('info', 'episode', 'length', `about ${clock(tl.total)} (${Math.round(tl.total)} s) estimated from ${words} words in ${flat.length} turns; the real length is known after "podcast audio"`)]
  if (Number.isFinite(ep.target_seconds) && Math.abs(tl.total - ep.target_seconds) > ep.target_seconds * LIMITS.lengthTolerance)
    out.push(issue('warn', 'episode', 'length', `estimated ${Math.round(tl.total)} s is more than ${LIMITS.lengthTolerance * 100}% away from target_seconds ${ep.target_seconds}`))
  return out
}

/** all rules. `voices` is the list of voice names (null skips the check); `exists(path)` tests a project-relative file;
    `dir` is the project folder, used to refuse files outside it. */
export function lintEpisode(ep, { voices = null, exists = null, dir = null } = {}) {
  if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return [issue('error', 'episode', 'missing', 'episode.json must hold one object')]
  const first = structure(ep)
  if (first.some((i) => i.level === 'error')) return [...first, ...speakers(ep, voices)]
  // a broken pronounce pattern is reported once by its own rule; the other rules run without it
  const safe = { ...ep, pronounce: Object.fromEntries(Object.entries(ep.pronounce || {}).filter(([k]) => { try { new RegExp(k); return true } catch { return false } })) }
  return [...first, ...speakers(ep, voices), ...turns(safe), ...balance(safe), ...pronunciations(ep), ...claims(safe), ...disclosure(safe, flattenTurns(safe)), ...settings(ep, exists, dir), ...(numbers(ep).length ? [] : length(safe))]
}

const ORDER = { error: 0, warn: 1, info: 2 }
export function formatIssues(issues) {
  if (!issues.length) return 'lint: no issues'
  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level])
  const n = (l) => issues.filter((i) => i.level === l).length
  return sorted.map((i) => `${i.level.padEnd(5)} ${i.where.padEnd(12)} ${i.message}`).join('\n') + `\nlint: ${n('error')} error(s), ${n('warn')} warning(s)`
}
