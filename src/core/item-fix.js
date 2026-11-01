// Fixing a practice or quiz question the learner caught out. A model that
// thinks first checks the question, what it was written to mean, and the
// judging of the learner's answer; this module keeps what it found usable,
// writes the fix into the stored question (remembering what each changed part
// first said), and carries the teacher's new judgement of the answer against
// the fixed question. Nothing here decides a grade itself.

import { verdictOf } from './answer-grade.js'
import { normalizeItem, text } from './course-model.js'

// wrong: the question or its key has a mistake; unclear: it depends on a
// convention it does not state; misgraded: a question graded by the model
// was right but the answer was graded wrongly; right: all of it was right.
export const ITEM_VERDICTS = Object.freeze(['wrong', 'unclear', 'misgraded', 'right'])
// What a fix may change, in the order the original is shown.
const FIELDS = ['prompt', 'options', 'answer', 'tolerance', 'unit', 'explanation', 'hints', 'rubric', 'figure']

// The learner's answer as the item takes it: an option id, a list of them,
// or text. Anything else is no answer.
export function cleanResponse(item, response) {
  const ids = (item?.options ?? []).map(option => option.id)
  if (item?.kind === 'choice') return ids.includes(response) ? response : ''
  if (item?.kind === 'multi' || item?.kind === 'order') return [...new Set((Array.isArray(response) ? response : []).filter(id => ids.includes(id)))]
  return typeof response === 'string' || typeof response === 'number' ? text(response, 4000) : ''
}

// What the learner answered, in words, for the checking model.
export function responseText(item, response) {
  const option = id => {
    const found = item.options?.find(entry => entry.id === id)
    return found ? `${id.toUpperCase()}. ${found.text}` : String(id)
  }
  if (item.kind === 'choice') return response ? option(response) : ''
  if (item.kind === 'multi') return response.map(option).join('; ')
  if (item.kind === 'order') return response.map(option).join(' → ')
  if (item.kind === 'number' && item.unit && response) return `${response} ${item.unit}`
  return String(response ?? '')
}

// The question as the checking model sees it: everything a learner sees and
// the key, without ids and bookkeeping. A figure keeps its drawing (a
// question may be about it), within a budget.
export function itemForCheck(item) {
  const { id, conceptIds, difficulty, fixed, svg, plot, ...rest } = item
  return JSON.stringify({ ...rest, ...(svg ? { svg: svg.slice(0, 8000) } : {}), ...(plot ? { plot } : {}) })
}

// The grade a model gives an open answer, in the shape lesson/grade returns.
function normalizeGrade(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.score))) return null
  const score = Math.min(1, Math.max(0, Number(raw.score)))
  return {
    score,
    verdict: verdictOf(raw),
    feedback: text(raw.feedback, 1200),
    errorTag: text(raw.errorTag, 80),
    ...(raw.wrongStep !== undefined ? { wrongStep: text(raw.wrongStep, 400), why: text(raw.why, 400), fix: text(raw.fix, 400) } : {}),
  }
}

const figureOf = item => (item.svg ? { svg: item.svg } : item.plot ? { plot: item.plot } : {})

// The corrected question the model wrote, kept only when it is the same
// kind of question with as many options (the learner's answer must still
// fit it). It keeps the original's id, concepts and difficulty, and its
// figure unless the model drew a new one. Null when unusable.
export function correctedItem(old, raw) {
  if (!raw || typeof raw !== 'object' || (raw.kind !== undefined && raw.kind !== old.kind)) return null
  const next = normalizeItem({ ...raw, kind: old.kind }, 0)
  if (!next || next.kind !== old.kind || (old.options?.length ?? 0) !== (next.options?.length ?? 0)) return null
  const redrawn = ['svg', 'figure', 'plot'].some(key => raw[key] !== undefined)
  const { svg, plot, ...rest } = next
  return { ...rest, ...(redrawn ? figureOf(next) : figureOf(old)), id: old.id, conceptIds: old.conceptIds ?? [], difficulty: old.difficulty ?? next.difficulty }
}

const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
const same = (a, b) => (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b)

// The parts of a question a fix changed, as they were before it.
function changedParts(old, next) {
  const was = {}
  for (const field of FIELDS) {
    if (field === 'options') {
      const options = Object.fromEntries((old.options ?? []).filter((option, index) => option.text !== next.options?.[index]?.text).map(option => [option.id, option.text]))
      if (Object.keys(options).length) was.options = options
    } else if (field === 'figure') {
      if (!same(figureOf(old), figureOf(next))) was.figure = true
    } else if (!same(old[field], next[field])) {
      was[field] = empty(old[field]) ? null : old[field]
    }
  }
  return was
}

// raw: { verdict, summary, explanation, item, credit, grade } from the
// model; item: the question as stored. A fix must change something, and an
// open answer the model grades needs its new grade (unless an unclear
// question gives the learner the credit).
export function normalizeItemVerdict(raw, item) {
  const verdict = ITEM_VERDICTS.includes(raw?.verdict) ? raw.verdict : null
  if (!verdict) throw new Error('the check names no verdict')
  const summary = text(raw?.summary ?? raw?.reason, 400)
  const explanation = text(raw?.explanation, 2000)
  const credit = verdict === 'unclear' && raw?.credit === true
  let fixed = null
  if (verdict === 'wrong' || verdict === 'unclear') {
    fixed = correctedItem(item, raw?.item)
    if (!fixed) throw new Error(`a "${verdict}" verdict needs the whole corrected question in "item": the same kind, the same number of options`)
    if (!Object.keys(changedParts(item, fixed)).length) throw new Error('the corrected question in "item" changes nothing')
  }
  // Every answer is the teacher's judgement now, so a check that finds the
  // answer wrongly graded says so and grades it again, whatever its kind. A
  // fixed question needs that new grade too: the answer was judged against
  // the question as it was, and only the teacher can judge it again.
  const graded = verdict !== 'right' && !credit && raw?.grade !== undefined ? normalizeGrade(raw.grade) : null
  if (verdict !== 'right' && !credit && !graded) throw new Error('give the new "grade" of the learner\'s answer against the corrected question')
  return { verdict, summary, explanation, item: fixed, credit, grade: graded }
}

// The stored question with a fix applied. It keeps its id and concepts, and
// remembers what each changed part first said, even when fixed again.
export function fixItem(stored, next, { at = new Date().toISOString() } = {}) {
  const { fixed: note, ...old } = stored
  const changed = changedParts(old, next)
  const was = { ...changed, ...note?.was }
  if (changed.options && note?.was?.options) was.options = { ...changed.options, ...note.was.options }
  return { ...next, id: stored.id, conceptIds: stored.conceptIds ?? next.conceptIds ?? [], fixed: { was, at: note?.at ?? at } }
}

// The answer graded again after a check: with the model's new grade against
// the fixed question, or the credit an unclear question gives. Only the
// teacher grades: what an answer is worth is a judgement (see
// core/answer-grade.js), never a comparison against the key.
// Null when nothing about the grade changes: a "right" verdict, or an open
// answer the model did not grade again.
export function regrade(item, response, checked) {
  if (checked.verdict === 'right') return null
  if (checked.credit) return { score: 1, correct: true, partial: false, errorTag: '' }
  if (!checked.grade) return null
  const verdict = verdictOf(checked.grade)
  return { ...checked.grade, verdict, correct: verdict === 'correct', partial: verdict === 'partial' }
}

// An earlier answer to a question a check fixed, graded again with `grade`,
// the teacher's new grade of that answer against the fixed question. score:
// what it was given at the time. A wrong question's answers take the new
// grade either way; an unclear one's only gain (an answer marked wrong may
// have been right under the reading the question allowed then). Returns
// { score, correct, errorTag }, or null when the grade stays — including when
// no new grade was given, since the machine no longer grades anything itself.
export function earlierGrade(item, response, { verdict, score, grade = null }) {
  if (verdict !== 'wrong' && verdict !== 'unclear') return null
  if (!grade || !Number.isFinite(Number(grade.score))) return null
  const value = Math.min(1, Math.max(0, Number(grade.score)))
  const correct = verdictOf(grade) === 'correct'
  const next = { score: value, correct, errorTag: correct ? '' : text(grade.errorTag, 80) }
  const before = Math.min(1, Math.max(0, Number(score) || 0))
  if ((verdict === 'unclear' && next.score <= before) || Math.abs(next.score - before) < 1e-6) return null
  return next
}
