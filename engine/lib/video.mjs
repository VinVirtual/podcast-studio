// The audiogram: review sheet, video and the short looping preview.
// Frames are drawn in headless Chrome (engine/audiogram.js) and piped to ffmpeg.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENGINE, SKILL, findFF, launchBrowser } from './env.mjs'
import { cues } from './captions.mjs'
import { projectFile } from './episode.mjs'
import { ffmpeg, vizData, paths } from './audio.mjs'

const FONTS = { display: 'Fraunces-Italic.ttf', body: 'Geist.ttf' }
// BT.709 in limited range, tagged, so browsers and phones show the colours as drawn
const COLOUR = 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+bicubic,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'

/** the project's own font file (fonts/<name>) if present, else the bundled one */
function fontUrl(P, name) {
  for (const f of [join(P, 'fonts', name), join(SKILL, 'assets', 'fonts', name)]) if (existsSync(f)) return pathToFileURL(f).href
  return null
}

/** what window.setup() takes in the page */
export function setupArgs({ P, ep, timeline, opts, viz }) {
  const file = ep.cover.image ? projectFile(P, ep.cover.image, 'cover.image') : null
  const image = file && existsSync(file) ? pathToFileURL(file).href : null
  return { episode: { show: ep.show, title: ep.title, episode: ep.episode, cover: ep.cover }, timeline, cues: cues(timeline), viz,
    opts: { format: opts.format, style: opts.style, captions: opts.captions, size: opts.size }, fonts: { display: fontUrl(P, FONTS.display), body: fontUrl(P, FONTS.body) }, image }
}

/** open `pages` pages with the audiogram loaded. Returns { pages, size, issues, close }. */
export async function openStage({ P, ep, timeline, opts, pages = 1, log = () => {} }) {
  const viz = vizData(P, timeline.fps || 30)
  const { browser } = await launchBrowser({ log })
  try {
    const args = setupArgs({ P, ep, timeline, opts, viz }), list = [], said = new Set()
    const once = (m) => { if (!said.has(m)) { said.add(m); log(m) } }
    let size = null
    for (let i = 0; i < pages; i++) {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
      page.on('pageerror', (e) => once('pageerror ' + e.message))
      page.on('console', (m) => m.type() === 'error' && once('console ' + m.text()))
      await page.goto(pathToFileURL(join(ENGINE, 'render.html')).href)
      size = await page.evaluate((a) => window.setup(a), args)
      list.push(page)
    }
    return { pages: list, size, issues: size.issues, close: () => browser.close().catch(() => {}) }
  } catch (e) { await browser.close().catch(() => {}); throw e }
}

export async function grab(page, t, type = 'png', quality = 0.92) {
  const b64 = await page.evaluate(({ t, type, quality }) => { window.renderAt(t); return document.getElementById('c').toDataURL('image/' + type, quality).split(',')[1] }, { t, type, quality })
  return Buffer.from(b64, 'base64')
}

/** Moments worth looking at: the intro, a point inside the longest caption, one in every chapter, the last turn
    and the outro. At most `max`, in order. */
export function sheetTimes(timeline, max = 9) {
  const q = cues(timeline), longest = q.reduce((a, c) => (c.text.length > (a ? a.text.length : 0) ? c : a), null)
  const picks = [{ t: Math.min(1, timeline.speechStart / 2), what: 'intro' }]
  if (longest) picks.push({ t: longest.words[longest.words.length - 1].t + 0.02, what: 'longest caption' })
  timeline.chapters.forEach((c, i) => { const turn = timeline.turns.find((x) => x.start >= c.start - 0.001 && x.words.length); if (turn) picks.push({ t: turn.words[Math.min(2, turn.words.length - 1)].t + 0.02, what: `chapter ${i + 1}` }) })
  for (const turn of timeline.turns) picks.push({ t: (turn.start + turn.end) / 2, what: turn.id })
  picks.push({ t: Math.max(0, timeline.total - 1.2), what: 'outro' })
  const must = picks.filter((p) => !/^t\d/.test(p.what)), rest = picks.filter((p) => /^t\d/.test(p.what)), room = Math.max(0, max - must.length)
  const spread = rest.filter((_, i) => room && Math.floor(i * room / rest.length) !== Math.floor((i - 1) * room / rest.length))
  return [...must, ...spread].sort((a, b) => a.t - b.t).slice(0, max)
}

/** stills/sheet-<format>.png: several frames tiled into one picture */
export async function renderSheet({ P, ep, timeline, opts, log }) {
  const FF = findFF(), dir = join(P, 'stills'), tmp = join(dir, '.sheet')
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true })
  const stage = await openStage({ P, ep, timeline, opts: { ...opts, size: Math.min(opts.size, 720) }, log })
  try {
    const times = sheetTimes(timeline)
    for (const [i, x] of times.entries()) writeFileSync(join(tmp, `f${String(i).padStart(3, '0')}.png`), await grab(stage.pages[0], x.t))
    const wide = stage.size.W > stage.size.H, tall = stage.size.H > stage.size.W
    const cols = Math.min(wide ? 2 : tall ? 5 : 3, times.length), rows = Math.ceil(times.length / cols), out = join(dir, `sheet-${opts.format}.png`)
    await ffmpeg(FF, ['-framerate', '1', '-i', join(tmp, 'f%03d.png'), '-vf', `scale=${wide ? 800 : tall ? 360 : 540}:-1,tile=${cols}x${rows}:padding=8:color=black`, '-frames:v', '1', '-update', '1', out])
    return { out, issues: stage.issues, legend: times.map((x, i) => `${i + 1}=${x.what}@${x.t.toFixed(1)}s`).join('  ') }
  } finally { await stage.close(); rmSync(tmp, { recursive: true, force: true }) }
}

export const videoPath = (P, opts) => join(paths(P).out, `episode-${opts.format}${opts.size === 1080 ? '' : `-${opts.size}`}.mp4`)

/** Every frame drawn in `workers` pages at once (a frame depends only on t), written to ffmpeg in order. */
export async function renderVideo({ P, ep, timeline, opts, log = () => {} }) {
  const FF = findFF(), p = paths(P); mkdirSync(p.out, { recursive: true })
  if (!existsSync(p.master)) throw new Error(`no mastered audio yet (${p.master}). Run: podcast audio ${P}`)
  const out = videoPath(P, opts), fps = timeline.fps || 30, n = Math.round(timeline.total * fps)
  const stage = await openStage({ P, ep, timeline, opts, pages: Math.min(opts.workers, n), log })
  const t0 = Date.now()
  try {
    const small = opts.size < 1080
    const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-i', p.master,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf), '-vf', COLOUR, '-profile:v', 'high', '-c:a', 'aac', '-b:a', small ? '96k' : '160k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
    let dead = null
    const closed = new Promise((r) => ff.on('close', (code) => { if (code) dead = new Error('ffmpeg exited with code ' + code); r() }))
    ff.on('error', (e) => { dead = new Error(`could not start ffmpeg (${FF}): ${e.message}`) })
    ff.stdin.on('error', (e) => { dead = dead || new Error('ffmpeg stopped reading frames: ' + e.message) })
    // frames arrive out of order from the pages; `next` is the frame ffmpeg is waiting for
    const ready = new Map(); let next = 0, writing = Promise.resolve()
    const flush = async () => {
      while (ready.has(next) && !dead) {
        const buf = ready.get(next); ready.delete(next); next++
        if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), closed])
        if (next % 300 === 0) log(`frame ${next}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      }
    }
    const K = stage.pages.length
    await Promise.all(stage.pages.map(async (page, k) => {
      for (let i = k; i < n; i += K) {
        while (i - next > 48 && !dead) await new Promise((r) => setTimeout(r, 5)) // do not run far ahead of the encoder
        if (dead) return
        ready.set(i, await grab(page, i / fps, 'jpeg', opts.quality)); writing = writing.then(flush)
      }
    }))
    await writing
    ff.stdin.end(); await closed
    if (dead) throw dead
    return { out, seconds: (Date.now() - t0) / 1000, frames: n, workers: K, size: stage.size, issues: stage.issues }
  } finally { await stage.close() }
}

/** a short silent loop cut from the rendered video: animated WebP, or GIF with its own palette */
export async function renderPreview({ P, opts, gif = false, at = 6, seconds = 5, width = 480, fps = 12 }) {
  const FF = findFF(), src = videoPath(P, opts)
  if (!existsSync(src)) throw new Error(`no rendered video (${src}). Render it first: podcast video ${P}`)
  const out = join(paths(P).out, `preview.${gif ? 'gif' : 'webp'}`), base = `fps=${fps},scale=${width}:-2:flags=lanczos`
  const cut = ['-ss', String(at), '-t', String(seconds), '-i', src, '-an']
  if (gif) await ffmpeg(FF, [...cut, '-vf', `${base},split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', out])
  else await ffmpeg(FF, [...cut, '-vf', base, '-c:v', 'libwebp_anim', '-quality', '62', '-compression_level', '6', '-loop', '0', out])
  return { out, bytes: statSync(out).size }
}
