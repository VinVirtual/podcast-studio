// A small episode shared by the tests.
import { withDefaults, flattenTurns } from '../engine/lib/episode.mjs'
import { layout, estimateMetas } from '../engine/lib/timing.mjs'

export const EPISODE = {
  show: 'Test Show', title: 'A test', episode: 3, summary: 'A summary.',
  speakers: { ana: { name: 'Ana', voice: 'af_heart', role: 'explains' }, ben: { name: 'Ben', voice: 'am_michael', speed: 1.1, role: 'asks' } },
  claims: [
    { claim: 'A tide is the sea rising and falling twice a day in most places.', source: 'paragraph 1', confirmed: true },
    { claim: 'The moon pulls on the water; the sun does too, but less.', source: 'paragraph 2', confirmed: true },
  ],
  segments: [
    { title: 'Opening', turns: [{ speaker: 'ben', say: 'Welcome back. What is a tide?' }, { speaker: 'ana', say: "I'm Ana, a computer-generated voice, and a tide is the sea rising and falling twice a day in most places." }] },
    { title: 'Why', turns: [{ speaker: 'ben', say: 'Right.' }, { speaker: 'ana', say: 'The moon pulls on the water. The sun does too, but less.' }, { speaker: 'ben', say: 'So the moon does most of the work?' }, { speaker: 'ana', say: 'Yes.' }] },
  ],
}
export const clone = (x) => JSON.parse(JSON.stringify(x))
export function timelineOf(ep = EPISODE, patch = {}) {
  const full = withDefaults({ ...clone(ep), ...patch }), turns = flattenTurns(full)
  return { ep: full, turns, timeline: layout(full, turns, estimateMetas(turns)) }
}
