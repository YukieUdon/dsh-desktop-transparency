/**
 * Guards the fixture against the failure that hides in every test suite built on
 * string anchors: a fixture that no longer contains an anchor, so the test passes
 * while exercising nothing.
 *
 * These checks are cheap and they run on the strings the patcher actually uses.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnoseEdits, resolveEdits } from '../lib/patch-rules.mjs'
import { FIXTURE_ANCHORS, syntheticMainJs, syntheticMainJsPatchable } from './synthetic-asar.mjs'

test('the fixture anchors are exactly the anchors the patcher uses', () => {
  const edits = resolveEdits()
  const byId = Object.fromEntries(edits.map((edit) => [edit.id, edit.find]))
  assert.equal(FIXTURE_ANCHORS.spread, byId['transparent-window'])
  assert.equal(FIXTURE_ANCHORS.titlebar, byId['titlebar-repaint'])
  assert.equal(FIXTURE_ANCHORS.createWindow, byId['transparency-stylesheet'])
  assert.equal(FIXTURE_ANCHORS.windowOpen, byId['install-stylesheet'])
})

test('the fixture contains every anchor exactly once', () => {
  const text = syntheticMainJs()
  for (const edit of resolveEdits()) {
    const hits = text.split(edit.find).length - 1
    assert.equal(hits, 1, `anchor "${edit.id}" appears ${hits} time(s) in the fixture, expected 1`)
  }
})

test('every edit still applies when the edits run in order', () => {
  const findings = diagnoseEdits(syntheticMainJs())
  const failing = findings.filter((finding) => !finding.ok)
  assert.deepEqual(failing, [], `edits that would not apply: ${JSON.stringify(failing)}`)
})

test('the padded fixture keeps every anchor intact', () => {
  const text = syntheticMainJsPatchable()
  for (const edit of resolveEdits()) {
    assert.equal(text.split(edit.find).length - 1, 1, `padding broke anchor "${edit.id}"`)
  }
})
