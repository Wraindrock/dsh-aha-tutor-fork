// What the teacher does after a check. A check is a question in the middle
// of a lesson; its grade is only half the answer. What the learner gets next
// depends on what they wrote:
//
//   right      the card says so and the lesson goes on
//   partial    the idea is half there: the teacher finishes the missing part
//   wrong      a re-teach at the board, aimed at the answer actually given
//   blank      nothing to respond to; the lesson reads the key out and goes on
//
// Only checks on a lesson board reach here: practice and quiz questions have
// their own screen. Pure logic, so the classroom and the tests share it.

import { gradeObjective, parseAnswerNumber } from './grading.js'

// What answering this check needs from the host:
//   'grade'   an open answer: only the model can tell whether it is right
//   'coach'   a typed answer the key called wrong: the teacher should read it,
//             because it may be right in other words, and a genuinely wrong
//             one still deserves an explanation of *that* mistake
//   'none'    a picked option, or the right answer: the key's grade stands
export function checkNeeds(item, graded, response) {
  if (!item) return 'none'
  if (item.kind === 'short' || item.kind === 'work') return 'grade'
  const given = String(response ?? '').trim()
  if (!given) return 'none'
  if (!graded || graded.gradable === false) return 'none'
  if (graded.correct) return 'none'
  // A blank is words by nature; a number is a figure, so only one written in
  // words ("about four", "4 N" where the key holds 4) needs reading.
  if (item.kind === 'blank') return 'coach'
  if (item.kind === 'number' && !Number.isFinite(parseAnswerNumber(given))) return 'coach'
  return 'none'
}

// The tutor's move after a grade: { kind } where kind is 'reteach' (a new
// explanation at the board, aimed at this answer), 'repair' (finish the
// missing part) or 'none'.
//   attempts: how many times the learner has answered this same check
// A right answer needs no aside: the card says so and the lesson goes on.
export function coachMove({ graded, response, attempts = 1 } = {}) {
  const text = String(response ?? '').trim()
  if (!text || !graded) return { kind: 'none' }
  if (graded.correct) return { kind: 'none' }
  // A learner who keeps missing the same question is not re-taught a fourth
  // time: the key and the lesson have to carry it from there.
  if (attempts >= 3) return { kind: 'none' }
  if (graded.partial || (Number(graded.score) > 0 && Number(graded.score) < 1)) return { kind: 'repair' }
  // A working is corrected line by line at the board by the correction flow,
  // which runs before this one.
  return { kind: 'reteach' }
}

// The grade a check starts with on the client: objective kinds are settled
// here, open ones are sent to the host (see checkNeeds).
export function instantGrade(item, response) {
  if (!item) return null
  return gradeObjective(item, response)
}

