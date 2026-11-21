// Loudness: reading ffmpeg's EBU R128 measurement and working out the gain. Pure.

/** The summary that `ffmpeg -af ebur128=peak=true -f null -` prints at the end:
    { lufs, lra, peak } with the integrated loudness in LUFS, loudness range in LU and true peak in dBFS. */
export function parseEbur128(stderr) {
  const tail = String(stderr).split('Summary:').pop()
  const pick = (re) => { const m = tail.match(re); return m ? Number(m[1]) : NaN }
  const r = { lufs: pick(/\bI:\s+(-?[\d.]+|-?inf)\s+LUFS/), lra: pick(/LRA:\s+(-?[\d.]+)\s+LU/), peak: pick(/Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/) }
  if (!Number.isFinite(r.lufs)) throw new Error('could not read a loudness measurement from ffmpeg (is the audio silent?)')
  return r
}

export const dbToLinear = (db) => 10 ** (db / 20)
export const linearToDb = (x) => 20 * Math.log10(x)

/** Gain in dB that moves `measured` LUFS to `target` LUFS, and by how much the loudest peak would
    then pass the ceiling (0 when it stays under). Peaks over the ceiling are held by a limiter. */
export function gainPlan({ lufs, peak }, target, ceiling = -1.5) {
  const gain = Math.round((target - lufs) * 100) / 100
  const over = Number.isFinite(peak) ? Math.max(0, Math.round((peak + gain - ceiling) * 100) / 100) : 0
  return { gain, over, limited: over > 0 }
}

/** After a pass that came out at `measured`, the gain to use next (a limiter takes a little loudness away). */
export const refineGain = (gain, measured, target) => Math.round((gain + (target - measured)) * 100) / 100

export const withinTolerance = (measured, target, tolerance = 0.5) => Math.abs(measured - target) <= tolerance + 1e-9

export const OVERSAMPLE = 4  // the limiter works at 4x the sample rate, so it also catches peaks between samples

/** The ffmpeg filter chain for one pass: resample, gain, and a look-ahead limiter at the ceiling.
    The limiter runs on 4x oversampled audio, so the true peak (between samples) stays near the ceiling too.
    `resampler` is 'soxr' when ffmpeg has it, else 'swr' (ffmpeg's own). */
export function normaliseFilter({ gain, ceiling = -1.5, sampleRate = 44100, channels = 2, limit = true, resampler = 'soxr' }) {
  const rs = `resampler=${resampler}`
  const chain = [`aresample=${sampleRate}:${rs}`, `aformat=channel_layouts=${channels === 1 ? 'mono' : 'stereo'}`]
  if (limit) chain.push(`aresample=${sampleRate * OVERSAMPLE}:${rs}`)
  chain.push(`volume=${gain.toFixed(2)}dB`)
  if (limit) chain.push(`alimiter=limit=${dbToLinear(ceiling).toFixed(4)}:attack=4:release=60:level=false:latency=true`, `aresample=${sampleRate}:${rs}`)
  return chain.join(',')
}

export const PEAK_MARGIN = 0.3   // the limiter aims this far under the ceiling; encoding to MP3 or AAC adds a little peak
export const LUFS_TOLERANCE = 0.5   // what verify accepts
export const LUFS_SETTLE = 0.3      // what the master loop aims for, so the files land well inside it

/** After the master was encoded and every file measured: is it done, and if not, what to try next.
    `files` are [{ lufs, peak }] of the encoded files; `master` is the measured master. Any true peak above
    the ceiling widens the margin by the overshoot; when the encoded files miss the target on average, the
    level the master aims at moves by that much (encoders lose a little loudness with the high frequencies). */
export function nextMasterStep({ files, master = null, target, ceiling, aim, margin }) {
  const peak = Math.max(...[...files, ...(master ? [master] : [])].map((f) => f.peak))
  const errs = files.map((f) => f.lufs - target), err = errs.reduce((a, b) => a + b, 0) / errs.length
  const peakOk = peak <= ceiling + 1e-9, lufsOk = errs.every((e) => Math.abs(e) <= LUFS_SETTLE + 1e-9)
  return { done: peakOk && lufsOk, peak, err: Math.round(err * 100) / 100,
    margin: peakOk ? margin : Math.round((margin + (peak - ceiling) + 0.1) * 100) / 100,
    aim: lufsOk ? aim : Math.round((aim - err) * 100) / 100 }
}
