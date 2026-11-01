// What the teacher does after a check. A check is a question in the middle
// of a lesson; the grade is the teacher's reading of the answer, and what
// comes next follows that reading:
//
//   right      the card says so and the lesson goes on
//   partial    the idea is half there: the teacher finishes the missing part
//   wrong      a re-teach at the board, aimed at the answer actually given
//   blank      nothing to respond to; the lesson reads the key out and goes on
//
// Nothing here decides whether an answer is right — that is the model's
// judgement (see core/answer-grade.js). This only decides what to do with a
// verdict once the teacher has given one.

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
  // "Partly right" is a real place to be, and the most useful thing to do
  // with it is finish it rather than explain the whole idea again.
  if (graded.partial || (Number(graded.score) > 0 && Number(graded.score) < 1)) return { kind: 'repair' }
  // A working is corrected line by line at the board by the correction flow,
  // which runs before this one.
  return { kind: 'reteach' }
}
