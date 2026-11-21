// Show notes in Markdown: title, summary, chapters, speakers, sources and the full transcript. Pure.
import { clock } from './chapters.mjs'

export const DISCLOSURE = 'The voices in this episode are computer-generated (Kokoro text to speech). They are not recordings of real people.'
const line = (s) => String(s || '').replace(/\s+/g, ' ').trim()

export function toNotes(ep, timeline) {
  const out = [], names = timeline.speakers
  out.push(`# ${line(ep.title) || 'Untitled episode'}`, '')
  const meta = [line(ep.show), Number.isFinite(ep.episode) ? `Episode ${ep.episode}` : '', `${clock(timeline.total)} long`].filter(Boolean)
  out.push(`*${meta.join(' · ')}*`, '')
  if (line(ep.summary)) out.push(line(ep.summary), '')
  if (ep.disclosure !== false) out.push(`> ${line(ep.disclosure_text) || DISCLOSURE}`, '')

  out.push('## Chapters', '')
  for (const c of timeline.chapters) out.push(`- \`${clock(c.start)}\` ${c.title}`)
  out.push('')

  out.push('## Voices', '')
  for (const s of Object.values(names)) out.push(`- **${s.name}**${s.role ? `: ${s.role}` : ''} (synthetic voice \`${s.voice}\`)`)
  out.push('')

  const src = ep.source
  if (src && (line(src.title) || line(src.url))) {
    out.push('## Source', '')
    const label = line(src.title) || line(src.url), by = line(src.author) ? `, by ${line(src.author)}` : ''
    out.push(`This episode is a spoken version of ${line(src.url) ? `[${label}](${line(src.url)})` : `"${label}"`}${by}.`, '')
  }

  out.push('## Transcript', '')
  timeline.chapters.forEach((c, ci) => {
    out.push(`### ${c.title}`, '')
    const last = ci === timeline.chapters.length - 1
    for (const t of timeline.turns.filter((t) => (ci === 0 || t.start >= c.start) && (last || t.start < c.end)))
      out.push(`**${(names[t.speaker] || {}).name || t.speaker}** \`${clock(t.start)}\` ${line(t.say)}`, '')
  })
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
