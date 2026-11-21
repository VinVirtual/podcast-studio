// Incremental recording: which sentences have to be spoken again. Pure.

/** `turns` come from flattenTurns, `cached` is the set of take keys already on disk.
    A take's key covers its spoken text, voice, speed and language, so a take is recorded again only
    when one of those changed. The same sentence said twice by the same voice is recorded once. */
export function planTakes(turns, cached) {
  const have = cached instanceof Set ? cached : new Set(cached)
  const record = new Map(), used = new Set(), changed = []
  let reused = 0
  for (const turn of turns) {
    let fresh = false
    for (const take of turn.takes) {
      used.add(take.key)
      if (have.has(take.key)) { reused++; continue }
      fresh = true
      if (!record.has(take.key)) record.set(take.key, take)
    }
    if (fresh) changed.push(turn.id)
  }
  return { record: [...record.values()], reused, total: turns.reduce((n, t) => n + t.takes.length, 0), changed, stale: [...have].filter((k) => !used.has(k)) }
}

export const planSummary = (p) => `${p.total} sentence(s): ${p.record.length} to record, ${p.reused} reused from earlier runs` +
  (p.changed.length && p.changed.length <= 12 ? ` (turns ${p.changed.join(', ')})` : '')
