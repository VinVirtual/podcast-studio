// The audiogram: draws one frame of the video for any time t on a canvas.
// A frame depends only on t and the data given to setup(), so frames can be drawn in any order and in
// several pages at once. Runs in a browser page (render.html); no modules, no network.
/* global document, FontFace, Image, atob */
(function () {
  'use strict'

  // base canvas in design units; the short side is always 1080 and --size scales the whole picture
  const SIZES = { vertical: [1080, 1920], square: [1080, 1080], landscape: [1920, 1080] }
  const LAYOUTS = {
    vertical: {
      top: { x: 72, y: 150, w: 936 },
      cover: { x: 72, y: 210, w: 922, h: 660 },
      speakers: { x: 72, y: 944, w: 936, mode: 'row' },
      sound: { x: 72, y: 1060, w: 936, h: 230 },
      captions: { x: 72, y: 1340, w: 936, h: 250, size: 56, lines: 3, align: 'left' },
      progress: { x: 72, y: 1668, w: 936 },
    },
    square: {
      top: { x: 560, y: 108, w: 456, counter: false },
      cover: { x: 64, y: 64, w: 440, h: 470 },
      speakers: { x: 560, y: 170, w: 456, mode: 'stack' },
      sound: { x: 64, y: 572, w: 952, h: 140 },
      captions: { x: 64, y: 742, w: 952, h: 170, size: 46, lines: 2, align: 'left' },
      progress: { x: 64, y: 1008, w: 952 },
    },
    landscape: {
      top: { x: 800, y: 124, w: 1040 },
      cover: { x: 80, y: 80, w: 620, h: 900 },
      speakers: { x: 800, y: 176, w: 1040, mode: 'row' },
      sound: { x: 800, y: 320, w: 1040, h: 250 },
      captions: { x: 800, y: 630, w: 1040, h: 230, size: 54, lines: 3, align: 'left' },
      progress: { x: 800, y: 968, w: 1040 },
    },
  }
  const BAR_DECAY = 0.7, BAR_TRAIL = 5, WAVE_SPAN = 3.2

  let S = null // everything setup() prepared

  // ---------------------------------------------------------------- small helpers
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x))
  const ease = (x) => { const k = clamp(x); return k * k * (3 - 2 * k) }
  const hex = (c) => { const h = String(c).replace('#', ''); const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) }
  const rgb = (c, a = 1) => { const [r, g, b] = Array.isArray(c) ? c : hex(c); return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})` }
  const mix = (a, b, k) => { const x = Array.isArray(a) ? a : hex(a), y = Array.isArray(b) ? b : hex(b); return x.map((v, i) => v + (y[i] - v) * k) }
  const bytes = (b64) => { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out }
  const clock = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const font = (ctx, family, px, weight = 400, style = 'normal') => { ctx.font = `${style} ${weight} ${px}px "${family}", system-ui, sans-serif` }

  function roundRect(ctx, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2)
    ctx.beginPath(); ctx.moveTo(x + k, y); ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k); ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath()
  }
  function spaced(ctx, text, x, y, gap) { // text with letter spacing, left aligned
    let at = x
    for (const ch of text) { ctx.fillText(ch, at, y); at += ctx.measureText(ch).width + gap }
    return at - x
  }
  const spacedWidth = (ctx, text, gap) => [...text].reduce((n, ch) => n + ctx.measureText(ch).width + gap, 0)

  /** wrap words into lines no wider than w: [[{ text, x, width, i }]] */
  function wrap(ctx, words, w) {
    const space = ctx.measureText(' ').width, lines = [[]]
    let x = 0
    words.forEach((text, i) => {
      const width = ctx.measureText(text).width
      if (x > 0 && x + width > w) { lines.push([]); x = 0 }
      lines[lines.length - 1].push({ text, x, width, i }); x += width + space
    })
    return lines
  }
  /** the largest size from `max` down to `min` at which the text fits in `lines` lines of width w */
  function fit(ctx, family, weight, style, words, w, lines, max, min) {
    for (let px = max; px >= min; px -= 2) { font(ctx, family, px, weight, style); const l = wrap(ctx, words, w); if (l.length <= lines && l.every((ln) => ln.every((q) => q.width <= w))) return { px, lines: l, ok: true } }
    font(ctx, family, min, weight, style)
    return { px: min, lines: wrap(ctx, words, w), ok: false }
  }
  function ellipsis(ctx, text, w) {
    if (ctx.measureText(text).width <= w) return { text, cut: false }
    let t = text
    while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1)
    return { text: t.trimEnd() + '…', cut: true }
  }

  // ---------------------------------------------------------------- data lookups (all pure functions of t)
  const turnAt = (t) => S.timeline.turns.find((x) => t >= x.start && t < x.end) || null
  /** 0..1: how strongly a speaker is "on" at t. Rises quickly when their turn starts, falls after it ends. */
  function activity(id, t) {
    let a = 0
    for (const x of S.timeline.turns) if (x.speaker === id && t >= x.start - 0.05 && t < x.end + 0.3) a = Math.max(a, Math.min(ease((t - x.start + 0.05) / 0.2), 1 - ease((t - x.end) / 0.3)))
    return a
  }
  /** the colour of whoever speaks at t, fading to the accent when nobody does */
  function voiceColour(t) {
    let c = hex(S.c.accent), total = 0
    const parts = Object.keys(S.timeline.speakers).map((id) => [activity(id, t), hex(S.timeline.speakers[id].color)])
    for (const [a] of parts) total += a
    if (total > 0) { c = [0, 0, 0]; for (const [a, col] of parts) c = c.map((v, i) => v + col[i] * (a / total)) }
    return mix(S.c.accent, c, clamp(total))
  }
  const frameOf = (t) => clamp(Math.round(t * S.viz.fps), 0, S.viz.frames - 1)
  function band(t, b) {
    const f = frameOf(t); let v = 0
    for (let j = 0; j < BAR_TRAIL && f - j >= 0; j++) v = Math.max(v, S.spectrum[(f - j) * S.viz.bands + b] / 255 * BAR_DECAY ** j)
    return v
  }
  function level(t) {
    const f = frameOf(t); let v = 0
    for (let j = 0; j < 4 && f - j >= 0; j++) v = Math.max(v, S.level[f - j] / 255 * 0.75 ** j)
    return v
  }
  const cueAt = (t) => S.cues.find((c) => t >= c.start && t < c.end) || null
  const chapterAt = (t) => { const i = S.timeline.chapters.findIndex((c) => t < c.end); return i < 0 ? S.timeline.chapters.length - 1 : i }

  // ---------------------------------------------------------------- parts of the picture
  function background(ctx) {
    const { W, H } = S
    ctx.fillStyle = S.c.background; ctx.fillRect(0, 0, W, H)
    const g = ctx.createRadialGradient(W * 0.15, H * 0.05, 0, W * 0.15, H * 0.05, Math.max(W, H) * 0.9)
    g.addColorStop(0, rgb(mix(S.c.background, S.c.ink, 0.13))); g.addColorStop(1, rgb(mix(S.c.background, '#000000', 0.28)))
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  }

  function cover(ctx, t) {
    const r = S.L.cover, lv = level(t), off = 16
    ctx.save()
    // the block behind the card takes the colour of the voice: the card seems to be lit by whoever speaks
    ctx.fillStyle = rgb(voiceColour(t)); roundRect(ctx, r.x + off, r.y + off, r.w, r.h, 30); ctx.fill()
    roundRect(ctx, r.x, r.y, r.w, r.h, 30); ctx.fillStyle = S.c.ink; ctx.fill(); ctx.clip()
    const pad = Math.round(Math.min(r.w, r.h) * 0.085)
    if (S.image) {
      const k = Math.max(r.w / S.image.width, r.h / S.image.height), iw = S.image.width * k, ih = S.image.height * k
      ctx.drawImage(S.image, r.x + (r.w - iw) / 2, r.y + (r.h - ih) / 2, iw, ih)
      const g = ctx.createLinearGradient(0, r.y + r.h * 0.3, 0, r.y + r.h)
      g.addColorStop(0, rgb(S.c.background, 0)); g.addColorStop(1, rgb(S.c.background, 0.92)); ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h)
    } else {
      // sound rings from the lower right corner; they swell a little with the level of the audio
      const cx = r.x + r.w * 0.94, cy = r.y + r.h * 0.98, base = S.cover.rings
      for (let i = 5; i >= 0; i--) {
        ctx.beginPath(); ctx.arc(cx, cy, base * (0.22 + i * 0.156) * (1 + lv * 0.03 * (i + 1) / 3), 0, Math.PI * 2)
        ctx.fillStyle = i % 2 ? rgb(mix(S.c.ink, S.c.accent, 0.9)) : rgb(mix(S.c.ink, S.c.background, i === 0 ? 1 : 0.07 + i * 0.012)); ctx.fill()
      }
    }
    const ink = S.image ? S.c.ink : S.c.background
    ctx.fillStyle = rgb(ink, 0.72); ctx.textBaseline = 'alphabetic'
    font(ctx, S.fonts.body, S.cover.label, 600); spaced(ctx, S.cover.kicker, r.x + pad, r.y + pad + S.cover.label * 0.8, S.cover.label * 0.14)
    ctx.fillStyle = ink; font(ctx, S.fonts.display, S.cover.title.px, 500, 'italic')
    const lh = S.cover.title.px * 1.06, y0 = S.image ? r.y + r.h - pad - (S.cover.title.lines.length - 1) * lh : r.y + pad + S.cover.label * 0.8 + S.cover.title.px * 1.25
    S.cover.title.lines.forEach((ln, i) => ctx.fillText(ln.map((q) => q.text).join(' '), r.x + pad, y0 + i * lh))
    ctx.restore()
  }

  function topLine(ctx, t) {
    const r = S.L.top, ci = chapterAt(t)
    ctx.textBaseline = 'alphabetic'; font(ctx, S.fonts.body, 26, 600)
    ctx.fillStyle = rgb(S.c.ink, 0.6); spaced(ctx, S.showLabel, r.x, r.y, 3.6)
    if (r.counter === false) return
    const right = `${String(ci + 1).padStart(2, '0')} / ${String(S.timeline.chapters.length).padStart(2, '0')}`
    ctx.fillStyle = rgb(S.c.accent); spaced(ctx, right, r.x + r.w - spacedWidth(ctx, right, 3.6) + 3.6, r.y, 3.6)
  }

  function speakers(ctx, t) {
    const r = S.L.speakers, ids = Object.keys(S.timeline.speakers)
    ctx.textBaseline = 'alphabetic'
    if (r.mode === 'stack') {
      const rowH = S.stack.rowH
      ids.forEach((id, i) => {
        const sp = S.timeline.speakers[id], a = activity(id, t), y = r.y + i * rowH
        ctx.fillStyle = rgb(sp.color, 0.12 + 0.88 * a); roundRect(ctx, r.x, y + 14, 10, rowH - 28, 5); ctx.fill()
        const shift = 30 + 10 * a
        ctx.fillStyle = rgb(mix(S.c.ink, sp.color, a * 0.0), 0.42 + 0.58 * a); font(ctx, S.fonts.display, S.stack.name, 500, 'italic'); ctx.fillText(sp.name, r.x + shift, y + rowH * 0.5 + S.stack.name * 0.12)
        if (sp.role) { ctx.fillStyle = rgb(a > 0.5 ? sp.color : S.c.ink, 0.45 + 0.5 * a); font(ctx, S.fonts.body, 24, 600); spaced(ctx, sp.role.toUpperCase(), r.x + shift + 2, y + rowH * 0.5 + S.stack.name * 0.12 + 38, 3) }
      })
      return
    }
    let x = r.x
    ids.forEach((id) => {
      const sp = S.timeline.speakers[id], a = activity(id, t), chip = S.chips[id], h = 72
      roundRect(ctx, x, r.y, chip.w, h, h / 2)
      ctx.fillStyle = rgb(sp.color, a); ctx.fill()
      ctx.lineWidth = 2.5; ctx.strokeStyle = rgb(mix(S.c.ink, sp.color, a), 0.3 + 0.7 * a); ctx.stroke()
      ctx.beginPath(); ctx.arc(x + 36, r.y + h / 2, 9 + 3 * a * level(t), 0, Math.PI * 2); ctx.fillStyle = rgb(mix(sp.color, S.c.background, a)); ctx.fill()
      ctx.fillStyle = rgb(mix(S.c.ink, S.c.background, a), 0.55 + 0.45 * a); font(ctx, S.fonts.body, 34, 600); ctx.fillText(sp.name, x + 60, r.y + h / 2 + 12)
      if (sp.role) { ctx.fillStyle = rgb(mix(S.c.ink, S.c.background, a), 0.4 + 0.35 * a); font(ctx, S.fonts.body, 24, 500); ctx.fillText(sp.role, x + 60 + chip.name + 14, r.y + h / 2 + 10) }
      x += chip.w + 18
    })
  }

  function bars(ctx, t) {
    const r = S.L.sound, n = S.viz.bands, gap = Math.max(5, r.w / n * 0.36), bw = (r.w - gap * (n - 1)) / n, mid = r.y + r.h / 2, col = voiceColour(t)
    for (let b = 0; b < n; b++) {
      const v = (band(t, b) * 2 + (b > 0 ? band(t, b - 1) : 0) + (b < n - 1 ? band(t, b + 1) : 0)) / (b > 0 && b < n - 1 ? 4 : 3)
      const h = Math.max(bw, v * r.h), x = r.x + b * (bw + gap)
      ctx.fillStyle = rgb(mix(S.c.ink, col, 0.25 + 0.75 * clamp(v * 1.6)), 0.3 + 0.7 * clamp(v * 2.2))
      roundRect(ctx, x, mid - h / 2, bw, h, bw / 2); ctx.fill()
    }
  }

  function wave(ctx, t) {
    const r = S.L.sound, n = 120, step = r.w / n, bw = step * 0.56, mid = r.y + r.h / 2
    for (let i = 0; i < n; i++) {
      const at = t + ((i + 0.5) / n - 0.5) * 2 * WAVE_SPAN
      if (at < 0 || at > S.timeline.total) continue
      const q = Math.round(at * 15) / 15 // the bars stand still against the sound and scroll with it
      const v = S.level[frameOf(q)] / 255, h = Math.max(bw, v * r.h * 0.95), past = at <= t
      ctx.fillStyle = past ? rgb(voiceColour(q), 0.95) : rgb(S.c.ink, 0.26)
      roundRect(ctx, r.x + i * step + (step - bw) / 2, mid - h / 2, bw, h, bw / 2); ctx.fill()
    }
    ctx.fillStyle = rgb(S.c.ink); roundRect(ctx, r.x + r.w / 2 - 2, r.y - 6, 4, r.h + 12, 2); ctx.fill()
  }

  function captions(ctx, t) {
    const cue = cueAt(t); if (!cue) return
    const r = S.L.captions, lay = cue.layout, sp = S.timeline.speakers[cue.speaker] || { color: S.c.accent }
    ctx.textBaseline = 'alphabetic'
    font(ctx, S.fonts.body, 24, 700); ctx.fillStyle = rgb(sp.color); spaced(ctx, cue.name.toUpperCase(), r.x, r.y + 22, 3.4)
    font(ctx, S.fonts.body, lay.px, 600)
    const lh = lay.px * 1.24, top = r.y + 44 + lay.px
    lay.lines.forEach((ln, li) => ln.forEach((q) => {
      const w = cue.words[q.i], x = r.x + q.x, y = top + li * lh
      const now = t >= w.t && t < w.e, said = t >= w.e
      if (now) { ctx.fillStyle = rgb(sp.color); roundRect(ctx, x - lay.px * 0.16, y - lay.px * 0.9, q.width + lay.px * 0.32, lay.px * 1.2, lay.px * 0.22); ctx.fill() }
      ctx.fillStyle = now ? S.c.background : rgb(S.c.ink, said ? 1 : 0.4)
      ctx.fillText(q.text, x, y)
    }))
  }

  function progress(ctx, t) {
    const r = S.L.progress, total = S.timeline.total, ci = chapterAt(t), ch = S.timeline.chapters[ci], k = clamp(t / total)
    ctx.textBaseline = 'alphabetic'
    const since = t - (ci === 0 ? 0 : ch.start), appear = ci === 0 ? 1 : ease(since / 0.35)
    font(ctx, S.fonts.display, 40, 500, 'italic'); ctx.fillStyle = rgb(S.c.ink, 0.92 * appear)
    ctx.fillText(S.chapterTitles[ci], r.x + (1 - appear) * 14, r.y - 26)
    font(ctx, S.fonts.body, 26, 500); ctx.fillStyle = rgb(S.c.ink, 0.6)
    const time = `${clock(t)} / ${clock(total)}`; ctx.fillText(time, r.x + r.w - ctx.measureText(time).width, r.y - 26)
    ctx.fillStyle = rgb(S.c.ink, 0.18); roundRect(ctx, r.x, r.y, r.w, 6, 3); ctx.fill()
    ctx.fillStyle = S.c.accent; roundRect(ctx, r.x, r.y, Math.max(6, r.w * k), 6, 3); ctx.fill()
    S.timeline.chapters.forEach((c, i) => { if (i) { ctx.fillStyle = S.c.background; ctx.fillRect(r.x + r.w * c.start / total - 2, r.y - 2, 4, 10) } })
    ctx.beginPath(); ctx.arc(r.x + r.w * k, r.y + 3, 9, 0, Math.PI * 2); ctx.fillStyle = S.c.ink; ctx.fill()
  }

  // ---------------------------------------------------------------- setup and the frame
  async function loadFont(family, url, style) {
    if (!url) return
    const face = new FontFace(family, `url("${url}")`, { style, weight: '100 900' })
    document.fonts.add(await face.load())
  }
  const loadImage = (url) => new Promise((done) => { const im = new Image(); im.onload = () => done(im); im.onerror = () => done(null); im.src = url })

  /** args: { episode, timeline, cues, viz, opts: { format, style, captions, size }, fonts: { display, body }, image } */
  window.setup = async function (args) {
    const { episode, timeline, opts } = args, [W, H] = SIZES[opts.format], scale = opts.size / 1080, issues = []
    const canvas = document.getElementById('c'); canvas.width = Math.round(W * scale / 2) * 2; canvas.height = Math.round(H * scale / 2) * 2
    const ctx = canvas.getContext('2d')
    await loadFont('PodDisplay', args.fonts.display, 'italic'); await loadFont('PodBody', args.fonts.body, 'normal')
    const fonts = { display: args.fonts.display ? 'PodDisplay' : 'Georgia', body: args.fonts.body ? 'PodBody' : 'system-ui' }
    const L = LAYOUTS[opts.format], c = episode.cover
    const image = args.image ? await loadImage(args.image) : null
    if (args.image && !image) issues.push('the cover image could not be loaded; the drawn cover is used')

    // cover: kicker and title fitted to the card
    const pad = Math.round(Math.min(L.cover.w, L.cover.h) * 0.085), label = opts.format === 'square' ? 20 : 26
    const kicker = (Number.isFinite(episode.episode) ? `EPISODE ${episode.episode}` : 'EPISODE').toUpperCase()
    const maxTitle = opts.format === 'square' ? 76 : opts.format === 'landscape' ? 104 : 118
    const title = fit(ctx, fonts.display, 500, 'italic', String(episode.title || '').split(/\s+/).filter(Boolean), L.cover.w - pad * 2 - (image ? 0 : L.cover.w * 0.06), opts.format === 'vertical' ? 3 : 4, maxTitle, 38)
    if (!title.ok) issues.push(`the title does not fit on the cover even at the smallest size: shorten "${episode.title}"`)

    // the rings stay under the title: their outer edge stops below its last line
    const titleBottom = L.cover.y + pad + label * 0.8 + title.px * 1.25 + (title.lines.length - 1) * title.px * 1.06 + title.px * 0.3
    const rings = clamp(L.cover.y + L.cover.h * 0.98 - titleBottom - 12, Math.min(L.cover.w, L.cover.h) * 0.3, Math.min(L.cover.w, L.cover.h) * 0.68)

    font(ctx, fonts.body, 26, 600)
    const show = ellipsis(ctx, String(episode.show || '').toUpperCase(), (L.top.w - (L.top.counter === false ? 0 : 170)) / 1.16)
    if (show.cut) issues.push(`the show name is cut off: "${episode.show}"`)

    const chips = {}, ids = Object.keys(timeline.speakers); let rowW = 0
    for (const id of ids) {
      const sp = timeline.speakers[id]
      font(ctx, fonts.body, 34, 600); const name = ctx.measureText(sp.name).width
      font(ctx, fonts.body, 24, 500); const role = sp.role ? ctx.measureText(sp.role).width + 14 : 0
      chips[id] = { name, w: 60 + name + role + 34 }; rowW += chips[id].w + 18
    }
    const stack = { rowH: Math.min(170, (L.sound.y - L.speakers.y - 20) / Math.max(1, ids.length)), name: 0 }
    stack.name = Math.min(76, stack.rowH * 0.46)
    if (L.speakers.mode === 'row' && rowW - 18 > L.speakers.w) issues.push('the speaker names and roles do not fit in one row: shorten the roles or use fewer speakers')
    if (L.speakers.mode === 'stack') {
      if (stack.rowH < 84) issues.push('too many speakers for the square format: use vertical or landscape')
      font(ctx, fonts.display, stack.name, 500, 'italic')
      for (const id of ids) if (ctx.measureText(timeline.speakers[id].name).width > L.speakers.w - 50) issues.push(`the speaker name "${timeline.speakers[id].name}" is too wide`)
    }

    font(ctx, fonts.display, 40, 500, 'italic')
    const chapterTitles = timeline.chapters.map((ch) => { const e = ellipsis(ctx, ch.title, L.progress.w - 240); if (e.cut) issues.push(`the chapter title is cut off: "${ch.title}"`); return e.text })

    const cues = args.cues.map((cue) => {
      const lay = fit(ctx, fonts.body, 600, 'normal', cue.words.map((w) => w.w), L.captions.w, L.captions.lines, L.captions.size, Math.round(L.captions.size * 0.72))
      if (!lay.ok) issues.push(`caption at ${cue.start.toFixed(1)} s does not fit in ${L.captions.lines} lines: "${cue.text}"`)
      return { ...cue, layout: lay }
    })

    S = { W, H, scale, canvas, ctx, L, c, fonts, image, episode, timeline, opts, viz: args.viz, spectrum: bytes(args.viz.spectrum), level: bytes(args.viz.level),
      cover: { kicker, label, title, rings }, showLabel: show.text, chips, stack, chapterTitles, cues }
    return { W: canvas.width, H: canvas.height, issues }
  }

  window.renderAt = function (t) {
    const { ctx } = S
    ctx.setTransform(S.canvas.width / S.W, 0, 0, S.canvas.height / S.H, 0, 0)
    background(ctx)
    cover(ctx, t); topLine(ctx, t); speakers(ctx, t)
    if (S.opts.style === 'wave') wave(ctx, t); else bars(ctx, t)
    if (S.opts.captions !== false) captions(ctx, t)
    progress(ctx, t)
  }
})()
