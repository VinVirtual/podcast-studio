// The audio pipeline: plan, record, lay out, mix, normalise, encode, verify.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE, findFF, findPython } from './env.mjs'
import { flattenTurns, readJson, targetLufs, bitrateOf, scriptHash, projectFile } from './episode.mjs'
import { planTakes, planSummary } from './plan.mjs'
import { layout } from './timing.mjs'
import { parseEbur128, gainPlan, refineGain, withinTolerance, normaliseFilter, nextMasterStep, PEAK_MARGIN } from './loudness.mjs'
import { toFfmetadata, toChapterText, toChapterJson, parseFfmetadata } from './chapters.mjs'
import { toVtt, toSrt } from './captions.mjs'
import { toNotes, DISCLOSURE } from './notes.mjs'
import { judge } from './verify.mjs'

/** run ffmpeg to the end and return what it wrote to stderr */
export function ffmpeg(FF, args, { quiet = true } = {}) {
  return new Promise((done, fail) => {
    const c = spawn(FF, ['-y', '-hide_banner', '-nostats', ...(quiet ? ['-loglevel', 'error'] : []), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = '', out = ''
    c.stderr.on('data', (d) => { err += d }); c.stdout.on('data', (d) => { out += d })
    c.on('error', (e) => fail(new Error(`could not start ffmpeg (${FF}): ${e.message}`)))
    c.on('close', (code) => (code ? fail(new Error(`ffmpeg exited with code ${code}\n${err.trim().split('\n').slice(-4).join('\n')}`)) : done({ err, out })))
  })
}

function python(command, job, dir) {
  const file = join(dir, `.job-${command}.json`)
  writeFileSync(file, JSON.stringify(job))
  const r = spawnSync(findPython(), [join(ENGINE, 'audio.py'), command, file], { stdio: 'inherit' })
  rmSync(file, { force: true })
  if (r.error) throw new Error(`could not start Python (${findPython()}): ${r.error.message}`)
  if (r.status) throw new Error(`the ${command} step failed`)
}

/** how the voice will pronounce each item's text, as IPA, without recording anything: [{ text, lang, ipa }] */
export function phonemes(P, items) {
  const dir = join(P, 'build'), out = join(dir, '.phonemes.json')
  mkdirSync(dir, { recursive: true })
  python('phonemes', { items, out }, dir)
  const result = readJson(out, 'phonemes'); rmSync(out, { force: true })
  return result
}

export const paths = (P) => ({ build: join(P, 'build'), out: join(P, 'out'), takes: join(P, 'build', 'takes'), timeline: join(P, 'build', 'timeline.json'),
  mix: join(P, 'build', 'mix.wav'), voice: join(P, 'build', 'voice.wav'), master: join(P, 'build', 'master.wav'), report: join(P, 'build', 'report.json'), viz: join(P, 'build', 'viz.json') })

export const cachedKeys = (dir) => new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && existsSync(join(dir, f.replace(/\.json$/, '.wav')))).map((f) => f.slice(0, -5)) : [])

/** build/timeline.json, refused when episode.json changed since it was made (pass the episode to check) */
export function loadTimeline(P, ep) {
  const f = paths(P).timeline
  if (!existsSync(f)) throw new Error(`no timeline yet (${f}). Make the audio first: podcast audio ${P}`)
  const timeline = readJson(f, 'timeline')
  if (ep && timeline.scriptHash !== scriptHash(ep, flattenTurns(ep)))
    throw new Error(`episode.json changed since the audio was made, so ${f} and the audio are out of date. Run: podcast audio ${P}`)
  return timeline
}

let RESAMPLER = null
/** 'soxr' when this ffmpeg was built with libsoxr, else 'swr' (ffmpeg's own resampler) */
export async function resamplerOf(FF) {
  if (RESAMPLER) return RESAMPLER
  const { out, err } = await ffmpeg(FF, ['-buildconf'], { quiet: false })
  RESAMPLER = /--enable-libsoxr/.test(out + err) ? 'soxr' : 'swr'
  return RESAMPLER
}

/** integrated loudness, loudness range and true peak of an audio file, measured by ffmpeg's EBU R128 filter */
export async function measure(FF, file) {
  const { err } = await ffmpeg(FF, ['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { quiet: false })
  return parseEbur128(err)
}

/** mix.wav -> master.wav at the target loudness. Gain first; a limiter holds peaks at the ceiling; measured
    again and corrected until it is within 0.1 LU (at most four passes). */
export async function normalise(FF, src, dest, { target, ceiling, sampleRate, channels }) {
  const before = await measure(FF, src), plan = gainPlan(before, target, ceiling), resampler = await resamplerOf(FF)
  let gain = plan.gain, after = null, passes = 0
  while (passes < 6) {
    passes++
    await ffmpeg(FF, ['-i', src, '-af', normaliseFilter({ gain, ceiling, sampleRate, channels, resampler }), '-c:a', 'pcm_s24le', dest])
    after = await measure(FF, dest)
    if (withinTolerance(after.lufs, target, 0.1)) break
    gain = refineGain(gain, after.lufs, target)
  }
  return { before, after, gain, over: plan.over, limited: plan.limited, passes }
}

/** Normalise, encode, measure the encoded files, and go again until every file is within 0.5 LU of the
    target and no true peak (measured 4x oversampled by ffmpeg's EBU R128 meter) is above the ceiling.
    Each encoded file must land within 0.3 LU of the target (verify accepts 0.5). At most four rounds. */
export async function masterAndEncode(P, ep, timeline, { target, ceiling }) {
  const FF = findFF(), p = paths(P)
  let aim = target, margin = PEAK_MARGIN, norm = null, files = null, step = null, rounds = 0
  while (rounds < 4) {
    rounds++
    norm = await normalise(FF, p.mix, p.master, { target: aim, ceiling: ceiling - margin, sampleRate: ep.audio.sampleRate, channels: ep.audio.channels })
    files = await encode(P, ep, timeline)
    step = nextMasterStep({ files, master: norm.after, target, ceiling, aim, margin })
    if (step.done) break
    aim = step.aim; margin = step.margin
  }
  return { norm, files, rounds, margin, aim, done: step.done, peak: step.peak }
}

const CODECS = { mp3: (rate) => ['-c:a', 'libmp3lame', '-b:a', rate, '-id3v2_version', '3'], m4a: (rate) => ['-c:a', 'aac', '-b:a', rate, '-movflags', '+faststart'] }

export function tags(ep) {
  return { title: ep.title, artist: ep.author || ep.show, album: ep.show, track: Number.isFinite(ep.episode) ? ep.episode : undefined, genre: 'Podcast', date: ep.date,
    comment: ep.disclosure === false ? undefined : ep.disclosure_text || DISCLOSURE }
}

/** master.wav -> out/episode.mp3 and .m4a, with tags and chapter marks inside the files */
export async function encode(P, ep, timeline) {
  const FF = findFF(), p = paths(P)
  if (!existsSync(p.master)) throw new Error(`no mastered audio yet (${p.master}). Run: podcast audio ${P}`)
  mkdirSync(p.out, { recursive: true })
  const meta = join(p.build, 'chapters.ffmeta'); writeFileSync(meta, toFfmetadata(timeline.chapters, tags(ep)))
  const files = []
  for (const fmt of ep.audio.formats) {
    const file = join(p.out, `episode.${fmt}`)
    await ffmpeg(FF, ['-i', p.master, '-i', meta, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', ...CODECS[fmt](bitrateOf(ep.audio)), file])
    const back = parseFfmetadata((await ffmpeg(FF, ['-i', file, '-f', 'ffmetadata', '-'])).out)
    files.push({ file, format: fmt, bytes: statSync(file).size, chapters: back.length, ...(await measure(FF, file)) })
  }
  return files
}

export function writeChapterFiles(P, timeline) {
  const out = paths(P).out; mkdirSync(out, { recursive: true })
  const txt = join(out, 'chapters.txt'), json = join(out, 'chapters.json')
  writeFileSync(txt, toChapterText(timeline.chapters)); writeFileSync(json, toChapterJson(timeline.chapters))
  return [txt, json]
}
export function writeCaptions(P, timeline) {
  const out = paths(P).out; mkdirSync(out, { recursive: true })
  const vtt = join(out, 'episode.vtt'), srt = join(out, 'episode.srt')
  writeFileSync(vtt, toVtt(timeline)); writeFileSync(srt, toSrt(timeline))
  return [vtt, srt]
}
export function writeNotes(P, ep, timeline) {
  const out = paths(P).out; mkdirSync(out, { recursive: true })
  const md = join(out, 'notes.md'); writeFileSync(md, toNotes(ep, timeline))
  return [md]
}

/** Everything from the script to the encoded files. Returns the report that is also saved as build/report.json. */
export async function makeAudio(P, ep, { log = () => {}, dryRun = false } = {}) {
  const FF = findFF(), p = paths(P)
  mkdirSync(p.takes, { recursive: true }); mkdirSync(p.out, { recursive: true })
  const turns = flattenTurns(ep), plan = planTakes(turns, cachedKeys(p.takes))
  log(planSummary(plan))
  if (dryRun) return { plan }
  if (plan.record.length) python('synth', { cache: p.takes, takes: plan.record }, p.build)
  const metas = {}
  for (const turn of turns) for (const take of turn.takes) metas[take.key] = readJson(join(p.takes, `${take.key}.json`), 'recording')
  const timeline = { ...layout(ep, turns, metas), scriptHash: scriptHash(ep, turns) }
  writeFileSync(p.timeline, JSON.stringify(timeline, null, 1))

  let musicFile = null
  if (ep.music.on && ep.music.file) {
    musicFile = join(p.build, 'music-src.wav')
    await ffmpeg(FF, ['-i', projectFile(P, ep.music.file, 'music.file'), '-ar', '24000', '-ac', '2', '-c:a', 'pcm_f32le', musicFile])
  }
  const mixReport = join(p.build, '.mix.json')
  python('mix', { timeline, cache: p.takes, channels: ep.audio.channels, music_file: musicFile, out_mix: p.mix, out_voice: p.voice, out_report: mixReport }, p.build)
  const mixed = readJson(mixReport, 'mix report'); rmSync(mixReport, { force: true })

  const target = targetLufs(ep.audio)
  const m = await masterAndEncode(P, ep, timeline, { target, ceiling: ep.audio.peak }), norm = m.norm, files = m.files
  const report = { total: timeline.total, turns: turns.length, recorded: plan.record.length, reused: plan.reused, target, ceiling: ep.audio.peak,
    mix: norm.before, master: norm.after, gain: norm.gain, limiterReduction: norm.over, passes: norm.passes, rounds: m.rounds, margin: m.margin, settled: m.done,
    speakerGainDb: mixed.speaker_gain_db, files, unused: plan.stale.length }
  writeFileSync(p.report, JSON.stringify(report, null, 1))
  return { plan, timeline, report }
}

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1000)} kB`)
export function formatReport(r) {
  const lines = [`length    ${r.total.toFixed(1)} s, ${r.turns} turns (${r.recorded} sentence(s) recorded now, ${r.reused} reused)`,
    `mix       ${r.mix.lufs.toFixed(1)} LUFS before normalising, true peak ${r.mix.peak.toFixed(1)} dBFS`,
    `gain      ${r.gain >= 0 ? '+' : ''}${r.gain.toFixed(1)} dB to reach ${r.target} LUFS` + (r.limiterReduction > 0 ? `; the limiter holds true peaks under ${r.ceiling} dBFS (up to ${r.limiterReduction.toFixed(1)} dB taken off the loudest peaks)` : '; no limiting needed'),
    `master    ${r.rounds} round(s) of normalise, encode and measure; limiter set ${r.margin.toFixed(1)} dB under the ceiling` + (r.settled ? '' : `. NOT SETTLED: a file is still over ${r.ceiling} dBFS or off the target; run podcast verify for advice`),
    `speakers  levelled by ${Object.entries(r.speakerGainDb).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v} dB`).join(', ')}`]
  if (r.unused) lines.push(`unused    ${r.unused} recording(s) in build/takes are no longer in the script; podcast clean removes them`)
  for (const f of r.files) lines.push(`${f.format.padEnd(9)} ${f.lufs.toFixed(1)} LUFS measured, true peak ${f.peak.toFixed(1)} dBFS, range ${f.lra.toFixed(1)} LU, ${f.chapters} chapter(s), ${kb(f.bytes)}  ${f.file}`)
  return lines.join('\n')
}

/** decode the finished file and check it against the timeline */
export async function verify(P, ep) {
  const FF = findFF(), p = paths(P), timeline = loadTimeline(P, ep)
  const all = ep.audio.formats.map((f) => join(p.out, `episode.${f}`)), missing = all.filter((f) => !existsSync(f))
  if (missing.length) throw new Error(`no finished audio (${missing.join(', ')}). Run: podcast audio ${P}`)
  const file = all[0]
  const wav = join(p.build, 'verify.wav'), out = join(p.build, 'verify.json')
  await ffmpeg(FF, ['-i', file, '-ar', '24000', '-c:a', 'pcm_f32le', wav])
  python('verify', { wav, voice: p.voice, timeline, out }, p.build)
  const m = readJson(out, 'verify result'), target = targetLufs(ep.audio)
  rmSync(wav, { force: true })
  // loudness and true peak of every encoded file; the checks use the worst of them
  const files = []
  for (const f of all) files.push({ file: f, ...(await measure(FF, f)) })
  const worstLufs = files.reduce((a, f) => (Math.abs(f.lufs - target) > Math.abs(a.lufs - target) ? f : a)), worstPeak = files.reduce((a, f) => (f.peak > a.peak ? f : a))
  const full = { ...m, lufs: worstLufs.lufs, lufsFile: worstLufs.file, truePeak: worstPeak.peak, peakFile: worstPeak.file, lra: worstLufs.lra, target, ceiling: ep.audio.peak, files, file }
  writeFileSync(out, JSON.stringify(full, null, 1))
  return { file, measured: full, checks: judge(full) }
}

/** remove recordings no script line uses any more. Returns how many files were removed. */
export function cleanTakes(P, ep) {
  const dir = paths(P).takes, used = new Set(flattenTurns(ep).flatMap((t) => t.takes.map((k) => k.key)))
  let removed = 0
  for (const key of cachedKeys(dir)) if (!used.has(key)) for (const ext of ['.wav', '.json']) { rmSync(join(dir, key + ext), { force: true }); removed++ }
  return removed / 2
}

/** spectrum data for the video, made again only when the mastered audio is newer */
export function vizData(P, fps, bands = 40) {
  const p = paths(P)
  if (!existsSync(p.master)) throw new Error(`no mastered audio yet (${p.master}). Run: podcast audio ${P}`)
  const fresh = existsSync(p.viz) && statSync(p.viz).mtimeMs >= statSync(p.master).mtimeMs
  const have = fresh ? readJson(p.viz, 'viz data') : null
  if (!have || have.fps !== fps || have.bands !== bands) python('viz', { wav: p.master, fps, bands, out: p.viz }, p.build)
  return JSON.parse(readFileSync(p.viz, 'utf8'))
}
