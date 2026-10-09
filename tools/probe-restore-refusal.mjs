/**
 * probe-restore-refusal.mjs — show exactly what `restoreOfficial` returns while the app
 * is "running" according to an injected probe.
 *
 * Usage: node tools/probe-restore-refusal.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyPatch, restoreOfficial } from '../lib/operations.mjs'
import { buildSyntheticAsar, PATCHABLE_BLOCK_SIZE, syntheticMainJsPatchable } from '../test/synthetic-asar.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-refuse-'))
const state = path.join(root, 'state')
fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), '')
fs.writeFileSync(
  path.join(root, 'resources', 'app.asar'),
  buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE }]),
)

const running = { run: () => '4321\r\n' }

const applied = await applyPatch({ dshRoot: root, stateDir: state, allowRunning: false, ...running })
console.log('applyPatch :', JSON.stringify({ applied: applied.applied, appRunning: applied.appRunning, reason: applied.reason }, null, 1))

const restored = await restoreOfficial({ dshRoot: root, stateDir: state, allowRunning: false, ...running })
console.log('restore    :', JSON.stringify(restored, null, 1))

console.log('\nstate dir exists:', fs.existsSync(state), fs.existsSync(state) ? fs.readdirSync(state) : '(none)')
