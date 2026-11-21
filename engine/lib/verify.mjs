// Turning the numbers measured on a finished episode into pass or fail lines. Pure.
// Nothing here can tell whether the episode sounds natural: that needs a listener.

export const THRESHOLDS = { duration: 0.25, lufs: 0.5, quiet: 1.8, corr: 0.6, lag: 0.08, turnDb: -45, speakerSpread: 3 }

/** what to do when a check fails */
export const FIXES = {
  duration: 'the file does not match the timeline. Run podcast audio again; if it persists, delete the build folder and rebuild.',
  loudness: 'run podcast audio again. If it still misses, the target is too loud for the peak ceiling: lower audio.lufs (for example -16 instead of -14) or lower audio.peak (for example -1.5).',
  'no clipping': 'lower audio.lufs, or lower audio.peak so the limiter leaves more room (for example -1.5 or -2). A louder target squeezes the peaks harder.',
  'no long silence': 'a gap is too long: check "gap" on that turn, a chapter break after a very short segment, or a recording that came out silent (delete build/takes and record again).',
  'every turn at its time': 'a turn is missing or out of place: delete build/takes for that line (or the whole build folder) and run podcast audio again.',
  'speakers equally loud': 'one voice is much louder: try another voice for one speaker, or set "speed" closer to 1.',
}

/** `m` is what audio.py verify measured plus { lufs, truePeak, target, ceiling } from ffmpeg. Returns [{ ok, name, detail, fix }].
    The peak limit is the episode's own ceiling (audio.peak). */
export function judge(m, T = THRESHOLDS) {
  const checks = [], add = (ok, name, detail) => checks.push({ ok: !!ok, name, detail, ...(ok ? {} : { fix: FIXES[name] }) })
  const ceiling = Number.isFinite(m.ceiling) ? m.ceiling : -1
  add(Math.abs(m.duration - m.expected) <= T.duration, 'duration', `${m.duration.toFixed(2)} s, timeline says ${m.expected.toFixed(2)} s`)
  const many = (m.files || []).length > 1 ? ' (worst of the files)' : ''
  add(Math.abs(m.lufs - m.target) <= T.lufs + 1e-9, 'loudness', `${m.lufs.toFixed(1)} LUFS integrated${many}, target ${m.target} LUFS ± ${T.lufs}`)
  add(m.truePeak <= ceiling + 1e-9 && m.clipped_runs === 0, 'no clipping', `true peak ${m.truePeak.toFixed(1)} dBFS${many}, ceiling ${ceiling} dBFS, ${m.clipped_runs} run(s) of samples at full scale`)
  add(m.longest_quiet <= T.quiet, 'no long silence', m.longest_quiet ? `longest quiet stretch between the first and last word is ${m.longest_quiet.toFixed(2)} s, at ${m.longest_quiet_at.toFixed(1)} s` : 'no stretch under -50 dBFS between the first and last word')
  const bad = m.turns.filter((t) => t.corr < T.corr || Math.abs(t.lag) > T.lag || t.db < T.turnDb)
  const worst = m.turns.reduce((a, t) => (t.corr < a.corr ? t : a), m.turns[0] || { corr: 1, id: '-' })
  const maxLag = m.turns.reduce((a, t) => Math.max(a, Math.abs(t.lag)), 0)
  add(m.turns.length > 0 && !bad.length, 'every turn at its time', bad.length
    ? `${bad.length} of ${m.turns.length} turn(s) missing or shifted: ${bad.slice(0, 6).map((t) => `${t.id} (match ${t.corr}, ${Math.round(t.lag * 1000)} ms off, ${t.db} dB)`).join(', ')}`
    : `${m.turns.length} turns found; weakest match ${worst.corr} (${worst.id}), largest offset ${Math.round(maxLag * 1000)} ms`)
  const levels = Object.entries(m.speaker_db || {})
  if (levels.length > 1) {
    const spread = Math.max(...levels.map((l) => l[1])) - Math.min(...levels.map((l) => l[1]))
    add(spread <= T.speakerSpread, 'speakers equally loud', `${levels.map(([k, v]) => `${k} ${v} dB`).join(', ')} (${spread.toFixed(1)} dB apart)`)
  }
  return checks
}

export const formatChecks = (checks) => checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}`).join('\n')
