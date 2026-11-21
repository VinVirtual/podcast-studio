// Caption cues and the .vtt and .srt writers. Pure: no file access.

const pad = (n, w = 2) => String(n).padStart(w, '0')
/** seconds -> "HH:MM:SS.mmm" (WebVTT) or "HH:MM:SS,mmm" (SRT) */
export function stamp(sec, sep = '.') {
  const ms = Math.max(0, Math.round(sec * 1000))
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`
}

const endsSentence = (w) => /[.?!…]["')\]]?$/.test(w)
const endsPhrase = (w) => /[,;:]["')\]]?$/.test(w)
const chars = (ws) => ws.reduce((n, w) => n + w.w.length + 1, -1)

/** cut one sentence's words into pieces of at most `maxChars`, about even in length, cutting after a comma when one is near */
export function splitLong(ws, maxChars) {
  const total = chars(ws)
  if (total <= maxChars) return [ws]
  const n = Math.ceil(total / maxChars), target = total / n, out = []
  let cur = []
  ws.forEach((w, i) => {
    if (cur.length && chars([...cur, w]) > maxChars) { out.push(cur); cur = [] }
    cur.push(w)
    const len = chars(cur), more = i < ws.length - 1
    if (more && out.length < n - 1 && (len >= target || (len >= target * 0.7 && endsPhrase(w.w)))) { out.push(cur); cur = [] }
  })
  if (cur.length) out.push(cur)
  const last = out[out.length - 1], before = out[out.length - 2]
  if (before && last.length === 1 && chars([...before, ...last]) <= maxChars) out.splice(out.length - 2, 2, [...before, ...last])
  return out
}

/** Cues from a timeline: [{ start, end, speaker, name, text, words, turn, first }].
    A cue never crosses a sentence or a turn. A one or two word sentence joins the next one when it fits.
    A cue ends when the next starts, or `linger` seconds after its last word. */
export function cues(timeline, { maxChars = 64, linger = 0.4, minLength = 0.35 } = {}) {
  const list = []
  for (const turn of timeline.turns) {
    const sentences = []; let cur = []
    for (const w of turn.words) { cur.push(w); if (endsSentence(w.w)) { sentences.push(cur); cur = [] } }
    if (cur.length) sentences.push(cur)
    const merged = []
    for (const s of sentences) {
      const last = merged[merged.length - 1]
      if (last && last.length <= 2 && chars(last) + 1 + chars(s) <= maxChars) merged[merged.length - 1] = [...last, ...s]
      else merged.push(s)
    }
    let first = true
    for (const s of merged) for (const piece of splitLong(s, maxChars)) {
      list.push({ turn: turn.id, speaker: turn.speaker, name: (timeline.speakers[turn.speaker] || {}).name || turn.speaker, first, words: piece, text: piece.map((w) => w.w).join(' ') })
      first = false
    }
  }
  return list.map((c, i) => {
    const start = c.words[0].t, lastEnd = c.words[c.words.length - 1].e, next = list[i + 1] ? list[i + 1].words[0].t : Infinity
    const end = Math.min(next, Math.max(lastEnd + linger, start + minLength), timeline.total ?? Infinity)
    return { ...c, start, end: Math.max(end, Math.min(next, start + 0.05)) }
  })
}

const vttText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const vttName = (s) => s.replace(/[<>&\s]+/g, ' ').trim()

/** WebVTT with a voice tag on every cue: <v Name>text */
export function toVtt(timeline, opts) {
  return 'WEBVTT\n\n' + cues(timeline, opts).map((q, i) => `${i + 1}\n${stamp(q.start)} --> ${stamp(q.end)}\n<v ${vttName(q.name)}>${vttText(q.text)}\n`).join('\n')
}

/** SRT has no speaker field, so the name is written before the first cue of each turn: "Name: text" */
export function toSrt(timeline, opts) {
  return cues(timeline, opts).map((q, i) => `${i + 1}\n${stamp(q.start, ',')} --> ${stamp(q.end, ',')}\n${q.first ? `${q.name}: ` : ''}${q.text}\n`).join('\n')
}
