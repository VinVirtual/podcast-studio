// Reading an episode: the script file, its speakers and turns, and the "takes" (one recorded sentence each).
// Everything here is pure except loadEpisode and readJson.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

export const MODEL_TAG = 'kokoro-v1.0'
/** Kokoro voice name prefix -> the language code kokoro-onnx expects */
export const VOICE_LANG = { a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'cmn' }
export const DEFAULTS = {
  audio: { channels: 2, lufs: null, peak: -1, bitrate: null, formats: ['mp3', 'm4a'], pace: 1, sampleRate: 44100 },
  music: { on: true, intro: 2.6, under: 5, outro: 3, tail: 3.6, volume: 0.5, bpm: 84, chords: 'Dm-Bb-F-C', file: null },
  video: { format: 'vertical', style: 'bars', captions: true, fps: 30 },
  cover: { background: '#14213d', ink: '#f6f1e4', accent: '#fca311', image: null },
}
/** loudness targets in common use for podcasts: -16 LUFS for stereo files, -19 LUFS for mono */
export const targetLufs = (audio) => (Number.isFinite(audio.lufs) ? audio.lufs : audio.channels === 1 ? -19 : -16)
export const bitrateOf = (audio) => audio.bitrate || (audio.channels === 1 ? '64k' : '128k')

export function readJson(path, what = 'file') {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${what} is not valid JSON: ${path}\n  ${e.message}`) }
}

export function projectDir(arg) {
  if (!arg) throw new Error('which project? Give the folder that holds episode.json.')
  const P = resolve(arg)
  if (!existsSync(join(P, 'episode.json'))) throw new Error(`not a podcast-studio project (no episode.json): ${P}`)
  return P
}
export const loadEpisode = (P) => withDefaults(readJson(join(P, 'episode.json'), 'episode.json'))

/** a copy of the episode with every optional block filled in */
export function withDefaults(ep) {
  return { ...ep, audio: { ...DEFAULTS.audio, ...(ep.audio || {}) }, music: { ...DEFAULTS.music, ...(ep.music || {}) },
    video: { ...DEFAULTS.video, ...(ep.video || {}) }, cover: { ...DEFAULTS.cover, ...(ep.cover || {}) } }
}

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e|No|Fig)\.$/
/** "One. Two? Three" -> ["One.", "Two?", "Three"]. A sentence of one or two words joins the one after it,
    so a short "Right." is spoken in one breath with what follows. */
export function splitSentences(text) {
  const parts = String(text || '').trim().split(/(?<=[.?!…]["')\]]?)\s+(?=["'(\[]?[\p{Lu}\p{N}])/u).filter(Boolean)
  const joined = []
  for (const p of parts) {
    const last = joined[joined.length - 1]
    if (last !== undefined && ABBREVIATIONS.test(last)) joined[joined.length - 1] = `${last} ${p}`
    else joined.push(p)
  }
  const out = []
  for (let i = 0; i < joined.length; i++) {
    const short = joined[i].split(/\s+/).length <= 2
    if (short && i < joined.length - 1) { joined[i + 1] = `${joined[i]} ${joined[i + 1]}`; continue }
    out.push(joined[i])
  }
  return out
}

/** the text handed to the voice: every "pronounce" pattern replaced by its spoken spelling */
export function spoken(text, pronounce = {}) {
  let out = text
  for (const [pattern, say] of Object.entries(pronounce || {})) out = out.replace(new RegExp(pattern, 'g'), say)
  return out
}

export const langOf = (ep, speaker) => speaker.lang || ep.lang || VOICE_LANG[String(speaker.voice || '')[0]] || 'en-us'
export const takeKey = (t) => createHash('sha1').update(JSON.stringify([t.text, t.voice, t.speed, t.lang, MODEL_TAG])).digest('hex').slice(0, 20)

/** Every turn of the episode in order: [{ index, id, segment, speaker, say, sentences, takes }].
    A take is { key, text, voice, speed, lang }: exactly what decides how a sentence sounds, so the key
    changes when, and only when, the sentence has to be recorded again. */
export function flattenTurns(ep) {
  const turns = []
  ;(ep.segments || []).forEach((seg, si) => (seg.turns || []).forEach((turn) => {
    const sp = (ep.speakers || {})[turn.speaker] || {}
    const speed = Number(turn.speed ?? sp.speed ?? 1)
    const sentences = splitSentences(turn.say)
    const takes = sentences.map((s) => {
      const t = { text: spoken(s, ep.pronounce), voice: sp.voice, speed, lang: langOf(ep, sp) }
      return { key: takeKey(t), ...t }
    })
    turns.push({ index: turns.length, id: turn.id || `t${String(turns.length + 1).padStart(2, '0')}`, segment: si, speaker: turn.speaker, say: String(turn.say || '').trim(), gap: turn.gap, sentences, takes })
  }))
  return turns
}

/** A fingerprint of everything that shapes the audio and the timeline: speakers, turns, chapter titles,
    pronunciations, audio and music settings, and the key of every recording. Stored in build/timeline.json so
    that captions, notes, chapters, verify and video refuse to work from an out-of-date timeline. Cover, video,
    claims, summary and source are left out: changing them needs no new audio. */
export function scriptHash(ep, turns) {
  const parts = { speakers: ep.speakers, segments: ep.segments, pronounce: ep.pronounce || {}, lang: ep.lang || null, audio: ep.audio, music: ep.music,
    takes: turns.map((t) => t.takes.map((k) => k.key)) }
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/** the absolute path of a file named in episode.json, which must lie inside the project folder */
export function projectFile(P, file, what = 'file') {
  const full = resolve(P, String(file)), rel = relative(resolve(P), full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${what} must be a file inside the project folder ${resolve(P)}: ${file}`)
  return full
}
export const insideProject = (P, file) => { try { projectFile(P, file); return true } catch { return false } }

export const wordsOf = (text) => String(text || '').split(/\s+/).filter(Boolean)
export const countWords = (text) => wordsOf(text).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

const VALUE_FLAGS = new Set(['workers', 'quality', 'size', 'format', 'style', 'at', 'seconds', 'fps', 'crf', 'width'])
/** "--size 720 --gif a b" -> { flags: { size: '720', gif: true }, rest: ['a', 'b'] }. "--no-x" sets x to false. */
export function parseArgs(argv) {
  const flags = {}, rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const [key, inline] = a.slice(2).split(/=(.*)/s)
    if (key.startsWith('no-')) flags[key.slice(3)] = false
    else if (VALUE_FLAGS.has(key)) {
      const v = inline ?? argv[++i]
      if (v === undefined) throw new Error(`--${key} needs a value`)
      flags[key] = v
    } else flags[key] = inline ?? true
  }
  return { flags, rest }
}

export function numFlag(flags, key, fallback, min, max) {
  if (flags[key] === undefined) return fallback
  const n = Number(flags[key])
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${key} must be a number from ${min} to ${max}`)
  return n
}
