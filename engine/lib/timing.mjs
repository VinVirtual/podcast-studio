// When everything happens: the gap before each turn, where each sentence and word falls, and the
// episode length. Pure maths on the recorded lengths, so it can be tested without any audio.
import { wordsOf } from './episode.mjs'
import { chapterList } from './chapters.mjs'

/** seconds of silence. Speakers never overlap: every gap is zero or more. */
export const GAPS = { turn: 0.34, afterQuestion: 0.24, reaction: 0.18, sameSpeaker: 0.45, chapter: 0.95, sentence: 0.3, jitter: 0.05 }
export const LEAD = 0.4            // silence before the first word when there is no intro music
export const TAIL = 0.7            // silence after the last word when there is no outro music
export const REACTION_WORDS = 3    // a turn this short ("Right.", "Oh, I see.") comes in quickly
export const SPEAKER_COLOURS = ['#fca311', '#7fd1c7', '#ef8fa0', '#b9a7ff', '#9ad17f', '#f2c879']
const SYLLABLES_PER_SECOND = 4.9   // Kokoro at speed 1, measured on the example episode
const r3 = (x) => Math.round(x * 1000) / 1000

export function syllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return 1
  return Math.max(1, (w.match(/[aeiouy]+/g) || []).length - (w.endsWith('e') && w.length > 3 ? 1 : 0))
}

/** a small, repeatable offset in [-1, 1] so the gaps are not all the same length */
export const jitter = (index) => ((index * 7919) % 11) / 5 - 1

/** Silence before a turn. `prev` is the turn before it (null for the first turn). */
export function gapBefore(prev, cur, pace = 1) {
  if (!prev) return 0
  if (Number.isFinite(cur.gap)) return Math.max(0, cur.gap)
  let base = GAPS.turn
  if (cur.segment !== prev.segment) base = GAPS.chapter
  else if (cur.speaker === prev.speaker) base = GAPS.sameSpeaker
  else if (wordsOf(cur.say).length <= REACTION_WORDS) base = GAPS.reaction
  else if (/\?["')\]]?$/.test(prev.say)) base = GAPS.afterQuestion
  return r3(Math.max(0.08, (base + jitter(cur.index) * GAPS.jitter) * pace))
}

const endsPhrase = (w) => /[,;:.?!…]["')\]]?$/.test(w) || /^[—–-]$/.test(w)
export const MIN_PAUSE = 0.15      // shorter silences inside a recording are consonants, not pauses

/** Pair silences with phrase ends. `mids` are the middles of the silences and `guesses` the times where
    the phrase ends were expected, both in order. Returns for each silence the index of its phrase end,
    keeping the order and making the total distance as small as possible. Needs mids.length <= guesses.length. */
export function matchPauses(mids, guesses) {
  const k = mids.length, m = guesses.length
  // best[p][b]: least cost of placing silences 0..p with silence p on phrase end b
  const best = mids.map(() => new Array(m).fill(Infinity)), from = mids.map(() => new Array(m).fill(-1))
  for (let p = 0; p < k; p++) for (let b = p; b <= m - (k - p); b++) {
    const cost = Math.abs(mids[p] - guesses[b])
    if (p === 0) { best[p][b] = cost; continue }
    for (let a = p - 1; a < b; a++) if (best[p - 1][a] + cost < best[p][b]) { best[p][b] = best[p - 1][a] + cost; from[p][b] = a }
  }
  const out = new Array(k)
  let b = k ? best[k - 1].indexOf(Math.min(...best[k - 1])) : -1
  for (let p = k - 1; p >= 0; p--) { out[p] = b; b = from[p][b] }
  return out
}

/** Start and end of each word inside one recorded sentence, in seconds from its start.
    Words share the time by syllable count. `pauses` are the silences found in the recording
    ([[start, end], ...]); each real pause is pinned to the comma or full stop it most likely belongs to,
    and the words between two pinned pauses share the time between them. This is an estimate, not a
    measurement of each word. */
export function wordTimes(words, dur, pauses = []) {
  if (!words.length) return []
  const all = words.map((_, i) => i), out = new Array(words.length)
  const spread = (idx, from, to) => {
    const weights = idx.map((i) => syllables(words[i])), rests = idx.map((i, n) => (n < idx.length - 1 && endsPhrase(words[i]) ? 0.7 : 0))
    const total = weights.reduce((a, b) => a + b, 0) + rests.reduce((a, b) => a + b, 0)
    let acc = 0
    idx.forEach((i, n) => { const t = from + (acc / total) * (to - from); acc += weights[n]; out[i] = { t: r3(t), e: r3(from + (acc / total) * (to - from)) }; acc += rests[n] })
  }
  spread(all, 0, dur)
  const ends = all.filter((i) => i < words.length - 1 && endsPhrase(words[i]))
  const real = pauses.filter((p) => p[1] - p[0] >= MIN_PAUSE && p[0] > 0.02 && p[1] < dur - 0.02)
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, ends.length).sort((a, b) => a[0] - b[0])
  if (!real.length) return out
  const guesses = ends.map((i) => (out[i].e + out[i + 1].t) / 2), mids = real.map((p) => (p[0] + p[1]) / 2)
  const far = Math.max(0.6, dur * 0.25)
  const pins = matchPauses(mids, guesses).map((b, p) => ({ after: ends[b], pause: real[p], off: Math.abs(mids[p] - guesses[b]) })).filter((x) => x.off <= far)
  let first = 0, from = 0
  for (const pin of pins) { spread(all.slice(first, pin.after + 1), from, pin.pause[0]); first = pin.after + 1; from = pin.pause[1] }
  spread(all.slice(first), from, dur)
  return out
}

/** recorded lengths guessed from the text alone, for lint and tests: { key: { dur, pauses } } */
export function estimateMetas(turns) {
  const metas = {}
  for (const turn of turns) turn.takes.forEach((take, j) => {
    const words = wordsOf(turn.sentences[j])
    const dur = words.reduce((a, w) => a + syllables(w), 0) / SYLLABLES_PER_SECOND / (take.speed || 1) + words.filter(endsPhrase).length * 0.14
    metas[take.key] = { dur: r3(Math.max(0.3, dur)), pauses: [] }
  })
  return metas
}

export function speakerTable(ep) {
  const ids = Object.keys(ep.speakers || {}), n = ids.length
  return Object.fromEntries(ids.map((id, i) => {
    const s = ep.speakers[id]
    const pan = Number.isFinite(s.pan) ? Math.max(-1, Math.min(1, s.pan)) : n < 2 ? 0 : r3(-0.18 + (0.36 * i) / (n - 1))
    return [id, { name: s.name || id, role: s.role || '', voice: s.voice, color: s.color || SPEAKER_COLOURS[i % SPEAKER_COLOURS.length], pan }]
  }))
}

/** The whole episode on one clock. `metas` gives the length of every take ({ key: { dur, pauses } }).
    Returns the timeline that the mix, the captions, the chapters, the notes and the video all read. */
export function layout(ep, turns, metas) {
  const music = ep.music, pace = ep.audio.pace || 1
  let t = music.on ? music.intro : LEAD
  const speechStart = t, out = []
  turns.forEach((turn, i) => {
    t += gapBefore(i ? turns[i - 1] : null, turn, pace)
    const start = t, takes = [], words = []
    turn.takes.forEach((take, j) => {
      const meta = metas[take.key]
      if (!meta) throw new Error(`no recording for turn ${turn.id}, sentence ${j + 1}`)
      if (j) t += GAPS.sentence * pace
      const list = wordsOf(turn.sentences[j])
      wordTimes(list, meta.dur, meta.pauses).forEach((wt, n) => words.push({ w: list[n], t: r3(t + wt.t), e: r3(t + wt.e) }))
      takes.push({ key: take.key, start: r3(t), dur: meta.dur })
      t += meta.dur
    })
    out.push({ id: turn.id, index: turn.index, segment: turn.segment, speaker: turn.speaker, start: r3(start), end: r3(t), say: turn.say, takes, words })
  })
  const speechEnd = t, total = r3(speechEnd + (music.on ? music.tail : TAIL))
  return { version: 1, show: ep.show || '', title: ep.title || '', total, fps: ep.video.fps || 30, speechStart: r3(speechStart), speechEnd: r3(speechEnd),
    speakers: speakerTable(ep), chapters: chapterList(ep.segments || [], out, total),
    music: music.on ? { on: true, intro: music.intro, under: music.under, outro: music.outro, tail: music.tail, volume: music.volume, bpm: music.bpm, chords: music.chords } : { on: false },
    turns: out }
}
