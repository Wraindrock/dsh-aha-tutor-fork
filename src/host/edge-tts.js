// Speech from Microsoft Edge's read-aloud service: no key, no account, just
// the network. The browser's own voices often lack a Chinese one on Linux and
// Windows without the language pack, and every cloud provider above needs a
// key, so this fills the gap for learners who have neither.
//
// The service is unofficial: it speaks for Edge's "Read aloud" feature and
// Microsoft never promised it to other software, so it may change or stop at
// any time. The request has to look enough like the browser to be let in:
// an Edge user agent, the extension origin, a MUID cookie, and the
// Sec-MS-GEC token derived from the clock. Failures are reported like any
// other speech provider's, and nothing falls back to a paid service.
//
// The Sec-MS-GEC v2 digest is adapted from msedge-tts 2.1.1 (MIT) and the
// format documented by edge-tts (LGPL-3.0). It hashes the Windows file time,
// rounded down to five minutes, with the copyright line Edge sends; the
// checksum half is a 64-bit mix of the same bytes. A wrong token is refused
// with 403 before the WebSocket opens.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

import { TtsError } from './tts-error.js'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
// The identity Edge reports when it asks for the token; the service accepts a
// v2 token only with a matching version string.
const SEC_MS_GEC_VERSION = '2-143.0.3650.96'
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.'
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const SYNTHESIS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// The same service lists every voice it speaks, key-less like synthesis. The
// list changes rarely, so it is kept for a few hours and shared by every
// open settings page.
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
const VOICE_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000
const VOICE_LIST_MAX_BYTES = 2 * 1024 * 1024
const MAX_VOICES = 600
let voiceListCache = null
let voiceListPending = null
// The service sends 48 kbps CBR MP3, the format Azure's own header asks for.
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
const MAX_AUDIO_BYTES = 12 * 1024 * 1024
const MAX_TEXT_UNITS = 6000

// The voices the settings page offers: the Chinese and English ones the
// service speaks most naturally. Any other ShortName still works if it is
// typed in, as the service keeps adding voices.
export const EDGE_VOICES = Object.freeze([
  { id: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-XiaoyiNeural', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunjianNeural', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunyangNeural', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunxiaNeural', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-TW-HsiaoChenNeural', locale: 'zh-TW', gender: 'Female' },
  { id: 'zh-HK-HiuMaanNeural', locale: 'zh-HK', gender: 'Female' },
  { id: 'en-US-AriaNeural', locale: 'en-US', gender: 'Female' },
  { id: 'en-US-JennyNeural', locale: 'en-US', gender: 'Female' },
  { id: 'en-US-GuyNeural', locale: 'en-US', gender: 'Male' },
  { id: 'en-GB-SoniaNeural', locale: 'en-GB', gender: 'Female' },
  { id: 'en-GB-RyanNeural', locale: 'en-GB', gender: 'Male' },
])

export const EDGE_DEFAULT_VOICE = DEFAULT_VOICE

// The full voice list, as the settings page's library. Every row is treated as
// untrusted: only a well-formed ShortName, Locale and Gender are kept, and the
// list is capped so a strange answer cannot flood the browser.
export async function listEdgeVoices({ fetchImpl = globalThis.fetch, signal, now = Date.now() } = {}) {
  if (voiceListCache && now - voiceListCache.at < VOICE_LIST_MAX_AGE_MS) return voiceListCache.voices
  voiceListPending ??= fetchEdgeVoices(fetchImpl, signal)
    .then(voices => {
      voiceListCache = { at: now, voices }
      return voices
    })
    .finally(() => { voiceListPending = null })
  return voiceListPending
}

async function fetchEdgeVoices(fetchImpl, signal) {
  let response
  try {
    response = await fetchImpl(VOICES_URL, { headers: { 'User-Agent': EDGE_USER_AGENT, Accept: 'application/json' }, redirect: 'error', signal })
  } catch {
    throw new TtsError('edge-voices', 'The Edge voice list could not be reached')
  }
  if (!response.ok) throw new TtsError('edge-voices', 'The Edge voice list is unavailable')
  let text
  try {
    text = await response.text()
  } catch {
    throw new TtsError('edge-voices', 'The Edge voice list could not be read')
  }
  if (text.length > VOICE_LIST_MAX_BYTES) throw new TtsError('edge-voices', 'The Edge voice list is too large')
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    throw new TtsError('edge-voices', 'The Edge voice list could not be read')
  }
  if (!Array.isArray(rows)) throw new TtsError('edge-voices', 'The Edge voice list could not be read')
  const seen = new Set()
  const voices = []
  for (const row of rows) {
    const id = typeof row?.ShortName === 'string' ? row.ShortName.trim() : ''
    const locale = typeof row?.Locale === 'string' ? row.Locale.trim() : ''
    const gender = row?.Gender === 'Female' || row?.Gender === 'Male' ? row.Gender : ''
    if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{2,40}$/u.test(id)) continue
    // A few Chinese voices name a region inside the locale
    // ("zh-CN-liaoning"); keep it rather than drop the voice.
    if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]{2,10})?$/u.test(locale) || seen.has(id)) continue
    seen.add(id)
    voices.push({ id, locale, gender })
    if (voices.length >= MAX_VOICES) break
  }
  if (!voices.length) throw new TtsError('edge-voices', 'The Edge voice list was empty')
  voices.sort((a, b) => a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id))
  return voices
}

const SWAP_FIRST_WORD = Object.freeze({ swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 })
const SWAP_SECOND_WORD = Object.freeze({ swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 })
const MIX_FIRST_WORD = Object.freeze([0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83])
const MIX_SECOND_WORD = Object.freeze([0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69])

const swapHalves = value => ((value << 16) | (value >>> 16)) >>> 0

function swapTerm(word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord)
  const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0
  return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0
}

function swapAndMultiply(value, multipliers) {
  let current = value
  for (const multiplier of multipliers) current = Math.imul(swapHalves(current), multiplier) >>> 0
  return current
}

function cs64(message, digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const firstKey = (view.getUint32(0, true) | 1) >>> 0
  const secondKey = (view.getUint32(4, true) | 1) >>> 0
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8)
  message.copy(padded)
  let swapSum = 0
  let lastSwap = 0
  let mix = 0
  let mixSum = 0
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = padded.readUInt32LE(offset)
    const secondWord = padded.readUInt32LE(offset + 4)
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST_WORD)
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND_WORD)
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0
    mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST_WORD)
    mixSum = (mixSum + mix) >>> 0
    mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND_WORD)
    mixSum = (mixSum + mix) >>> 0
  }
  const checksum = Buffer.alloc(8)
  checksum.writeUInt32LE((lastSwap ^ mix) >>> 0, 0)
  checksum.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4)
  return checksum.toString('hex').toUpperCase()
}

// Sec-MS-GEC v2 for the five-minute window `now` falls in.
export function secMsGec(now = Date.now()) {
  const ticks = Math.floor(now / 1000) + 11644473600
  const windowsTicks = (ticks - (ticks % 300)) * 10000000
  const message = Buffer.from(`${EDGE_COPYRIGHT}${windowsTicks}${TRUSTED_CLIENT_TOKEN}`)
  const digest = createHash('sha256').update(message).digest()
  return `${cs64(message, digest)}-${digest.toString('hex').toUpperCase()}`
}

export function synthesisUrl(now = Date.now(), connectionId = randomUUID().replaceAll('-', '')) {
  const url = new URL(SYNTHESIS_URL)
  url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN)
  url.searchParams.set('Sec-MS-GEC', secMsGec(now))
  url.searchParams.set('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION)
  url.searchParams.set('ConnectionId', connectionId)
  return url
}

const xmlEscape = value => String(value).replace(/[<>&'"]/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char])

// The request the service answers with audio, with the voice stated once in
// the SSML. Exported for the tests: a voice that never reaches this string is
// a voice the learner picked and never heard.
export function ssmlFor(text, voice, rate) {
  const lang = /^([A-Za-z]{2,3}-[A-Za-z]{2,4})/u.exec(voice)?.[1] ?? 'en-US'
  const percent = Math.round((Math.min(2, Math.max(0.5, Number(rate) || 1)) - 1) * 100)
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${percent >= 0 ? '+' : ''}${percent}%" pitch="+0Hz">${xmlEscape(text)}</prosody></voice></speak>`
}

// A ShortName the service accepts, as the settings page lists them. The
// library keeps regional ids such as "zh-CN-liaoning-XiaobeiNeural", so the
// optional region segment is part of a valid name.
function checkVoice(value) {
  const voice = String(value ?? '').trim()
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{2,40}$/u.test(voice)) throw new TtsError('edge-voice', 'That Edge voice name is not valid')
  return voice
}

// One masked client frame. The service never asks for compression, so every
// message goes out as a single unfragmented frame.
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  const length = body.length
  const header = length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536
      ? Buffer.alloc(4)
      : Buffer.alloc(10)
  if (length >= 126 && length < 65536) {
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else if (length >= 65536) {
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = body[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

// A frame reader for the server's side of the connection: it never masks,
// may fragment, and pings while a turn is being synthesized.
function createFrameReader({ onText, onBinary, onPing, onClose, onProtocol }) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let fragmentOpcode = 0
  const deliver = (opcode, payload) => {
    if (opcode === 0x1) onText(payload.toString('utf8'))
    else if (opcode === 0x2) onBinary(payload)
  }
  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0F
      const masked = (second & 0x80) !== 0
      let length = second & 0x7F
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const large = buffer.readBigUInt64BE(2)
        if (large > BigInt(MAX_AUDIO_BYTES * 4)) return onProtocol('frame too large')
        length = Number(large)
        offset = 10
      }
      const maskOffset = masked ? 4 : 0
      if (buffer.length < offset + maskOffset + length) return
      let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length)
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index % 4]
        payload = unmasked
      }
      buffer = buffer.subarray(offset + maskOffset + length)
      if (opcode === 0x8) {
        onClose()
        return
      }
      if (opcode === 0x9) {
        onPing(payload)
        continue
      }
      if (opcode === 0xA) continue
      if (opcode === 0x0) {
        if (!fragments.length) return onProtocol('continuation without a start')
        fragments.push(payload)
        if (fin) {
          const whole = Buffer.concat(fragments)
          fragments = []
          deliver(fragmentOpcode, whole)
        }
        continue
      }
      if (fin) {
        deliver(opcode, payload)
      } else {
        fragments = [payload]
        fragmentOpcode = opcode
      }
    }
  }
}

function upgradeFailure(status) {
  if (status === 401 || status === 403) return new TtsError('edge-forbidden', 'The Edge speech service refused the connection')
  if (status === 429) return new TtsError('rate-limit', 'The Edge speech service is rate limiting requests', status)
  if (status >= 500) return new TtsError('server', 'The Edge speech service returned a server error', status)
  return new TtsError('request', `The Edge speech service refused the request (${status})`, status)
}

function connect(url, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      request.destroy()
      finish(signal.reason ?? new TtsError('cancelled', 'Cancelled'))
    }
    const request = httpsRequest({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: EDGE_ORIGIN,
        'User-Agent': EDGE_USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
      },
    })
    request.on('upgrade', (response, socket, head) => {
      socket.setNoDelay(true)
      finish(null, { socket, head })
    })
    request.on('response', response => {
      response.resume()
      finish(upgradeFailure(response.statusCode))
    })
    request.on('error', error => finish(error?.name === 'TtsError' ? error : new TtsError('network', 'Could not reach the Edge speech service')))
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish(new TtsError('stalled', 'The Edge speech service is not responding'))
    })
    if (signal) {
      if (signal.aborted) {
        request.destroy()
        finish(signal.reason ?? new TtsError('cancelled', 'Cancelled'))
        return
      }
      signal.addEventListener?.('abort', abort, { once: true })
    }
    request.end()
  })
}

function audioFromBinary(payload) {
  if (payload.length < 2) return Buffer.alloc(0)
  const headerLength = payload.readUInt16BE(0)
  if (headerLength > payload.length - 2) throw new TtsError('response', 'The Edge speech service sent a malformed reply')
  const header = payload.subarray(2, 2 + headerLength).toString('utf8')
  if (!/\r\nPath:audio\r\n/u.test(header)) return Buffer.alloc(0)
  return payload.subarray(2 + headerLength)
}

// One turn: open a connection, ask for `text` in `voice`, collect the MP3
// until the service says the turn ended. `limits` is TTS_LIMITS.
//
// Callers that keep the voice in a provider config (the TTS service passes
// `config` and the spoken rate) reach it through `config.voice`: reading only
// a top-level `voice` silently spoke every request in the default one.
export function synthesizeEdge({ text, voice, config, rate = 1, signal, limits }) {
  const chosenVoice = voice ?? config?.voice ?? DEFAULT_VOICE
  const content = String(text ?? '').trim()
  if (!content) throw new TtsError('empty', 'Nothing to speak')
  if ([...content].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x7f ? 3 : 1), 0) > MAX_TEXT_UNITS) throw new TtsError('too-large', 'That text is too long for one Edge request')
  const chosen = checkVoice(chosenVoice)
  const totalMs = limits?.totalMs ?? 45_000
  const quietMs = limits?.quietMs ?? 10_000
  const connectionId = randomUUID().replaceAll('-', '')
  const url = synthesisUrl(Date.now(), connectionId)
  const requestId = randomUUID().replaceAll('-', '')
  const timestamp = new Date().toISOString()

  return new Promise((resolve, reject) => {
    let audio = Buffer.alloc(0)
    let settled = false
    let socket = null
    let quiet = null
    let total = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(quiet)
      clearTimeout(total)
      signal?.removeEventListener?.('abort', abort)
      if (socket && !socket.destroyed) {
        socket.removeAllListeners('data')
        socket.removeAllListeners('close')
      }
      if (error) {
        socket?.destroy()
        reject(error)
      } else {
        resolve(value)
      }
    }
    const abort = () => finish(signal.reason ?? new TtsError('cancelled', 'Cancelled'))
    const quietTimer = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => finish(new TtsError('stalled', 'The Edge speech service stopped sending audio')), quietMs)
    }

    connect(url, { signal, timeoutMs: totalMs }).then(({ socket: linked, head }) => {
      socket = linked
      if (settled) {
        socket.destroy()
        return
      }
      total = setTimeout(() => finish(new TtsError('timeout', 'Edge speech synthesis timed out')), totalMs)
      quietTimer()
      socket.on('error', () => finish(new TtsError('network', 'The Edge speech service closed the connection')))
      socket.on('close', () => {
        if (!settled) finish(new TtsError('network', 'The Edge speech service closed the connection'))
      })
      const push = createFrameReader({
        onText: value => {
          if (settled) return
          quietTimer()
          if (value.includes('Path:turn.end')) {
            // The service returns an empty turn for a voice it will not speak:
            // an English-only voice asked to read Chinese, a retired name. The
            // message names the voice so the learner can pick another one.
            if (!audio.length) return finish(new TtsError('response', `The Edge speech service returned no audio for ${chosen}`))
            socket.end(encodeFrame(0x8, Buffer.from([0x0F, 0xA0])))
            finish(null, audio)
          }
        },
        onBinary: payload => {
          if (settled) return
          quietTimer()
          try {
            const part = audioFromBinary(payload)
            if (!part.length) return
            audio = Buffer.concat([audio, part])
            if (audio.length > MAX_AUDIO_BYTES) finish(new TtsError('too-large', 'The Edge speech service returned too much audio'))
          } catch (error) {
            finish(error)
          }
        },
        onPing: payload => socket.write(encodeFrame(0xA, payload)),
        onClose: () => {
          if (!settled) finish(new TtsError('network', 'The Edge speech service closed the connection'))
        },
        onProtocol: reason => finish(new TtsError('response', `The Edge speech service sent an unexpected message (${reason})`)),
      })
      socket.on('data', push)
      if (signal) {
        if (signal.aborted) return abort()
        signal.addEventListener?.('abort', abort, { once: true })
      }
      socket.write(encodeFrame(0x1, `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } })}\r\n`))
      socket.write(encodeFrame(0x1, `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssmlFor(content, chosen, rate)}\r\n`))
      if (head?.length) push(head)
    }).catch(error => finish(error))
  })
}
