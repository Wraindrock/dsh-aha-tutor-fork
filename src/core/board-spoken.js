// Every board item is said out loud.
//
// The learner listens and reads the board at the same time, so an item whose
// words never reach "say" is a gap: their eyes are on it and their ears are
// somewhere else. A prompt asks the model to voice each op; models drift, and
// a heading, a figure caption or a table is exactly what drifts — it feels
// like a label rather than something to say.
//
// So the rule is enforced, not only requested: after a board is normalized,
// each op's words are checked against its step's narration, and one that is
// missing is appended to the narration as a sentence of its own. The model
// still gets the prompt, and a model that does this well produces nothing to
// append; a model that leaves an op silent gets the sentence it needed.
//
// The check is deliberately forgiving. A word counts as spoken when it
// appears in the narration in any form (spacing, punctuation, case and
// full-width forms differ between the two), and tiny or purely symbolic
// fragments are not required at all — the point is that the idea on the board
// reaches the learner's ear, not that the same characters do.

// What an op says, in words a learner would hear. Empty for ops that carry no
// speech of their own (a column break, a page turn, a mark).
export function spokenTextOf(op) {
  switch (op?.t) {
    case 'title':
    case 'h':
    case 'p':
    case 'note':
      return String(op.text ?? '')
    case 'math':
      return String(op.text || op.tex || '')
    case 'list':
      return (op.items ?? []).join('；')
    case 'table':
      return [...(op.head ?? []), ...(op.rows ?? []).flat()].join('，')
    case 'code':
      return String(op.caption ?? '')
    case 'svg':
    case 'chart':
    case 'plot':
    case 'anim':
      return String(op.caption ?? op.title ?? '')
    default:
      return ''
  }
}

// Text with everything but letters and digits removed, so "F = −kx" and
// "F等于负kx" compare on their content.
const bare = value => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

// The phrases of an op's text that must be heard. A short item ("情景一：手推墙")
// is one phrase: saying half of it is not saying it. A long one is split on
// its punctuation, since a teacher reads a table or a list clause by clause.
// A single symbol ("k", "A", "−") is never required.
export function voicedPhrases(value) {
  const whole = String(value ?? '').trim()
  const parts = whole.split(/[。；;\n]+/u).map(part => part.trim()).filter(Boolean)
  // Whole clauses when the item is one or two; sentence pieces when it is a
  // paragraph, so a long "p" does not have to be recited verbatim.
  const phrases = parts.length <= 2 ? [whole] : parts
  return phrases.filter(phrase => [...phrase].length >= 2)
}

// A formula read aloud the way a teacher reads it: "F = −kx" is said
// "F 等于负的 k x". So a math op counts as said when every piece of it — its
// letters, its numbers, its sign words — is heard, in any order and any
// language, not necessarily as the same string.
const SIGN_WORDS = Object.freeze({
  '-': ['负', '减', 'minus', 'negative', '-'],
  '+': ['加', '正', 'plus', 'pos', '+'],
  '=': ['等于', 'equals', 'is', '等于', '='],
  '/': ['除以', '分之', 'over', 'per', '/'],
  '^': ['平方', '次方', '的', 'squared', 'power', '^'],
  '\u00b7': ['乘', 'times', 'dot'],
  '*': ['乘', 'times', '乘'],
})

// A formula's text may write multiplication by juxtaposition ("-kx"), which
// a teacher says as "乘以".
const IMPLIED_PRODUCT = ['×', '*', '·', '乘', 'times', 'x']

function mathPieces(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s/gu, '')
    // A figure and the unit after it are separate pieces: "100N" is 100 and N.
    .replace(/([0-9])/gu, ' $1 ')
    .replace(/([a-z])/gu, ' $1 ')
    .replace(/([.])/gu, ' ')
    .split(/\s+/u)
    .filter(piece => piece && /^[a-z0-9.]+$/u.test(piece))
    // Digits of one figure join back: "1 0 0" is 100.
    .join(' ')
    .replace(/\b(\d)\s+(?=\d)/gu, '$1')
    .split(' ')
}

function mathHeard(value, said) {
  const bareSaid = bare(said)
  const spokenSaid = String(said ?? '').normalize('NFKC').toLowerCase()
  // The figures are what must be heard; a learner who heard "力的大小是 100 牛"
  // has been given "|F| = 100 N" even though the symbol was said as a word.
  const numbers = mathPieces(value).filter(piece => /^[0-9]+(?:\.[0-9]+)?$/u.test(piece))
  if (!numbers.every(number => bareSaid.includes(number))) return false
  // Bars and pipes are notation, not speech.
  const symbols = mathPieces(value).filter(piece => /^[a-z]+$/u.test(piece))
  const operators = mathPieces(value).filter(piece => /^[-+=/^*·]$/u.test(piece))
  for (const operator of operators) {
    const words = SIGN_WORDS[operator] ?? [operator]
    if (!words.some(word => spokenSaid.includes(word) || bareSaid.includes(bare(word)))) return false
  }
  // "kx" with no operator between the letters is a product: it counts as read
  // when every letter is heard, since a teacher says "k 乘 x" or "kx".
  void IMPLIED_PRODUCT
  // With its figures said, the formula's letters may be said as words.
  if (numbers.length) return true
  return symbols.every(symbol => bareSaid.includes(symbol))
}

// A table is a special case: its cells are often walked through in prose
// ("手推墙那一列是手、墙、向右") without the exact column order, and reading
// the grid aloud after that is repetition, not teaching. So a table counts as
// said when its column names are heard and most of its cells are: the learner
// has been given the table, and the board shows it.
const TABLE_ENOUGH = 0.6

function tableHeard(op, said) {
  const bareSaid = bare(said)
  const heads = (op.head ?? []).filter(head => [...String(head)].length >= 2)
  if (heads.some(head => !bareSaid.includes(bare(head)))) return false
  const cells = (op.rows ?? []).flat().filter(cell => [...String(cell)].length >= 1)
  if (!cells.length) return true
  const heard = cells.filter(cell => bareSaid.includes(bare(cell))).length
  return heard / cells.length >= TABLE_ENOUGH
}

// Which of an op's phrases are missing from `said`. A formula is judged by
// its pieces (see mathHeard), a table by whether its columns were given;
// everything else by whether its words are heard.
export function missingPhrases(op, said) {
  const text = spokenTextOf(op)
  if (!text) return []
  if (op?.t === 'math') return mathHeard(text, said) ? [] : [text]
  if (op?.t === 'table') return tableHeard(op, said) ? [] : [text]
  // Inline formulas in a paragraph are read as formulas, not as LaTeX: a
  // learner who heard "x 等于 0.5 米" has heard "$x = 0.5$ m".
  const withoutMath = String(text).replace(/\$[^$\n]+\$/gu, ' ')
  const formulas = [...String(text).matchAll(/\$([^$\n]+)\$/gu)].map(match => match[1])
  if (formulas.length && !formulas.every(formula => mathHeard(formula, said))) return [text]
  // A sentence with a formula in the middle is compared with the formula taken
  // out of the narration too: "原因：$a=F/m$，地球质量太大" is heard by a
  // learner who heard "原因：……，地球质量太大".
  const saidBare = bare(said)
  const saidPlainBare = bare(String(said).replace(/\$[^$\n]+\$/gu, ' '))
  return voicedPhrases(withoutMath).filter(phrase => {
    const needle = bare(phrase)
    if (saidBare.includes(needle) || saidPlainBare.includes(needle)) return false
    // A long line is a sentence, and a teacher may say the same thing in
    // other words. Most of its clauses heard is enough; a short label is not
    // so forgiving — saying half of "情景一：手推墙" is not saying it.
    const clauses = phrase.split(/[，、：,:]+/u).map(part => bare(part)).filter(part => [...part].length >= 2)
    if (clauses.length < 2) return true
    const heard = clauses.filter(clause => saidPlainBare.includes(clause) || saidBare.includes(clause)).length
    return heard / clauses.length < 0.6
  })
}

// A formula as speech: TeX markup removed, symbols kept. Only a fallback —
// a board normally carries a "text" reading of each formula.
function prettyMath(tex) {
  return String(tex ?? '')
    .replace(/\\text\s*\{([^{}]*)\}/gu, '$1')
    .replace(/\\[a-zA-Z]+\s*/gu, ' ')
    .replace(/[{}]/gu, '')
    .replace(/\\/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([=+\-*·/])\s*/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// A sentence that says the op, for a step whose narration left it out. It
// reads the item out the way a teacher would, so appending it still sounds
// like teaching rather than like a label being read.
export function spokenSentence(op) {
  const text = spokenTextOf(op).trim()
  if (!text) return ''
  switch (op.t) {
    case 'title':
      return text
    case 'h':
      return text
    case 'math':
      // What to say when nothing said it: the plain reading the board carries
      // when it has one, else the formula with its markup stripped — never
      // the LaTeX source, and never just the symbols when a reading exists.
      return String(op.text || prettyMath(op.tex) || text)
    case 'list':
      return (op.items ?? []).join('；')
    case 'table':
      return [...(op.head ?? []), ...(op.rows ?? []).flat()].join('，')
    case 'note':
      return text
    default:
      return text
  }
}

// Append what the model left unsaid to the step's narration, in board order,
// capped so a runaway board cannot turn one step into an essay. Returns the
// narration as it should be spoken (unchanged when nothing was missing).
export function voiceSilentOps(step, { maxAppend = 400 } = {}) {
  const say = String(step?.say ?? '')
  if (!step?.ops?.length) return say
  const extra = []
  let room = maxAppend
  for (const op of step.ops) {
    if (!missingPhrases(op, `${say} ${extra.join(' ')}`).length) continue
    const sentence = spokenSentence(op)
    if (!sentence) continue
    const clipped = [...sentence].length > room ? [...sentence].slice(0, Math.max(0, room)).join('') : sentence
    if (!clipped.trim()) break
    extra.push(clipped)
    room -= [...clipped].length
    if (room <= 0) break
  }
  if (!extra.length) return say
  const lead = !say ? '' : /[。！？!?；;]$/u.test(say) ? '' : /[,，、:：]$/u.test(say) ? '' : '。'
  // A "？" already ends the sentence: "……为什么？。" is never right.

  // Each appended item already ends as it does; add a stop only where it
  // does not, so "情景一：手推墙。F = -kx。" never becomes "。。".
  const parts = extra.map(part => (/[。！？!?；;.]$/u.test(part) ? part : `${part}。`))
  return `${say}${lead}${parts.join('')}`
}

// The same, for a whole board: used once the steps are normalized.
export function voiceBoard(board) {
  const steps = (board?.steps ?? []).map(step => {
    const say = voiceSilentOps(step)
    return say === step.say ? step : { ...step, say }
  })
  return steps === board?.steps ? board : { ...board, steps }
}

// Whether every item on the board is said (true for an empty board).
export function spokeAll(steps) {
  return silentOps(steps).length === 0
}

// The board items still unspoken, with the phrases missing from their step.
export function silentOps(steps) {
  const found = []
  for (const step of steps ?? []) {
    for (const op of step.ops ?? []) {
      const missing = missingPhrases(op, step.say)
      if (missing.length) found.push({ stepId: step.id, op: op.t, missing })
    }
  }
  return found
}
