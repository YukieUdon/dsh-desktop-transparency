/**
 * The `boot` rendering, which is the command a user runs when the plugin's own work is
 * invisible to them: the Host half runs inside the app, its console goes nowhere, and this
 * record is the only account of what it decided.
 *
 * It is read by someone who is already confused, so it has to be exactly right — and it was
 * not. `record.verdictAtBoot ?? record.installed === false ? … : …` binds as
 * `(verdictAtBoot ?? (installed === false)) ? … : …`, so every non-empty verdict, `patched`
 * included, printed as "no installation". That is the single most misleading line this
 * command can produce, and nothing failed when it was written.
 *
 * `main()` reads `process.argv` and writes to the console, so both are stubbed here: the
 * unit under test is the rendering, not the argument parsing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { main } from '../lib/cli.mjs'

function tempDir(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `dsh-cli-${label}-`))
}

/** Runs `main()` with a stubbed argv and console, and returns the printed lines. */
async function runCli(argv) {
  const realArgv = process.argv
  const realLog = console.log
  const lines = []
  try {
    process.argv = [realArgv[0], path.join('lib', 'cli.mjs'), ...argv]
    console.log = (line) => lines.push(String(line))
    await main()
  } finally {
    process.argv = realArgv
    console.log = realLog
  }
  return lines
}

/** Writes a boot record the way the Host half does, then renders it. */
async function renderBoot(label, record) {
  const dir = tempDir(label)
  try {
    fs.writeFileSync(path.join(dir, 'last-boot.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return await runCli(['boot', '--state-dir', dir])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function lineStarting(lines, prefix) {
  return lines.find((line) => line.trimStart().startsWith(prefix))
}

test('boot reports the recorded verdict, including patched', async () => {
  const lines = await renderBoot('patched', {
    patchVersion: '1.0.1',
    at: '2026-10-09T13:43:36.542Z',
    installed: true,
    verdictAtBoot: 'patched',
    action: 'none',
    reason: 'already patched',
  })
  assert.equal(lineStarting(lines, 'at boot'), '  at boot   : patched')
  assert.equal(lineStarting(lines, 'action'), '  action    : none')
  assert.equal(lineStarting(lines, 'reason'), '  reason    : already patched')
})

test('boot says "no installation" only when the record says so', async () => {
  const missing = await renderBoot('missing', { patchVersion: '1.0.1', installed: false, verdictAtBoot: null, action: 'none' })
  assert.equal(lineStarting(missing, 'at boot'), '  at boot   : no installation')

  // No verdict and no "not installed" either: honest, not a guess.
  const silent = await renderBoot('silent', { patchVersion: '1.0.1', action: 'error' })
  assert.equal(lineStarting(silent, 'at boot'), '  at boot   : unknown')
})

test('boot without a record says there is none, rather than rendering an empty one', async () => {
  const dir = tempDir('none')
  try {
    const lines = await runCli(['boot', '--state-dir', dir])
    assert.deepEqual(lines, ['No boot record yet — the plugin has not run on this machine.'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
