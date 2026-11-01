import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeGrade, verdictOf, VERDICT_KEYS } from '../src/core/answer-grade.js'
import { coachMove } from '../src/core/check-response.js'
import { applyEvidence, createConceptState, masteryLevel, masteryPercent, masteryStage, recommendNext, stageForPercent, summarizeForPrompt } from '../src/core/mastery.js'
import { createCard, dueCards, gradeFromScore, review } from '../src/core/srs.js'

test('a confident correct answer raises mastery more than a lucky guess', () => {
  const base = createConceptState('cpt_a', 'limits')
  const sure = applyEvidence(base, { kind: 'check', score: 1, confidence: 'sure' })
  const guess = applyEvidence(base, { kind: 'check', score: 1, confidence: 'guess' })
  assert.ok(sure.pKnown > guess.pKnown)
  assert.ok(guess.pKnown > base.pKnown)
  assert.equal(guess.fragile, 1)
  assert.equal(sure.fragile, 0)
})

test('a confident mistake is recorded as a misconception and triggers remediation', () => {
  let state = createConceptState('cpt_b', 'chain rule')
  state = applyEvidence(state, { kind: 'practice', score: 0, confidence: 'sure', errorTag: 'forgot inner derivative' })
  assert.deepEqual(state.misconceptions, ['forgot inner derivative'])
  assert.equal(recommendNext([state]).action, 'remediate')
  assert.equal(recommendNext([state]).reason, 'misconception')
})

test('hints and hesitation weaken the evidence of a correct answer', () => {
  const base = createConceptState('cpt_c', 'x')
  const clean = applyEvidence(base, { score: 1 })
  const hinted = applyEvidence(base, { score: 1, hintsUsed: 2, timeMs: 90_000, expectedMs: 20_000 })
  assert.ok(clean.pKnown > hinted.pKnown)
})

test('repeated success reaches mastered and recommends a challenge', () => {
  let state = createConceptState('cpt_d', 'y')
  for (let index = 0; index < 8; index += 1) state = applyEvidence(state, { score: 1, confidence: 'sure' })
  assert.equal(masteryLevel(state), 'mastered')
  assert.ok(masteryPercent(state) >= 90)
  assert.equal(recommendNext([state]).action, 'challenge')
})

test('asking for another explanation lowers mastery slightly and blocks challenge', () => {
  let state = createConceptState('cpt_e', 'z')
  for (let index = 0; index < 8; index += 1) state = applyEvidence(state, { score: 1, confidence: 'sure' })
  const after = applyEvidence(state, { kind: 'reexplain' })
  assert.ok(after.pKnown < state.pKnown)
  assert.notEqual(recommendNext([after]).action, 'challenge')
})

test('history is bounded and the prompt summary lists weakest concepts first', () => {
  let weak = createConceptState('cpt_f', 'weak')
  let strong = createConceptState('cpt_g', 'strong')
  for (let index = 0; index < 80; index += 1) weak = applyEvidence(weak, { score: 0.2 })
  for (let index = 0; index < 5; index += 1) strong = applyEvidence(strong, { score: 1, confidence: 'sure' })
  assert.equal(weak.history.length, 50)
  const summary = summarizeForPrompt([strong, weak])
  assert.equal(summary[0].concept, 'weak')
  assert.throws(() => applyEvidence(weak, { score: 'abc' }), /score/)
})

test('five display stages start at "none" until there is any evidence', () => {
  assert.equal(masteryStage(undefined), 'none')
  const fresh = createConceptState('cpt_a', '配方')
  assert.equal(masteryStage(fresh), 'none', 'an untouched concept is not shown as weak')
  const once = applyEvidence(fresh, { kind: 'practice', score: 1, confidence: 'sure' })
  assert.notEqual(masteryStage(once), 'none')
  assert.equal(masteryStage(applyEvidence(fresh, { kind: 'self', rating: 1 })), 'weak', 'a self rating counts as evidence')
  assert.deepEqual([10, 40, 70, 90].map(stageForPercent), ['weak', 'learning', 'proficient', 'mastered'])
})

test('SM-2 review intervals grow with good answers and reset on again', () => {
  const now = Date.parse('2026-10-18T08:00:00Z')
  let card = createCard('c1', now)
  card = review(card, 'good', now)
  assert.equal(card.intervalDays, 1)
  card = review(card, 'good', now)
  assert.equal(card.intervalDays, 6)
  card = review(card, 'good', now)
  assert.ok(card.intervalDays >= 14)
  const lapsed = review(card, 'again', now)
  assert.equal(lapsed.reps, 0)
  assert.equal(lapsed.lapses, 1)
  assert.equal(Date.parse(lapsed.dueAt) - now, 10 * 60 * 1000)
  assert.ok(lapsed.ease >= 1.3)
  assert.deepEqual(dueCards([card, lapsed], now + 11 * 60 * 1000).map(item => item.id), ['c1'])
  assert.throws(() => review(card, 'perfect', now), /grade/)
  assert.equal(gradeFromScore(0.2), 'again')
  assert.equal(gradeFromScore(1, 'sure'), 'easy')
  assert.equal(gradeFromScore(0.9, 'guess'), 'hard')
})

test('a grade is the teacher\'s judgement, kept in one shape', () => {
  // The verdict is what the teacher said; a model that only gives a score
  // still lands somewhere honest, and "partly right" survives as itself.
  assert.equal(verdictOf({ verdict: 'partial' }), 'partial')
  assert.equal(verdictOf({ score: 1 }), 'correct')
  assert.equal(verdictOf({ score: 0.55 }), 'partial')
  assert.equal(verdictOf({ score: 0 }), 'incorrect')
  assert.equal(verdictOf({}), 'incorrect', 'no judgement at all never reads as right')
  assert.equal(verdictOf({ verdict: 'maybe' }), 'incorrect', 'an invented verdict is not taken')

  // "Half right" is a real outcome: a score and two flags that stay apart.
  const partial = normalizeGrade({ verdict: 'partial', score: 0.5, feedback: '方向对了，大小漏了单位。', errorTag: '缺单位' }, { gave: 'kT' })
  assert.deepEqual(
    { verdict: partial.verdict, score: partial.score, correct: partial.correct, partial: partial.partial, given: partial.given },
    { verdict: 'partial', score: 0.5, correct: false, partial: true, given: 'kT' },
  )
  assert.equal(partial.feedback, '方向对了，大小漏了单位。')
  // A terse model answer still yields a usable grade.
  const terse = normalizeGrade({ verdict: 'correct' })
  assert.deepEqual([terse.score, terse.correct, terse.partial, terse.feedback], [1, true, false, ''])
  assert.equal(normalizeGrade({ verdict: 'incorrect', score: 12 }).score, 1, 'a score outside 0..1 is clamped')
  // A written-out working names the line that went wrong.
  const work = normalizeGrade({ verdict: 'partial', score: 0.4, wrongStep: '$x=2$', why: '开平方只取正根', fix: '$x=\\pm 2$' })
  assert.deepEqual([work.wrongStep, work.fix], ['$x=2$', '$x=\\pm 2$'])
  assert.equal(VERDICT_KEYS.partial, 'partial')
})

test('the follow-up follows the teacher\'s verdict, not a comparison', () => {
  const wrong = { score: 0, correct: false, partial: false }
  const partial = { score: 0.5, correct: false, partial: true }
  const right = { score: 1, correct: true, partial: false }
  // Wrong: explain it again from what this answer shows they believe.
  assert.deepEqual(coachMove({ graded: wrong, response: 'k x' }), { kind: 'reteach' })
  // Half there: supply exactly the missing piece.
  assert.deepEqual(coachMove({ graded: partial, response: '方向相反，但' }), { kind: 'repair' })
  // Right: no aside, the card says so.
  assert.deepEqual(coachMove({ graded: right, response: '-kx' }), { kind: 'none' })
  // Nothing to work with, and a learner who keeps missing it.
  assert.deepEqual(coachMove({ graded: wrong, response: '  ' }), { kind: 'none' })
  assert.deepEqual(coachMove({ graded: wrong, response: 'k x', attempts: 3 }), { kind: 'none' })
  assert.deepEqual(coachMove({ graded: wrong, response: 'k x', attempts: 2 }), { kind: 'reteach' })
  assert.deepEqual(coachMove({}), { kind: 'none' })
})
