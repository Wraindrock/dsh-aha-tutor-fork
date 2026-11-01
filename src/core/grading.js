// Automatic grading for objective questions. Open answers ("short") are
// graded by the model on the host; everything here is deterministic.
//
// A blank is a short answer typed by hand, so it is compared leniently: a
// learner who writes "−kx", "-k x", "− kx" or "F=-kx" for the key "-kx" knows
// the answer. Only a genuinely different answer is wrong.

export const OBJECTIVE_KINDS = Object.freeze(['choice', 'multi', 'blank', 'number', 'order'])

const FULLWIDTH = /[！-～]/gu

export function normalizeAnswerText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(FULLWIDTH, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s　]+/gu, ' ')
    .replace(/^[\s.,;:!?'"`，。；：！？、“”‘’]+|[\s.,;:!?'"`，。；：！？、“”‘’]+$/gu, '')
    .trim()
}

function parseNumber(value) {
  if (typeof value === 'number') return value
  const text = normalizeAnswerText(value).replace(/,/gu, '').replace(/\s/gu, '')
  const fraction = /^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/u.exec(text)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])
  const percent = /^(-?\d+(?:\.\d+)?)%$/u.exec(text)
  if (percent) return Number(percent[1]) / 100
  const number = Number(text)
  return Number.isFinite(number) ? number : Number.NaN
}

// The marks that carry no meaning in a short answer: spaces, multiplication
// dots and stars, quote marks, the equals of an "F = -kx" typed whole, the
// technical brackets around a formula, and the punctuation a learner may end
// the line with. Every dash becomes "-".
const LOOSE_STRIP = /[\s　=*×·⋅'`"“”‘’()（）[\]【】]/gu

const LOOSE_EDGE = /^[,.!?;:。，；：！？、~～…]+|[,.!?;:。，；：！？、~～…]+$/gu

function looseFold(value) {
  return normalizeAnswerText(value)
    .replace(/[−–—‒﹣－]/gu, '-')
    .replace(LOOSE_STRIP, '')
    .replace(LOOSE_EDGE, '')
    .trim()
}

// The forms a short answer is compared in: as written, then without the
// marks above, and the right-hand side of an equation the learner retyped
// ("F=-kx" for "-kx").
function answerForms(value) {
  const forms = new Set()
  const normalized = normalizeAnswerText(value)
  if (normalized) forms.add(normalized)
  const loose = looseFold(value)
  if (loose) forms.add(loose)
  const right = /=\s*(.+)$/u.exec(normalized)?.[1]
  if (right) {
    forms.add(right)
    const folded = looseFold(right)
    if (folded) forms.add(folded)
  }
  return forms
}

const sameForms = (a, b) => [...a].some(form => b.has(form))

// A number typed with its unit ("9.8 m/s²", "4 N", "0.5s") is still that
// number: whatever follows the figure must read as a unit, not a second
// figure, so "4 + 5" never passes for "4".
export function parseAnswerNumber(value) {
  const direct = parseNumber(value)
  if (Number.isFinite(direct)) return direct
  const text = normalizeAnswerText(value).replace(/,/gu, '')
  const match = /^(-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(.*)$/u.exec(text)
  if (!match) return Number.NaN
  const rest = match[2].replace(/[\s　]/gu, '')
  // A unit may follow the figure — letters, the marks of a compound unit
  // (m/s², kg·m), or a Chinese unit — but nothing that carries a figure of
  // its own: "4 N" and "4牛" are four, "4 + 5" is not. A power is the one
  // figure a unit may carry ("m/s2" for m/s²).
  if (rest && !/^(?=.*[^\d\s+\-=,。，、;；:：])[a-zµμ%/°℃·⋅-]*\d{0,2}[a-zµμ%/°℃·⋅-]*$/iu.test(rest) && !/^[^\d\s+\-=,。，、;；:：]{1,10}$/u.test(rest)) return Number.NaN
  return parseNumber(match[1].replace(/\s/gu, ''))
}

// Whether a typed answer is close enough to an accepted one: the same text
// read leniently, or the same number (within 0.1 %, the default tolerance).
export function answerMatches(accepted, response) {
  const given = answerForms(response)
  if (!given.size) return false
  const keys = (Array.isArray(accepted) ? accepted : [accepted]).map(answerForms).filter(forms => forms.size)
  if (!keys.length) return false
  if (keys.some(forms => sameForms(given, forms))) return true
  const number = parseAnswerNumber(response)
  if (!Number.isFinite(number)) return false
  return keys.some(forms => [...forms]
    .map(entry => parseAnswerNumber(entry))
    .some(value => Number.isFinite(value) && Math.abs(value - number) <= Math.max(1e-9, Math.abs(value) * 0.001)))
}

// Returns { score: 0..1, correct: boolean, gradable: boolean }.
export function gradeObjective(item, response) {
  if (!item || !OBJECTIVE_KINDS.includes(item.kind)) return { score: 0, correct: false, gradable: false }

  if (item.kind === 'choice') {
    const correct = String(response ?? '') === String(item.answer ?? '')
    return { score: correct ? 1 : 0, correct, gradable: true }
  }

  if (item.kind === 'multi') {
    const expected = new Set((Array.isArray(item.answer) ? item.answer : [item.answer]).map(String))
    const given = new Set((Array.isArray(response) ? response : []).map(String))
    if (!expected.size) return { score: 0, correct: false, gradable: false }
    let hits = 0
    let wrong = 0
    for (const id of given) {
      if (expected.has(id)) hits += 1
      else wrong += 1
    }
    const score = Math.max(0, (hits - wrong) / expected.size)
    const correct = hits === expected.size && wrong === 0
    return { score: round2(score), correct, gradable: true }
  }

  if (item.kind === 'order') {
    const expected = (Array.isArray(item.answer) ? item.answer : []).map(String)
    const given = (Array.isArray(response) ? response : []).map(String)
    if (!expected.length) return { score: 0, correct: false, gradable: false }
    let inPlace = 0
    expected.forEach((id, index) => { if (given[index] === id) inPlace += 1 })
    return { score: round2(inPlace / expected.length), correct: inPlace === expected.length, gradable: true }
  }

  if (item.kind === 'number') {
    const expected = parseNumber(item.answer)
    const given = parseAnswerNumber(response)
    if (!Number.isFinite(expected)) return { score: 0, correct: false, gradable: false }
    if (!Number.isFinite(given)) return { score: 0, correct: false, gradable: true }
    const tolerance = Number.isFinite(Number(item.tolerance)) && Number(item.tolerance) >= 0
      ? Number(item.tolerance)
      : Math.max(1e-9, Math.abs(expected) * 0.01)
    const correct = Math.abs(given - expected) <= tolerance
    return { score: correct ? 1 : 0, correct, gradable: true }
  }

  // blank: any accepted spelling counts, compared leniently (see above).
  const accepted = (Array.isArray(item.answer) ? item.answer : [item.answer]).filter(value => String(value ?? '').trim())
  if (!accepted.length) return { score: 0, correct: false, gradable: false }
  const correct = answerMatches(accepted, response)
  return { score: correct ? 1 : 0, correct, gradable: true }
}


// A short label of a wrong answer, for the mastery model's misconception log.
export function wrongLabel(item, response) {
  if (item.kind === 'choice') return `chose ${String(response).toUpperCase()}: ${(item.options?.find(option => option.id === response)?.text ?? '').slice(0, 50)}`
  if (item.kind === 'number' || item.kind === 'blank') return `answered ${String(response).slice(0, 40)}`
  return 'wrong'
}

function round2(value) {
  return Math.round(value * 100) / 100
}
