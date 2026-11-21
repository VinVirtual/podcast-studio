#!/usr/bin/env node
// podcast-studio command line. Run `podcast help` for the list of commands.
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENGINE, SKILL, findPython, findFF, findPlaywright, browserCandidates, launchBrowser, installHint } from './lib/env.mjs'
import { projectDir, loadEpisode, readJson, parseArgs, numFlag } from './lib/episode.mjs'
import { lintEpisode, formatIssues, flaggedWords, FORMATS, STYLES } from './lib/lintrules.mjs'
import { ffmpeg, resamplerOf, cleanTakes, phonemes, makeAudio, formatReport, verify, encode, loadTimeline, writeCaptions, writeChapterFiles, writeNotes } from './lib/audio.mjs'
import { formatChecks } from './lib/verify.mjs'
import { renderVideo, renderSheet, renderPreview } from './lib/video.mjs'

const HELP = `podcast-studio: a written article or a dialogue script becomes a finished audio episode, made on this machine.

  podcast check                 check the machine (Python, Kokoro, ffmpeg, node, Playwright, browser)
  podcast new <dir>             start a project (episode.json)
  podcast lint <project>        check the script: speakers, voices, long lines, speaker share,
                                pronunciations, unconfirmed claims, estimated length   [--strict] [--json]
  podcast phonemes <project>    how the voice will say the flagged words, in phonetic letters (or any "text" you add)
  podcast audio <project>       record changed lines, mix, normalise, write out/episode.mp3 and .m4a   [--dry-run]
  podcast verify <project>      measure the finished file: length, loudness, clipping, silences, every turn
  podcast captions <project>    out/episode.vtt and .srt with speaker names
  podcast chapters <project>    chapter marks inside the audio files, out/chapters.txt and chapters.json
  podcast notes <project>       out/notes.md: title, summary, chapters, transcript
  podcast sheet <project>       stills/sheet-<format>.png: frames of the video in one picture, to review the layout
  podcast video <project>       out/episode-<format>.mp4, the audiogram
  podcast preview <project>     a short silent looping clip of the video (animated WebP, or --gif)
  podcast clean <project>       delete recordings no line of the script uses any more   [--all: the whole build folder]
  podcast build <project>       lint, audio, verify, captions, chapters, notes, sheet and video   [--no-video]
  podcast test                  run the unit tests

options for sheet, video, preview and build
  --format vertical|square|landscape   picture shape (default: "video.format" in episode.json, else vertical)
  --style bars|wave                    how the sound is drawn (default: "video.style", else bars)
  --size 1080                          short side in pixels (720 makes a small web copy)
  --no-captions                        leave the word-by-word captions out of the picture
  --workers 2                          browser pages drawing frames at once (default 2)
  --crf 20                             video quality, lower is better (default 20; about 28 for a small web copy)
  --at 12 --seconds 5 --width 480      preview: where it starts, how long it is, how wide
`

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })
const say = (m) => process.stdout.write(m + '\n')
const note = (m) => process.stderr.write(m + '\n')
const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1
const VOICES = readJson(join(ENGINE, 'voices.json'), 'voices.json').voices

function open(rest) {
  const P = projectDir(rest[0])
  return { P, ep: loadEpisode(P), raw: readJson(join(P, 'episode.json'), 'episode.json') }
}
const lint = (P, raw) => lintEpisode(raw, { voices: VOICES, exists: (f) => existsSync(resolve(P, f)), dir: P })
function mustLint(P, raw) {
  const errors = lint(P, raw).filter((i) => i.level === 'error')
  if (errors.length) throw new Error(`the script has errors. Fix them first:\n${formatIssues(errors)}`)
}
function videoOptions(ep, flags) {
  const format = flags.format || ep.video.format, style = flags.style || ep.video.style
  if (!FORMATS.includes(format)) throw new Error(`--format must be one of ${FORMATS.join(', ')}`)
  if (!STYLES.includes(style)) throw new Error(`--style must be one of ${STYLES.join(', ')}`)
  return { format, style, captions: flags.captions === false ? false : ep.video.captions !== false, size: numFlag(flags, 'size', 1080, 240, 2160),
    workers: numFlag(flags, 'workers', 2, 1, 8), crf: numFlag(flags, 'crf', 20, 0, 51), quality: numFlag(flags, 'quality', 0.92, 0.3, 1) }
}

async function checkBrowser() {
  const { chromium, from } = findPlaywright(), cands = browserCandidates(chromium)
  say(`ok   playwright (${from})`)
  for (const c of cands) say(`${c.present ? 'ok  ' : 'none'} browser: ${c.label}`)
  const { browser, label } = await launchBrowser({ chromium, from, attempts: 2, log: note })
  await browser.close()
  say(`ok   browser starts: ${label}`)
  const own = cands.find((c) => c.label.startsWith("Playwright's own"))
  if (own && !own.present) say(`note Playwright's own Chromium is not installed, so there is no fallback if the browser above fails to start. To add it: ${installHint(from)}`)
}

/** the ffmpeg in use must have the encoders and filters the pipeline calls */
async function checkFfmpeg() {
  const FF = findFF(), need = { encoders: ['libmp3lame', 'aac', 'libx264'], filters: ['ebur128', 'alimiter', 'aresample'] }
  const missing = []
  for (const [kind, names] of Object.entries(need)) {
    const { out } = await ffmpeg(FF, [`-${kind}`])
    for (const n of names) if (!new RegExp(`\\s${n}\\s`).test(out)) missing.push(`${kind.slice(0, -1)} ${n}`)
  }
  if (missing.length) throw new Error(`this ffmpeg (${FF}) lacks: ${missing.join(', ')}. Install a full build of ffmpeg, or pip install imageio-ffmpeg in the Kokoro venv.`)
  say(`ok   ffmpeg has ${[...need.encoders, ...need.filters].join(', ')}`)
  const rs = await resamplerOf(FF)
  say(rs === 'soxr' ? 'ok   ffmpeg has the soxr resampler' : "note ffmpeg has no soxr resampler; its own (swr) is used instead, which is fine")
}

async function runTests() {
  const dir = join(SKILL, 'tests')
  const js = sh(process.execPath, ['--test', ...readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f))])
  const py = sh(findPython(), [join(dir, 'run_py_tests.py')])
  process.exit(js || py)
}

const COMMANDS = {
  help: async () => say(HELP),
  check: async () => process.exit(sh('bash', [join(SKILL, 'check_env.sh')])),
  'check-browser': checkBrowser,
  'check-ffmpeg': checkFfmpeg,
  test: runTests,

  async new({ rest }) {
    if (!rest[0]) throw new Error('usage: podcast new <dir>')
    const D = resolve(rest[0]), file = join(D, 'episode.json')
    mkdirSync(D, { recursive: true })
    if (existsSync(file)) say(`kept the episode.json that is already in ${D}`)
    else copyFileSync(join(SKILL, 'templates', 'episode.json'), file)
    say(`project ready: ${D}\nnext: write the script in ${file}, then\n  podcast lint ${rest[0]} && podcast build ${rest[0]}`)
  },
  async lint({ rest, flags }) {
    const { P, raw } = open(rest), issues = lint(P, raw)
    say(flags.json ? JSON.stringify(issues, null, 1) : formatIssues(issues))
    if (issues.some((i) => i.level === 'error') || (flags.strict && issues.some((i) => i.level === 'warn'))) process.exit(1)
  },
  async audio({ rest, flags }) {
    const { P, ep, raw } = open(rest); mustLint(P, raw)
    const r = await makeAudio(P, ep, { log: say, dryRun: !!flags['dry-run'] })
    if (flags['dry-run']) { for (const t of r.plan.record) say(`  would record (${t.voice}, speed ${t.speed}): ${t.text}`); return }
    say(formatReport(r.report))
    for (const f of [...writeCaptions(P, r.timeline), ...writeChapterFiles(P, r.timeline), ...writeNotes(P, ep, r.timeline)]) say(f)
  },
  async verify({ rest }) {
    const { P, ep } = open(rest), r = await verify(P, ep)
    say(`${r.file}\n${formatChecks(r.checks)}\nnot checked: how natural the voices and the conversation sound. Listen before you publish.`)
    if (r.checks.some((c) => !c.ok)) process.exit(1)
  },
  async phonemes({ rest }) {
    const { P, ep } = open(rest), lang = ep.lang || 'en-us'
    const items = rest.length > 1 ? rest.slice(1).map((text) => ({ text, lang })) : flaggedWords(ep).flatMap((f) => [{ text: f.word, lang, what: `${f.word} (${f.reason}, turn ${f.turn})` },
      ...(f.spoken !== f.word ? [{ text: f.spoken, lang, what: `  said as "${f.spoken}"` }] : [])])
    if (!items.length) { say('no flagged words in the script. To see any text: podcast phonemes <project> "some words"'); return }
    for (const r of phonemes(P, items)) say(`${(r.what || r.text).padEnd(44)} /${r.ipa}/`)
  },
  async captions({ rest }) { const { P, ep } = open(rest); for (const f of writeCaptions(P, loadTimeline(P, ep))) say(f) },
  async notes({ rest }) { const { P, ep } = open(rest); for (const f of writeNotes(P, ep, loadTimeline(P, ep))) say(f) },
  async chapters({ rest }) {
    const { P, ep } = open(rest), timeline = loadTimeline(P, ep)
    for (const f of await encode(P, ep, timeline)) say(`${f.file}  ${f.chapters} chapter(s) read back from the file`)
    for (const f of writeChapterFiles(P, timeline)) say(f)
  },
  async sheet({ rest, flags }) {
    const { P, ep } = open(rest), r = await renderSheet({ P, ep, timeline: loadTimeline(P, ep), opts: videoOptions(ep, flags), log: note })
    say(r.out); say('frames: ' + r.legend)
    say(r.issues.length ? 'layout: ' + r.issues.join('\nlayout: ') : 'layout: nothing shrunk or cut')
  },
  async video({ rest, flags }) {
    const { P, ep } = open(rest), timeline = loadTimeline(P, ep)
    const r = await renderVideo({ P, ep, timeline, opts: videoOptions(ep, flags), log: note })
    say(`${r.out} (${timeline.total.toFixed(1)} s, ${r.size.W}x${r.size.H}, ${r.frames} frames, ${r.seconds.toFixed(0)} s to render with ${r.workers} page(s))`)
    for (const m of r.issues) say('layout: ' + m)
  },
  async preview({ rest, flags }) {
    const { P, ep } = open(rest)
    const r = await renderPreview({ P, opts: videoOptions(ep, flags), gif: !!flags.gif, at: numFlag(flags, 'at', 6, 0, 1e6), seconds: numFlag(flags, 'seconds', 5, 1, 30), width: numFlag(flags, 'width', 480, 120, 1080), fps: numFlag(flags, 'fps', 12, 2, 30) })
    say(`${r.out} (${Math.round(r.bytes / 1000)} kB)`)
  },
  async clean({ rest, flags }) {
    const { P, ep } = open(rest)
    if (flags.all) { rmSync(join(P, 'build'), { recursive: true, force: true }); say(`removed ${join(P, 'build')}`); return }
    say(`removed ${cleanTakes(P, ep)} unused recording(s) from ${join(P, 'build', 'takes')}`)
  },
  async build({ rest, flags }) {
    const { P, ep, raw } = open(rest), issues = lint(P, raw)
    say(formatIssues(issues))
    if (issues.some((i) => i.level === 'error')) process.exit(1)
    const r = await makeAudio(P, ep, { log: say })
    say(formatReport(r.report))
    const v = await verify(P, ep); say(formatChecks(v.checks))
    for (const f of [...writeCaptions(P, r.timeline), ...writeChapterFiles(P, r.timeline), ...writeNotes(P, ep, r.timeline)]) say(f)
    if (v.checks.some((c) => !c.ok)) throw new Error('the audio did not pass its checks; the video was not made')
    if (flags.video === false) return
    const opts = videoOptions(ep, flags)
    const s = await renderSheet({ P, ep, timeline: r.timeline, opts, log: note }); say(s.out)
    for (const m of s.issues) say('layout: ' + m)
    const out = await renderVideo({ P, ep, timeline: r.timeline, opts, log: note })
    say(`${out.out} (${out.size.W}x${out.size.H}, ${out.seconds.toFixed(0)} s to render)`)
    say('not checked: how natural it sounds, and whether the picture reads well. Listen, and look at the sheet.')
  },
}

const [command = 'help', ...argv] = process.argv.slice(2)
try {
  const run = COMMANDS[command.replace(/^--?/, '')]
  if (!run) throw new Error(`unknown command "${command}". Run "podcast help".`)
  await run(parseArgs(argv))
} catch (e) {
  note('podcast: ' + (e && e.message || e))
  process.exit(1)
}
