import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateSpeechMs } from '../src/core/board-script.js'
import { EDGE_DEFAULT_VOICE, EDGE_VOICES, encodeFrame, listEdgeVoices, secMsGec, synthesisUrl } from '../src/host/edge-tts.js'
import { cleanPrefs, createKeyStore, PREF_DEFAULTS } from '../src/host/settings.js'
import { createTts, PROVIDER_FIELDS, providerDefaults, splitForSpeech, TTS_PROVIDERS } from '../src/host/tts.js'

// A reference value from the same algorithm the service's other clients use;
// a token that stops matching means the request will be refused with 403.
test('the Edge gate token follows the clock in five-minute windows', () => {
  assert.equal(secMsGec(Date.parse('2026-01-01T00:00:00Z')), '723A6EBC411B23BB-214991EA6B1E401F3D777A699DDDEE75E29740EA7A5DCD1007366FA1090DD267')
  assert.equal(secMsGec(Date.parse('2026-10-31T10:00:00Z')), '1AAB3838AFF8CF21-2A8E390F89C6283FE5C1A0FC5F5689FB8AB53851734DE846B474B61873B6A153')
  const start = Date.parse('2026-10-31T10:00:00Z')
  assert.equal(secMsGec(start + 299_000), secMsGec(start), 'the same window keeps its token')
  assert.notEqual(secMsGec(start + 300_000), secMsGec(start), 'the next window gets a new one')
  assert.match(secMsGec(start), /^[0-9A-F]{16}-[0-9A-F]{64}$/u)

  const url = synthesisUrl(start, 'abc123')
  assert.equal(url.protocol, 'wss:')
  assert.equal(url.searchParams.get('Sec-MS-GEC'), secMsGec(start))
  assert.equal(url.searchParams.get('ConnectionId'), 'abc123')
  assert.ok(url.searchParams.get('TrustedClientToken'))
})

test('an outgoing WebSocket frame is masked and states its own length', () => {
  const small = encodeFrame(0x1, 'hi')
  assert.equal(small[0], 0x81, 'fin + text')
  assert.equal(small[1], 0x82, 'masked, two bytes')
  const mask = small.subarray(2, 6)
  assert.equal(String.fromCharCode(small[6] ^ mask[0], small[7] ^ mask[1]), 'hi')

  const large = encodeFrame(0x1, 'x'.repeat(300))
  assert.equal(large[0], 0x81)
  assert.equal(large[1], 0x80 | 126, '16-bit length')
  assert.equal(large.readUInt16BE(2), 300)
  assert.equal(large.length, 4 + 4 + 300)
})

test('long narration is cut by speaking time, so no request carries many minutes of audio', async () => {
  const sentence = '平行线被第三条直线所截，同位角相等，内错角相等，同旁内角互补。'
  const twoMinutes = sentence.repeat(13) // ~560 characters, about 2 minutes of speech
  assert.equal(splitForSpeech(twoMinutes, 180_000, 4000).length, 1, 'a two-minute narration is one request')

  // The host takes at most 4,000 characters per narration; this is well under
  // that and still over ten minutes of speech.
  const long = sentence.repeat(110) // ~3,400 characters, about 11 minutes of speech
  const chunks = splitForSpeech(long, 180_000, 4000)
  assert.ok(chunks.length >= 4, `cut into at least four requests, got ${chunks.length}`)
  for (const chunk of chunks) assert.ok(estimateSpeechMs(chunk) <= 200_000, `each request stays near three minutes (${Math.round(estimateSpeechMs(chunk) / 1000)} s)`)
  assert.equal(chunks.join(''), long, 'splitting loses no text')

  // The audio of the pieces is joined in order, as one narration.
  const calls = []
  const tts = createTts({
    cacheDir: null,
    getSecret: async () => undefined,
    edgeSynthesize: async ({ text }) => {
      calls.push(text)
      return Buffer.from('MP3')
    },
  })
  const result = await tts.synthesize({ provider: 'edge', text: long, config: {} })
  assert.equal(calls.length, chunks.length)
  assert.equal(result.audio.toString(), 'MP3'.repeat(chunks.length))
})

test('the Edge voice library keeps only well-formed voices, sorted, and is cached', async () => {
  const row = (id, locale, gender) => ({ ShortName: id, Locale: locale, Gender: gender, FriendlyName: 'x' })
  const rows = [
    row('zh-CN-XiaoxiaoNeural', 'zh-CN', 'Female'),
    row('zh-CN-XiaoxiaoNeural', 'zh-CN', 'Female'), // duplicate
    { ShortName: 'bad id with spaces', Locale: 'zh-CN', Gender: 'Female' },
    { ShortName: 'en-US-AriaNeural', Locale: 'us', Gender: 'Female' }, // locale malformed
    row('en-US-GuyNeural', 'en-US', 'Male'),
    { ShortName: 'fr-FR-DeniseNeural', Locale: 'fr-FR', Gender: 'Unknown' },
    { ShortName: 'de-DE-KatjaNeural' }, // no locale
    row('zh-CN-liaoning-XiaobeiNeural', 'zh-CN-liaoning', 'Female'),
  ]
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(JSON.stringify(rows), { status: 200 })
  }
  const farAhead = Date.now() + 7 * 60 * 60 * 1000
  const voices = await listEdgeVoices({ fetchImpl, now: farAhead })
  assert.deepEqual(voices, [
    { id: 'en-US-GuyNeural', locale: 'en-US', gender: 'Male' },
    { id: 'fr-FR-DeniseNeural', locale: 'fr-FR', gender: '' },
    { id: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', locale: 'zh-CN-liaoning', gender: 'Female' },
  ])
  assert.equal(calls, 1)

  // Inside the cache window the service is not asked again.
  await listEdgeVoices({ fetchImpl, now: farAhead + 60_000 })
  assert.equal(calls, 1, 'the list is kept for a few hours')
  await listEdgeVoices({ fetchImpl, now: farAhead + 7 * 60 * 60 * 1000 })
  assert.equal(calls, 2, 'a stale list is fetched again')

  // A reply that is not a usable list is refused, never half-used.
  await assert.rejects(listEdgeVoices({ fetchImpl: async () => new Response('not json', { status: 200 }), now: farAhead + 14 * 60 * 60 * 1000 }), /voice list/u)
  await assert.rejects(listEdgeVoices({ fetchImpl: async () => new Response('[]', { status: 200 }), now: farAhead + 14 * 60 * 60 * 1000 }), /voice list/u)
  await assert.rejects(listEdgeVoices({ fetchImpl: async () => new Response('', { status: 503 }), now: farAhead + 14 * 60 * 60 * 1000 }), /voice list/u)

  // The service's 322 voices fit; a strange reply cannot flood the browser.
  const many = Array.from({ length: 700 }, (_, index) => row(`en-US-Voice${index}Neural`, 'en-US', 'Female'))
  const capped = await listEdgeVoices({ fetchImpl: async () => new Response(JSON.stringify(many), { status: 200 }), now: farAhead + 20 * 60 * 60 * 1000 })
  assert.equal(capped.length, 600)
})

test('the Edge provider asks for no key, splits long text and caches by voice', async () => {
  assert.ok(TTS_PROVIDERS.includes('edge'))
  assert.ok(PROVIDER_FIELDS.edge.every(field => !field.secret))
  assert.equal(providerDefaults('edge').voice, EDGE_DEFAULT_VOICE)
  assert.ok(EDGE_VOICES.some(voice => voice.id === EDGE_DEFAULT_VOICE), 'the default is offered by the settings page')

  const calls = []
  let secretAsked = 0
  const tts = createTts({
    cacheDir: null,
    getSecret: async () => {
      secretAsked += 1
      return 'unused'
    },
    edgeSynthesize: async ({ text, config }) => {
      calls.push([text, config.voice])
      return Buffer.from(`EDGE:${text}`)
    },
  })
  const first = await tts.synthesize({ provider: 'edge', text: '你好', config: { voice: 'zh-CN-YunxiNeural' } })
  assert.equal(first.audio.toString(), 'EDGE:你好')
  assert.equal(secretAsked, 0, 'a key-less service never reads the credential store')
  assert.equal(calls.length, 1)

  // Another voice is another sound, so the browser asks again.
  const second = await tts.synthesize({ provider: 'edge', text: '你好', config: { voice: 'en-US-AriaNeural' } })
  assert.equal(second.audio.toString(), 'EDGE:你好')
  assert.deepEqual(calls, [['你好', 'zh-CN-YunxiNeural'], ['你好', 'en-US-AriaNeural']])
})

test('the Edge voice source is a setting of its own, with its own voice', () => {
  const defaults = cleanPrefs({}, PREF_DEFAULTS)
  assert.equal(defaults.tts.edge.voice, EDGE_DEFAULT_VOICE)
  const chosen = cleanPrefs({ voiceEngine: 'edge', tts: { edge: { voice: 'zh-CN-YunxiNeural' } } }, defaults)
  assert.equal(chosen.voiceEngine, 'edge')
  assert.equal(chosen.tts.edge.voice, 'zh-CN-YunxiNeural')
  assert.equal(cleanPrefs({ voiceEngine: 'speaker' }, defaults).voiceEngine, 'browser', 'an unknown source is refused')
})

test('the key store keeps no key for the key-less service', async () => {
  const asked = []
  const credentials = {
    async readRecord(id) { asked.push(id); return null },
    async describeRecord(id) { asked.push(id); return { configured: false } },
    async modifyRecord(id) { asked.push(id) },
    async deleteRecord(id) { asked.push(id) },
  }
  const store = createKeyStore({ getCredentials: () => credentials, credentialKey: (namespace, id) => `${namespace}:${id}` })
  assert.equal(await store.read('edge'), undefined)
  assert.equal((await store.status()).edge, false)
  await assert.rejects(store.write('edge', 'not-a-key'), /takes no key/)
  assert.ok(asked.length > 0, 'the keyed services are still asked about')
  assert.deepEqual(asked.filter(id => id.endsWith(':tts-edge')), [], 'the credential store is never asked about Edge')
})
