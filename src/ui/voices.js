// The Edge voice library, as the settings page shows it: names for display,
// the filter it applies, and the language counts its picker offers. Pure
// strings and plain objects in and out; no DOM, no network.

// Locale, then an optional regional part ("zh-CN-liaoning"), then the name.
const VOICE_ID = /^([A-Za-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]{2,10})?)-([A-Za-z][A-Za-z0-9]*?)Neural$/u

// "zh-CN-XiaoxiaoNeural" → "Xiaoxiao"; an id this app did not expect is shown
// as it came, never hidden.
export function voiceName(id) {
  const value = String(id ?? '')
  return VOICE_ID.exec(value)?.[2] ?? value
}

// "zh-CN-XiaoxiaoNeural" → "Xiaoxiao · zh-CN".
export function voiceLabel(voice) {
  const id = typeof voice === 'string' ? voice : voice?.id
  const locale = (typeof voice === 'object' && voice?.locale) || VOICE_ID.exec(String(id ?? ''))?.[1] || ''
  const name = voiceName(id)
  return locale ? `${name} · ${locale}` : name
}

// Search by name or locale, filter by one locale, and list the language the
// learner is using first; the rest stay in a stable alphabetical order.
export function filterVoices(voices, { query = '', locale = '', preferred = '' } = {}) {
  const needle = String(query).trim().toLowerCase()
  const wanted = String(locale).trim().toLowerCase()
  const preference = String(preferred).trim().toLowerCase()
  const base = preference.split('-')[0]
  const rank = voice => {
    const spoken = String(voice?.locale ?? '').toLowerCase()
    if (!base) return 1
    return spoken === preference ? 0 : spoken.split('-')[0] === base ? 1 : 2
  }
  return (Array.isArray(voices) ? voices : [])
    .filter(voice => {
      const id = String(voice?.id ?? '')
      if (!id) return false
      if (wanted && String(voice?.locale ?? '').toLowerCase() !== wanted) return false
      if (!needle) return true
      return `${id} ${voice?.locale ?? ''} ${voice?.gender ?? ''}`.toLowerCase().includes(needle)
    })
    .sort((a, b) => rank(a) - rank(b) || String(a.locale ?? '').localeCompare(String(b.locale ?? '')) || String(a.id).localeCompare(String(b.id)))
}

// The language picker's options, counted and sorted by locale.
export function localeOptions(voices) {
  const counts = new Map()
  for (const voice of Array.isArray(voices) ? voices : []) {
    const locale = String(voice?.locale ?? '')
    if (!locale) continue
    counts.set(locale, (counts.get(locale) ?? 0) + 1)
  }
  return [...counts].map(([locale, count]) => ({ locale, count })).sort((a, b) => a.locale.localeCompare(b.locale))
}
