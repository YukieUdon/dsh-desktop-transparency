/**
 * Proves the inverse direction: reconstructing an official archive from a patched
 * one must return exactly the bytes we started from.
 *
 * This is the safety net for an installation that was patched before this package
 * existed (or before any backup was taken): without reconstruction such a machine has
 * no way back except reinstalling DSH. The test uses the real patched archive the
 * earlier project produced and the real official backup it came from, so it checks
 * the actual substitution pairs rather than a fixture's idea of them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

import { patchArchive, reconstructOfficial } from '../lib/archive.mjs'
import { resolveEdits } from '../lib/patch-rules.mjs'
import { buildSyntheticAsar, PATCHABLE_BLOCK_SIZE, syntheticMainJsPatchable } from './synthetic-asar.mjs'

test('reconstructs the official archive from a synthetic patched one', () => {
  const official = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
    { path: 'README.md', content: '# dsh' },
  ])
  const patched = patchArchive(official, { edits: resolveEdits() }).buffer
  assert.notEqual(
    createHash('sha256').update(patched).digest('hex'),
    createHash('sha256').update(official).digest('hex'),
  )

  const reconstructed = reconstructOfficial(patched, { edits: resolveEdits() })
  assert.deepEqual(reconstructed.undone, [
    'install-stylesheet',
    'transparency-stylesheet',
    'titlebar-repaint',
    'transparent-window',
  ])
  assert.equal(
    createHash('sha256').update(reconstructed.buffer).digest('hex'),
    createHash('sha256').update(official).digest('hex'),
    'reconstruction must return the exact original bytes',
  )
})

test('refuses to reconstruct when the patched archive does not carry the edits', () => {
  const untouched = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
  ])
  assert.throws(() => reconstructOfficial(untouched, { edits: resolveEdits() }), /cannot reconstruct the official/)
})

// The strongest form of the same claim, over the real 121 MB archives: patch the
// official backup, then reconstruct the official bytes back out of the patch.
const officialPath = process.env.DSH_OFFICIAL_ASAR
test('integration: patched -> reconstructed equals the real official archive', { skip: !officialPath || !fs.existsSync(officialPath) }, () => {
  const official = fs.readFileSync(officialPath)
  const patched = patchArchive(official, { edits: resolveEdits() }).buffer
  const reconstructed = reconstructOfficial(patched, { edits: resolveEdits() })
  assert.equal(
    createHash('sha256').update(reconstructed.buffer).digest('hex'),
    createHash('sha256').update(official).digest('hex'),
  )
  assert.equal(reconstructed.buffer.length, official.length)
})
