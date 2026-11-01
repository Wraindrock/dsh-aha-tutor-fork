// What one answer to a question means — decided by the teacher, not by a
// comparison. Whether an answer is right, half right or wrong is a judgement
// about what the learner understood: two answers can say the same thing in
// different words, a formula can be written three ways, and an answer can be
// half there for a reason the key cannot see. No string comparison, no
// key matching, no number parsing settles that here.
//
// So the grade is only ever the model's, arrived at after reading the
// question, its key and the answer. This module holds the shape a grade has
// and the one place a learner-visible verdict name comes from; the model
// supplies the thinking.

// How an answer came out, as the model judged it.
export const VERDICTS = Object.freeze(['correct', 'partial', 'incorrect'])

// The verdict of a grade, from what the teacher returned. A grade that names
// no verdict keeps whatever the score implies, so a terse model answer still
// lands somewhere honest.
export function verdictOf(graded) {
  if (VERDICTS.includes(graded?.verdict)) return graded.verdict
  const score = Number(graded?.score)
  if (!Number.isFinite(score)) return 'incorrect'
  return score >= 0.8 ? 'correct' : score >= 0.4 ? 'partial' : 'incorrect'
}

const clean = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

// One grade, in the shape the classroom, the practice screen and the mastery
// model all read. `gave` is the answer as it was given (an option id, a list,
// or text), kept so the lesson can answer that answer.
export function normalizeGrade(raw, { gave = '', kinds = ['correct', 'partial', 'incorrect'] } = {}) {
  const verdict = kinds.includes(raw?.verdict) ? raw.verdict : verdictOf(raw)
  const score = Number.isFinite(Number(raw?.score))
    ? Math.min(1, Math.max(0, Number(raw.score)))
    : verdict === 'correct' ? 1 : verdict === 'partial' ? 0.5 : 0
  return {
    verdict,
    score,
    correct: verdict === 'correct',
    partial: verdict === 'partial',
    feedback: clean(raw?.feedback, 1200),
    errorTag: clean(raw?.errorTag, 80),
    misconception: raw?.misconception === true,
    // A written-out working also names the first line that went wrong.
    ...(raw?.wrongStep !== undefined ? { wrongStep: clean(raw.wrongStep, 400), why: clean(raw.why, 400), fix: clean(raw.fix, 400) } : {}),
    given: gave,
  }
}

// The i18n key of each verdict, for the line above the teacher's own words.
export const VERDICT_KEYS = Object.freeze({ correct: 'correct', partial: 'partial', incorrect: 'incorrect' })
