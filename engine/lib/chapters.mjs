// Chapters: one per segment of the script. Pure.

const pad = (n, w = 2) => String(n).padStart(w, '0')
/** seconds -> "M:SS", or "H:MM:SS" from one hour on: the form podcast apps and video sites read in a description */
export function clock(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** [{ title, start, end }] in seconds. A chapter starts with the first word of its segment, the first
    chapter starts at 0 (so it covers the intro music), each ends where the next begins and the last
    ends with the episode. Segments with no turns are left out. */
export function chapterList(segments, turns, total) {
  const marks = []
  segments.forEach((seg, si) => {
    const first = turns.find((t) => t.segment === si)
    if (first) marks.push({ title: String(seg.title || '').replace(/\s+/g, ' ').trim() || `Part ${si + 1}`, start: first.start })
  })
  return marks.map((m, i) => ({ title: m.title, start: i === 0 ? 0 : m.start, end: i < marks.length - 1 ? marks[i + 1].start : total }))
}

const escapeMeta = (s) => String(s).replace(/([=;#\\])/g, '\\$1').replace(/\r?\n/g, '\\\n')
/** an FFMETADATA1 file: tags plus chapter marks in milliseconds. ffmpeg writes these into MP3 (ID3v2 CHAP
    frames) and M4A (chapter atoms). */
export function toFfmetadata(chapters, tags = {}) {
  const lines = [';FFMETADATA1']
  for (const [k, v] of Object.entries(tags)) if (v !== undefined && v !== null && v !== '') lines.push(`${k}=${escapeMeta(v)}`)
  for (const c of chapters) {
    const start = Math.round(c.start * 1000), end = Math.max(start + 1, Math.round(c.end * 1000))
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${escapeMeta(c.title)}`)
  }
  return lines.join('\n') + '\n'
}

/** "0:00 Title" lines, ready to paste into a description */
export const toChapterText = (chapters) => chapters.map((c) => `${clock(c.start)} ${c.title}`).join('\n') + '\n'

/** the JSON chapters file of the Podcasting 2.0 namespace (podcast:chapters) */
export const toChapterJson = (chapters) => JSON.stringify({ version: '1.2.0', chapters: chapters.map((c) => ({ startTime: Math.round(c.start * 1000) / 1000, title: c.title })) }, null, 2) + '\n'

const micro = (x) => Math.round(x * 1e6) / 1e6
/** chapters read back from `ffmpeg -i file -f ffmetadata -`: [{ title, start, end }] in seconds */
export function parseFfmetadata(text) {
  const out = []; let cur = null, base = 1 / 1000
  for (const line of String(text).split(/\r?\n/)) {
    if (line === '[CHAPTER]') { cur = { title: '', start: 0, end: 0 }; out.push(cur); base = 1 / 1000; continue }
    if (/^\[/.test(line)) { cur = null; continue }
    if (!cur) continue
    const m = line.match(/^(\w+)=(.*)$/); if (!m) continue
    if (m[1] === 'TIMEBASE') { const [a, b] = m[2].split('/').map(Number); base = a / b }
    else if (m[1] === 'START') cur.start = micro(Number(m[2]) * base)
    else if (m[1] === 'END') cur.end = micro(Number(m[2]) * base)
    else if (m[1] === 'title') cur.title = m[2].replace(/\\([=;#\\])/g, '$1')
  }
  return out
}
