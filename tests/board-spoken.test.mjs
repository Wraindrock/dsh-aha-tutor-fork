import assert from 'node:assert/strict'
import { test } from 'node:test'

import { missingPhrases, silentOps, spokeAll, voiceSilentOps } from '../src/core/board-spoken.js'
import { normalizeBoard } from '../src/core/board-script.js'

// A lesson the model wrote without saying its headings, formula and figure.
const SILENT = {
  title: '回复力',
  steps: [
    { say: '我们来看这个公式。', ops: [{ t: 'h', text: '情景一：手推墙' }, { t: 'math', tex: 'F=-kx', text: 'F = -kx' }] },
    { say: '力总是成对出现。', ops: [{ t: 'note', text: '分别作用在两个物体上' }] },
    { say: '看这张表。', ops: [{ t: 'table', head: ['施力物体', '受力物体'], rows: [['手', '墙']] }] },
    { say: '这张图画的是手推墙。', ops: [{ t: 'svg', svg: '<svg viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg"><line x1="20" y1="20" x2="200" y2="200" stroke="#2b2b2b"/></svg>', caption: '手推墙与墙推手' }] },
  ],
}

test('a board item left unsaid is appended to that step\'s narration', () => {
  const board = normalizeBoard(SILENT)
  // Nothing on the board is silent any more.
  assert.deepEqual(silentOps(board.steps), [])
  assert.equal(spokeAll(board.steps), true)

  const first = board.steps[0].say
  assert.match(first, /我们来看这个公式。/u, 'what the model said is kept, in its place')
  assert.match(first, /情景一：手推墙/u, 'the heading is now said')
  assert.match(first, /F = -kx/u, 'and the formula is read')
  assert.match(board.steps[1].say, /力总是成对出现。分别作用在两个物体上/u)
  assert.match(board.steps[2].say, /施力物体/u, 'a table is read out')
  assert.match(board.steps[2].say, /^看这张表。/u, 'the model\'s sentence is kept, the table is read after it')
  assert.match(board.steps[3].say, /手推墙与墙推手/u, 'so is a figure caption')
})

test('a step that already says its board is left exactly as written', () => {
  const spoken = { steps: [{ say: '情景一：手推墙。这里的力是 F = -kx。', ops: [{ t: 'h', text: '情景一：手推墙' }, { t: 'math', tex: 'F=-kx', text: 'F = -kx' }] }] }
  assert.deepEqual(normalizeBoard(spoken).steps[0].say, '情景一：手推墙。这里的力是 F = -kx。')
  assert.equal(voiceSilentOps(spoken.steps[0]), spoken.steps[0].say)
})

test('the comparison is forgiving about spacing, punctuation and width', () => {
  const op = { t: 'math', tex: 'F=-kx', text: 'F = -kx' }
  // Written differently, said the same: not missing.
  for (const said of ['F 等于负的 k x', 'F=-kx', 'Ｆ＝－ｋｘ', 'f 等于 负 k x']) {
    assert.deepEqual(missingPhrases(op, said), [], said)
  }
  // Never said at all: missing.
  assert.ok(missingPhrases(op, '这是回复力').length)
  // A lone symbol is not a phrase a learner needs said.
  assert.deepEqual(missingPhrases({ t: 'p', text: 'k' }, ''), [])
  // Ops with no words of their own are not checked.
  for (const t of ['col', 'page', 'mark']) assert.deepEqual(missingPhrases({ t }, ''), [])
})

test('a runaway board cannot turn one step into an essay', () => {
  const ops = Array.from({ length: 12 }, (_, index) => ({ t: 'p', text: `第${index + 1}条要记住的结论，写得比较长一些` }))
  const say = voiceSilentOps({ say: '看这几条。', ops }, { maxAppend: 60 })
  assert.ok([...say].length < 140, `appended text stays bounded, got ${[...say].length}`)
  assert.match(say, /^看这几条。/u)
})

test('a sentence that already ended is not ended twice', () => {
  // The heading's words were already said, so nothing is appended — and a
  // sentence that ends in "？" is never given a "。" after it.
  const said = normalizeBoard({ steps: [{ say: '那为什么你没掉下去？', ops: [{ t: 'h', text: '为什么' }] }] }).steps[0].say
  assert.equal(said, '那为什么你没掉下去？')
  const appended = normalizeBoard({ steps: [{ say: '注意这一点？', ops: [{ t: 'h', text: '成对出现' }] }] }).steps[0].say
  assert.equal(appended, '注意这一点？成对出现。', 'no doubled stop after a question')
  assert.doesNotMatch(appended, /。{2}|？。/u)
})

test('a table walked through in prose is not read out again', () => {
  const say = '我把这个情景整理成一张表，第一行是施力物体、受力物体、方向；手推墙那一列是手、墙、向右；墙推手那一列是墙、手、向左。'
  const board = normalizeBoard({ steps: [{ say, ops: [{ t: 'table', head: ['施力物体', '受力物体', '方向'], rows: [['手', '墙', '向右'], ['墙', '手', '向左']] }] }] })
  assert.equal(board.steps[0].say, say, 'saying the columns and the cells is enough')
  // A table nobody mentioned is still read out.
  const silent = normalizeBoard({ steps: [{ say: '看这里。', ops: [{ t: 'table', head: ['甲', '乙'], rows: [['一', '二']] }] }] })
  assert.match(silent.steps[0].say, /甲/u)
})

test('a formula is never read to the learner as LaTeX source', () => {
  const board = normalizeBoard({ steps: [{ say: '算一下。', ops: [{ t: 'math', tex: '|F| = 100\\ \\text{N}' }] }] })
  assert.doesNotMatch(board.steps[0].say, /\\text|\\ |\{/u, 'no markup is spoken')
  assert.match(board.steps[0].say, /100/u)
  // A board that carries its own plain reading says that.
  const readable = normalizeBoard({ steps: [{ say: '算一下。', ops: [{ t: 'math', tex: 'F=-kx', text: 'F = −kx' }] }] })
  assert.match(readable.steps[0].say, /F = −kx/u)
})

test('a sentence interrupted by a formula still counts as said', () => {
  // Real narration: "原因：$a=F/m$，地球质量太大。" — the formula in the middle
  // must not hide the words around it.
  const op = { t: 'p', text: '原因：$a=F/m$，地球质量太大' }
  assert.deepEqual(missingPhrases(op, '……原因：$a=F/m$，地球质量太大。'), [])
  assert.deepEqual(missingPhrases(op, '原因是 $a=F/m$，地球质量太大。'), [])
  // Said in other words, most of the line is there: a long sentence is not
  // held to the same wording as a short label.
  assert.deepEqual(missingPhrases(op, '原因在于加速度是 $a=F/m$，而地球质量太大。'), [])
  // A sentence that never says the point is still missing.
  assert.ok(missingPhrases(op, '因为苹果熟了。').length)
})

test('a step with no narration at all still gets its board said', () => {
  const board = normalizeBoard({ steps: [{ say: '', ops: [{ t: 'h', text: '开头' }] }] })
  assert.equal(board.steps[0].say, '开头。')
})
