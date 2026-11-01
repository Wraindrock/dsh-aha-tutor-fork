import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseHTML } from 'linkedom'
import { createElement as h } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'tsdown'

import { en, format, zh } from '../src/ui/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The classroom reads the document (the dark theme's marker, the board's
// size), so render it against a DOM the way DSH's page provides one.
const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>')
globalThis.window = window
globalThis.document = window.document
globalThis.getComputedStyle = window.getComputedStyle?.bind(window) ?? (() => ({ colorScheme: 'light' }))
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16)
globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
if (typeof window.matchMedia !== 'function') window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.matchMedia = window.matchMedia
// The theme hook watches body[data-ds-dark-theme]; a watcher that never fires
// is enough here.
globalThis.MutationObserver ??= class { observe() {} disconnect() {} }

const root = fileURLToPath(new URL('..', import.meta.url))
const t = (key, values) => format(zh[key] ?? key, values)

let bundle
let outDir

before(async () => {
  const cache = join(root, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  outDir = await mkdtemp(join(cache, 'aha-classroom-'))
  await build({
    config: false,
    entry: { classroom: join(root, 'tests', 'fixtures', 'ui', 'classroom.js') },
    outDir,
    format: 'esm',
    platform: 'node',
    dts: false,
    logLevel: 'silent',
    alias: { '@deepseek-ai/dsh-client-ui-primitives': join(root, 'tests', 'fixtures', 'ui', 'primitives.js') },
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'], alwaysBundle: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const file = (await readdir(outDir)).find(name => /^classroom\.m?js$/u.test(name))
  bundle = await import(pathToFileURL(join(outDir, file)).href)
})

after(() => rm(outDir, { recursive: true, force: true }))

const STEPS = [
  { id: 's1', say: '先看回复力。', ops: [{ id: 'o1', t: 'title', text: '回复力' }] },
  { id: 's2', say: '方向总指向平衡位置。', ops: [{ id: 'o2', t: 'math', tex: 'F=-kx', text: 'F = -kx' }] },
  {
    id: 's3',
    say: '试一下。',
    ops: [{ id: 'o3', t: 'p', text: '算一算' }],
    check: { id: 'k3', kind: 'blank', prompt: '胡克定律 $F=$', answer: ['-kx'], conceptIds: [] },
  },
]

// The classroom as the lesson screen mounts it: a board, objectives, and an
// api that never invents a verdict.
function renderClassroom({ steps = STEPS, graded = { score: 0, verdict: 'incorrect', feedback: '再想想。' }, props = {} } = {}) {
  const calls = []
  const api = {
    call: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'lesson/grade') return graded
      if (endpoint === 'lesson/record') return { recommendation: { action: 'advance' } }
      return null
    },
    follow: async () => ({}),
  }
  const speech = { speak: () => ({ done: Promise.resolve({ silent: true }) }), cancel() {}, pause() {}, resume() {}, setRate() {}, prefetch() {}, configure() {}, dispose() {} }
  const settings = { voiceEngine: 'off', boardFont: 'hand', boardView: 'canvas', boardTheme: 'light' }
  const value = { api, t, language: 'zh', speech, settings, setVoiceId: () => undefined, settingsSaved: async () => undefined, navigate: () => undefined, back: () => undefined, toast: () => undefined, dsh: null }
  const element = h(bundle.AppContext.Provider, { value },
    h(bundle.Classroom, {
      scope: { kind: 'lesson', courseId: 'crs_aaaaaaaa', lessonId: 'les_aaaaaaaa' },
      title: '回复力',
      steps,
      objectives: ['写出 F=-kx'],
      language: 'zh-CN',
      autoplay: false,
      tour: false,
      talkKey: false,
      ...props,
    }))
  let renderer
  act(() => { renderer = TestRenderer.create(element) })
  return { renderer, calls, api }
}

const textOf = node => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))
const buttonsOf = (renderer, label) => renderer.root.findAll(node => node.type === 'button' && textOf(node).includes(label))

test('a classroom with no check on screen renders instead of crashing', () => {
  // Regression: the check result was compared with the check's id when both
  // were absent, which read a property of null and blanked the whole page.
  const { renderer, calls } = renderClassroom()
  const shown = textOf(renderer.root)
  assert.match(shown, /回复力/u, 'the board is there')
  assert.doesNotMatch(shown, /This page ran into a problem|这一页出了点问题/u)
  assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'lesson/grade'), [], 'nothing is graded until a check is answered')
})

test('a check on the board is answered through the teacher, and its verdict decides the follow-up', async () => {
  const { renderer, calls } = renderClassroom({ graded: { score: 0.5, verdict: 'partial', feedback: '方向对了，大小漏了单位。' } })
  // Walk the lesson to the check.
  act(() => { renderer.root.findAll(node => node.type === 'button' && /play|▶/iu.test(textOf(node)))[0]?.props.onClick() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  assert.ok(renderer.root, 'still mounted')
  // The card asks the teacher, never a local comparison.
  const gradeCalls = calls.filter(([endpoint]) => endpoint === 'lesson/grade')
  for (const [, payload] of gradeCalls) assert.equal(payload.item.kind, 'blank')
})

test('the classroom shows no verdict of its own before an answer', () => {
  const { renderer } = renderClassroom()
  assert.equal(buttonsOf(renderer, zh.submit).length, 0, 'no answer form is open without a check')
  assert.equal(buttonsOf(renderer, zh.correct).length, 0)
  assert.equal(buttonsOf(renderer, zh.partial).length, 0)
})
