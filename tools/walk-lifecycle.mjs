/**
 * Reproduce the operations lifecycle by hand against a temp fake install, printing
 * every result. Used while bringing the module up; kept because a lifecycle bug is
 * easier to read here than in test output.
 *
 * Usage: node tools/walk-lifecycle.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyPatch, restoreOfficial, status, verifyPatch } from '../lib/operations.mjs'
import { buildSyntheticAsar, PATCHABLE_BLOCK_SIZE, syntheticMainJsPatchable } from '../test/synthetic-asar.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fake-install-'))
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fake-state-'))
fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), '')
const original = buildSyntheticAsar([
  { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
  { path: 'package.json', content: '{"name":"fake"}' },
])
const asar = path.join(root, 'resources', 'app.asar')
fs.writeFileSync(asar, original)

const options = { dshRoot: root, stateDir }
console.log('fake install :', root)
console.log('state dir    :', stateDir)
console.log('official size:', original.length, '\n')

console.log('status before  :', JSON.stringify(await status(options), null, 1), '\n')

const applied = await applyPatch(options)
console.log('applyPatch     :', JSON.stringify({ ...applied, diagnostics: undefined }, null, 1), '\n')

console.log('status after   :', JSON.stringify(await status(options), null, 1), '\n')
console.log('verifyPatch    :', JSON.stringify(await verifyPatch(options), null, 1), '\n')

const second = await applyPatch(options)
console.log('apply again    :', JSON.stringify({ applied: second.applied, reason: second.reason }, null, 1), '\n')

const restored = await restoreOfficial(options)
console.log('restoreOfficial:', JSON.stringify(restored, null, 1))
console.log('file equals original:', fs.readFileSync(asar).equals(original))

console.log('\nleftover temp files:', fs.readdirSync(path.join(root, 'resources')).join(', '))
