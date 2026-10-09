/**
 * Lifecycle tests. They run against a synthetic archive in a temp directory, never
 * against a real DSH install: the parts that can silently corrupt an installation
 * are the write path, the classification and the refusal paths, and all three are
 * reachable with a fake archive because `diagnoseEdits` only looks at the text of
 * `lib/main.js`.
 *
 * Every test builds its own installation and its own state directory. That is not
 * tidiness: the module's whole subject is state that survives between calls
 * (backups, the artifact, a patched archive), so a test that inherited those from
 * an earlier one would pass or fail depending on which tests were selected. With
 * `--test-name-pattern` a shared fixture reports a different answer than the full
 * run, which is exactly the bug this layout prevents.
 *
 * The fixture's anchors are the real ones (`FIXTURE_ANCHORS` in `synthetic-asar.mjs`
 * exists for exactly that), so a happy path here exercises the same substitution
 * order a real archive does. Refusals are built by *deleting* one of those anchors,
 * never by re-spelling one.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sha256 } from '../lib/archive.mjs'
import {
  KNOWN_ARCHIVES,
  applyPatch,
  classifyArchive,
  listBackups,
  restoreOfficial,
  status,
  verifyPatch,
} from '../lib/operations.mjs'
import { inspectDshRoot } from '../lib/detect.mjs'
import { buildSyntheticAsar, FIXTURE_ANCHORS, PATCHABLE_BLOCK_SIZE, syntheticMainJsPatchable } from './synthetic-asar.mjs'

const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-ops-'))

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

/**
 * `lib/main.js` text whose anchors all diagnose clean, at the block size that keeps
 * the patched entry inside a single integrity block.
 */
function patchableMainJs() {
  return syntheticMainJsPatchable()
}

/**
 * The same text with one real anchor deleted — the shape of an archive whose DSH
 * version moved on. Only that anchor is removed, so a report that blames any other
 * edit is a real bug rather than a fixture artefact.
 */
function staleMainJs() {
  return patchableMainJs().replace(FIXTURE_ANCHORS.titlebar, '')
}

/** Bytes shaped like an official archive: they are simply not in the known table. */
function archiveBytes(mainJs = patchableMainJs()) {
  return buildSyntheticAsar([
    { path: 'lib/main.js', content: mainJs, blockSize: PATCHABLE_BLOCK_SIZE },
    { path: 'package.json', content: '{"name":"dsh","version":"0.0.0-synthetic"}' },
  ])
}

let scenarioCount = 0

/**
 * One installation plus its own state directory, created per test.
 *
 * `install` writes and returns the official-shaped archive so a caller can keep the
 * bytes it expects to be restored to; the returned `scenario` always answers with
 * the *current* file, never a stale copy.
 */
function newScenario({ bytes = archiveBytes(), label = 'case' } = {}) {
  scenarioCount += 1
  const base = path.join(tempRoot, `${String(scenarioCount).padStart(2, '0')}-${label}`)
  const root = path.join(base, 'install')
  const state = path.join(base, 'state')
  const asarPath = path.join(root, 'resources', 'app.asar')
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), '')
  fs.writeFileSync(asarPath, bytes)
  const original = fs.readFileSync(asarPath)
  return {
    base,
    root,
    state,
    asarPath,
    original,
    originalHash: sha256(original),
    /** The bytes installed right now. */
    installed: () => fs.readFileSync(asarPath),
    /**
     * `applyPatch`/`status`/... arguments for this installation.
     *
     * `allowRunning: true` is deliberate: the write paths refuse while DSH Desktop is
     * running (Windows will not replace a memory-mapped archive), and these tests run on
     * a machine where the app may well be running. Faking that away keeps them about the
     * write path itself. The refusal has its own test below, which injects the probe.
     *
     * `platform: 'win32'` for the same reason: the running-app refusal exists only on
     * Windows, so a default of "whatever this machine is" makes the suite mean different
     * things on different machines — on Linux the probe answers "not running" and the
     * three refusal tests failed. The code being tested is Windows-only; the tests say so.
     */
    args: (extra = {}) => ({ dshRoot: root, stateDir: state, allowRunning: true, platform: 'win32', ...extra }),
  }
}

/** Fails when an atomic write left a temp file in the target's directory. */
function noTempLeftovers(target) {
  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'an atomic write must not leave a temp file behind')
}

test('status reports an unpatched synthetic install as actionable and unknown', async () => {
  const scenario = newScenario({ label: 'status' })
  const result = await status(scenario.args())

  assert.equal(result.installed, true)
  assert.equal(result.verdict, 'unknown')
  assert.equal(result.actionable, true)
  assert.equal(result.size, scenario.original.length)
  assert.equal(result.sha256, scenario.originalHash)
  assert.equal(result.dshVersion, '0.0.0-synthetic')
  assert.match(result.note, /not in the verified set/)
  assert.equal(result.patchVersion, null)
  assert.deepEqual(result.backups, [])
  assert.equal(result.root, path.resolve(scenario.root))
  assert.equal(result.asarPath, scenario.asarPath)
})

test('status returns missing instead of throwing when there is no installation', async () => {
  const scenario = newScenario({ label: 'missing' })
  const result = await status({ dshRoot: path.join(scenario.base, 'nope'), stateDir: scenario.state })

  assert.equal(result.installed, false)
  assert.equal(result.verdict, 'missing')
  assert.equal(result.actionable, false)
  assert.equal(result.size, null)
  assert.equal(result.sha256, null)
  assert.match(result.note, /does not exist/)
})

test('status keeps its shape for an archive that is not an asar', async () => {
  const scenario = newScenario({ bytes: Buffer.from('not an asar'), label: 'not-asar' })
  const result = await status(scenario.args())

  assert.equal(result.installed, true)
  assert.equal(result.verdict, 'unknown')
  assert.equal(result.size, 11)
  assert.match(result.note, /not in the verified set/)
  assert.equal(result.dshVersion, null)
})

test('applyPatch then status then verifyPatch then restoreOfficial', async () => {
  const scenario = newScenario({ label: 'lifecycle' })

  const applied = await applyPatch(scenario.args())
  assert.equal(applied.applied, true)
  assert.equal(applied.root, path.resolve(scenario.root))
  assert.equal(applied.before.sha256, scenario.originalHash)
  assert.equal(applied.before.verdict, 'unknown')
  assert.ok(applied.after.size > applied.before.size)
  assert.notEqual(applied.after.sha256, scenario.originalHash)
  assert.equal(applied.restartRequired, true)
  assert.equal(sha256(scenario.installed()), applied.after.sha256, 'the installed bytes must verify')
  assert.equal(applied.backup.sha256, scenario.originalHash)
  assert.match(path.basename(applied.backup.file), /^app\.asar\.\d{8}-\d{6}/)
  assert.ok(fs.existsSync(applied.backup.file))
  assert.equal(fs.readFileSync(`${applied.backup.file}.sha256`, 'utf8').trim(), scenario.originalHash)
  assert.equal(applied.artifact, path.join(scenario.state, 'build', 'app-transparent.asar'))
  assert.ok(fs.existsSync(applied.artifact), 'the rollback artifact must exist even if DSH will not boot')
  assert.equal(sha256(fs.readFileSync(applied.artifact)), applied.after.sha256)
  assert.ok(applied.warnings.some((w) => /not in the verified set/.test(w)))
  noTempLeftovers(scenario.asarPath)

  const afterPatch = await status(scenario.args())
  assert.equal(afterPatch.verdict, 'patched')
  assert.equal(afterPatch.sha256, applied.after.sha256)
  assert.equal(afterPatch.actionable, false)
  assert.match(afterPatch.note, /carries the patch marker/)
  assert.equal(afterPatch.backups.length, 1)
  assert.equal(afterPatch.backups[0].file, applied.backup.file)
  assert.equal(afterPatch.backups[0].size, scenario.original.length)
  assert.equal(afterPatch.backups[0].sha256, scenario.originalHash)
  // Synthetic bytes are not the shipped archive, so the copy of them classifies as
  // 'unknown' — and it is still the right file to restore, which is why the
  // restore below is what proves the backup is faithful.
  assert.equal(afterPatch.backups[0].verdict, 'unknown')
  assert.ok(!Number.isNaN(Date.parse(afterPatch.backups[0].createdAt)), 'createdAt must be a real timestamp')

  const verified = await verifyPatch({ dshRoot: scenario.root })
  assert.equal(verified.patched, true)
  assert.equal(verified.markerPresent, true)
  assert.ok(verified.cssRules > 0)
  assert.equal(verified.dshVersion, '0.0.0-synthetic')
  const gating = verified.checks.filter((check) => !check.advisory)
  assert.ok(gating.every((check) => check.ok), JSON.stringify(gating.filter((check) => !check.ok)))
  // The synthetic shape is reported as not recorded, which is the advisory check's
  // whole job: it must not turn a working patch into `patched: false`.
  assert.equal(verified.checks.find((check) => check.name === 'knownArchive').ok, false)

  const restored = await restoreOfficial(scenario.args())
  assert.equal(restored.restored, true)
  assert.equal(restored.sha256, scenario.originalHash)
  assert.equal(restored.backupUsed, applied.backup.file)
  assert.deepEqual(scenario.installed(), scenario.original, 'a restore must be byte-identical')
  noTempLeftovers(scenario.asarPath)

  // The lifecycle must be repeatable: a restored installation is patchable again.
  const reapplied = await applyPatch(scenario.args())
  assert.equal(reapplied.applied, true)
  assert.equal(reapplied.after.sha256, applied.after.sha256, 'patching is deterministic')
})

test('applyPatch refuses to re-patch a patched archive without force', async () => {
  const scenario = newScenario({ label: 'already-patched' })
  const first = await applyPatch(scenario.args())
  assert.equal(first.applied, true)

  const second = await applyPatch(scenario.args())
  assert.equal(second.applied, false)
  assert.match(second.reason, /already patched/)
  assert.equal(second.after, null)
  assert.equal(second.restartRequired, false)
  assert.equal(second.backup, null)
  assert.equal(sha256(scenario.installed()), first.after.sha256, 'the refusal must leave the file alone')
  noTempLeftovers(scenario.asarPath)

  // The refusal must still be a refusal when the state directory is empty: there is
  // no backup to rebuild from, so overwriting would destroy the only copy.
  const bare = newScenario({ label: 'already-patched-bare' })
  assert.equal((await applyPatch(bare.args())).applied, true)
  fs.rmSync(bare.state, { recursive: true, force: true })
  const bareSecond = await applyPatch(bare.args())
  assert.equal(bareSecond.applied, false)
  assert.match(bareSecond.reason, /already patched/)
  noTempLeftovers(bare.asarPath)
})

test('force re-patches from the newest usable backup and never copies a patched archive', async () => {
  const scenario = newScenario({ label: 'force-backup' })
  const first = await applyPatch(scenario.args())
  assert.equal(first.applied, true)

  const beforeForce = await listBackups({ stateDir: scenario.state })
  const forced = await applyPatch(scenario.args({ force: true }))
  assert.equal(forced.applied, true)
  assert.equal(forced.after.sha256, first.after.sha256, 'rebuilding the same source must give the same bytes')
  assert.equal(forced.backup.sha256, scenario.originalHash)
  assert.ok(forced.warnings.some((w) => /re-patching from the official backup/.test(w)))

  const backups = await listBackups({ stateDir: scenario.state })
  assert.equal(backups.length, beforeForce.length, 'a force run must not add a backup of the patched archive')
  assert.equal(backups.filter((b) => b.verdict === 'patched').length, 0)
  for (const backup of backups) {
    assert.ok(!fs.readFileSync(backup.file).equals(scenario.installed()), `${backup.file} is a copy of the patched archive`)
  }

  const restore = await restoreOfficial(scenario.args({ backupFile: first.backup.file }))
  assert.equal(restore.restored, true)
  assert.deepEqual(scenario.installed(), scenario.original)
})

test('force on a patched archive with no backup rebuilds the official one first', async () => {
  // The state a machine patched by an older tool is in: the archive carries the
  // patch and there is no backup anywhere. The edits are deterministic
  // substitutions, so the official bytes are recovered by reversing them and stored
  // as a real backup — which is what keeps any later restore possible.
  const scenario = newScenario({ label: 'force-reconstruct' })
  const first = await applyPatch(scenario.args())
  assert.equal(first.applied, true)
  fs.rmSync(scenario.state, { recursive: true, force: true })

  const forced = await applyPatch(scenario.args({ force: true }))
  assert.equal(forced.applied, true)
  assert.equal(forced.after.sha256, first.after.sha256, 'the rebuilt patch must be the same patch')
  assert.ok(forced.warnings.some((w) => /no official backup existed; rebuilt the official archive/.test(w)))
  assert.match(forced.backup.file, /app\.asar\./)
  assert.ok(fs.existsSync(forced.backup.file))
  assert.equal(sha256(fs.readFileSync(forced.backup.file)), forced.backup.sha256)
  // The reconstructed restore point must be the official archive, not the patched one.
  assert.deepEqual(fs.readFileSync(forced.backup.file), scenario.original)
  assert.ok(!fs.readFileSync(forced.backup.file).includes('__dshDesktopTransparencyCss'))

  const listed = await listBackups({ stateDir: scenario.state })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].sha256, scenario.originalHash)

  const restored = await restoreOfficial(scenario.args({ backupFile: forced.backup.file }))
  assert.equal(restored.restored, true)
  assert.deepEqual(scenario.installed(), scenario.original)
  noTempLeftovers(scenario.asarPath)
})

test('an archive missing an anchor is refused, edit by edit', async () => {
  // One real anchor deleted: exactly a stale-archive shape. The refusal must name
  // the edit and leave the target untouched.
  const scenario = newScenario({ bytes: archiveBytes(staleMainJs()), label: 'stale-titlebar' })

  const result = await applyPatch(scenario.args())
  assert.equal(result.applied, false)
  assert.match(result.reason, /refusing to patch/)
  assert.ok(Array.isArray(result.diagnostics))
  const failed = result.diagnostics.filter((entry) => !entry.ok)
  assert.deepEqual(failed.map((entry) => entry.id), ['titlebar-repaint'])
  assert.match(result.reason, /titlebar-repaint/)
  assert.equal(result.after, null)
  assert.equal(result.restartRequired, false)
  assert.equal(result.artifact, null)
  assert.equal(result.backup, null)
  assert.deepEqual(scenario.installed(), scenario.original, 'a refusal must not touch the target')
  noTempLeftovers(scenario.asarPath)
})

test('applyPatch refuses an archive with no anchors at all and changes nothing', async () => {
  const scenario = newScenario({ bytes: archiveBytes('function createWindow() {}\n'), label: 'stale-empty' })

  const result = await applyPatch(scenario.args())
  assert.equal(result.applied, false)
  assert.match(result.reason, /refusing to patch/)
  const failed = result.diagnostics.filter((entry) => !entry.ok)
  assert.ok(failed.length > 0)
  assert.ok(failed.some((entry) => entry.id === 'transparent-window'))
  assert.match(result.reason, /transparent-window/)
  assert.equal(result.after, null)
  assert.deepEqual(scenario.installed(), scenario.original)
  noTempLeftovers(scenario.asarPath)
})

test('a build that cannot be verified leaves no temp file and no backup', async () => {
  // An anchor that matches twice gets past diagnosis and fails in the builder, so
  // this reaches the write path through the other route.
  const duplicated = `${patchableMainJs()}\n${patchableMainJs()}`
  const scenario = newScenario({ bytes: archiveBytes(duplicated), label: 'duplicate' })

  const result = await applyPatch(scenario.args())
  assert.equal(result.applied, false)
  assert.equal(result.backup, null, 'nothing was overwritten, so there is nothing to back up')
  assert.equal(result.artifact, null)
  assert.deepEqual(scenario.installed(), scenario.original)
  noTempLeftovers(scenario.asarPath)
  assert.equal(fs.existsSync(path.join(scenario.state, 'backups')), false)
})

test('verifyPatch is usable with no DSH installed and never throws', async () => {
  const scenario = newScenario({ label: 'no-install' })
  const result = await verifyPatch({ dshRoot: path.join(scenario.base, 'absent') })

  assert.equal(result.patched, false)
  assert.equal(result.size, null)
  assert.equal(result.sha256, null)
  assert.equal(result.markerPresent, false)
  assert.equal(result.cssRules, 0)
  assert.equal(result.checks.length, 1)
  assert.equal(result.checks[0].name, 'install')
  assert.equal(result.checks[0].ok, false)
  assert.match(result.checks[0].detail, /does not exist/)
})

test('verifyPatch on an official archive reports why it is not patched', async () => {
  const scenario = newScenario({ label: 'verify-official' })
  const result = await verifyPatch({ dshRoot: scenario.root })

  assert.equal(result.patched, false)
  assert.equal(result.root, path.resolve(scenario.root))
  assert.equal(result.asarPath, scenario.asarPath)
  assert.equal(result.size, scenario.original.length)
  assert.equal(result.sha256, scenario.originalHash)
  assert.equal(result.markerPresent, false)
  assert.equal(result.cssRules, 0)
  assert.equal(result.dshVersion, '0.0.0-synthetic')
  const marker = result.checks.find((check) => check.name === 'marker')
  assert.equal(marker.ok, false)
  assert.match(marker.detail, /not found/)
  assert.equal(result.checks.find((check) => check.name === 'install').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'esm').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'integrity').ok, true)
})

test('verifyPatch reports an unreadable archive instead of claiming a patch', async () => {
  const scenario = newScenario({ bytes: Buffer.from('definitely not an asar'), label: 'verify-broken' })
  const result = await verifyPatch({ dshRoot: scenario.root })

  assert.equal(result.patched, false)
  assert.equal(result.markerPresent, false)
  assert.equal(result.checks.find((check) => check.name === 'readable').ok, true)
  assert.equal(result.checks.find((check) => check.name === 'asar').ok, false)
  assert.ok(!result.checks.some((check) => check.name === 'marker'))
})

test('restoreOfficial reports a missing backup instead of throwing', async () => {
  const scenario = newScenario({ label: 'restore-missing' })
  const result = await restoreOfficial(scenario.args())

  assert.equal(result.restored, false)
  assert.equal(result.backupUsed, null)
  assert.equal(result.sha256, null)
  assert.match(result.reason, /no usable backup found/)
})

test('restoreOfficial honours an explicitly named backup and rejects a useless one', async () => {
  const scenario = newScenario({ label: 'restore-explicit' })
  const applied = await applyPatch(scenario.args())
  assert.equal(applied.applied, true)

  const explicit = await restoreOfficial(scenario.args({ backupFile: applied.backup.file }))
  assert.equal(explicit.restored, true)
  assert.equal(explicit.sha256, scenario.originalHash)
  assert.deepEqual(scenario.installed(), scenario.original)

  const already = await restoreOfficial(scenario.args({ backupFile: applied.backup.file }))
  assert.equal(already.restored, false)
  assert.match(already.reason, /already matches/)

  const missing = await restoreOfficial(scenario.args({
    backupFile: path.join(scenario.state, 'backups', 'app.asar.19700101-000000'),
  }))
  assert.equal(missing.restored, false)
  assert.match(missing.reason, /does not exist or cannot be read/)

  // A foreign copy is not a restore point: no sidecar digest, and its bytes are not
  // a known official archive. Saying so beats falling back to another file.
  const foreign = path.join(scenario.base, 'foreign.asar')
  assert.equal((await applyPatch(scenario.args())).applied, true)
  fs.copyFileSync(scenario.asarPath, foreign)
  const notRestorable = await restoreOfficial(scenario.args({ backupFile: foreign }))
  assert.equal(notRestorable.restored, false)
  assert.match(notRestorable.reason, /not a restore point/)
  assert.equal(sha256(scenario.installed()), sha256(fs.readFileSync(foreign)), 'the refusal must leave the patch in place')

  assert.equal((await restoreOfficial(scenario.args())).restored, true)
  assert.deepEqual(scenario.installed(), scenario.original)
})

test('restoreOfficial refuses a named backup nothing was written from', async () => {
  const scenario = newScenario({ label: 'restore-nothing-to-do' })
  const result = await restoreOfficial(scenario.args({ backupFile: path.join(scenario.base, 'not-here') }))

  assert.equal(result.restored, false)
  assert.match(result.reason, /does not exist or cannot be read/)
  assert.deepEqual(scenario.installed(), scenario.original)
})

test('listBackups is empty for a state directory that does not exist', async () => {
  const scenario = newScenario({ label: 'list-empty' })
  assert.deepEqual(await listBackups({ stateDir: path.join(scenario.base, 'never-created') }), [])
})

test('listBackups reports newest first with a usable timestamp', async () => {
  const scenario = newScenario({ label: 'list-order' })
  const first = await applyPatch(scenario.args())
  assert.equal(first.applied, true)
  const firstRestore = await restoreOfficial(scenario.args())
  assert.equal(firstRestore.restored, true)
  const second = await applyPatch(scenario.args())
  assert.equal(second.applied, true)

  const backups = await listBackups({ stateDir: scenario.state })
  assert.equal(backups.length, 2)
  assert.ok(backups.every((backup) => backup.size === scenario.original.length))
  assert.ok(backups.every((backup) => backup.sha256 === scenario.originalHash))
  assert.ok(backups.every((backup) => !Number.isNaN(Date.parse(backup.createdAt))))
  assert.notEqual(backups[0].file, backups[1].file)
})

test('classifyArchive trusts a size match and says the hash was not compared', () => {
  const known = KNOWN_ARCHIVES[0]
  const sized = classifyArchive(Buffer.alloc(known.official.size))
  assert.equal(sized.verdict, 'official')
  assert.equal(sized.dshVersion, known.dshVersion)
  assert.match(sized.note, /no stored hash/)
  assert.equal(classifyArchive(Buffer.alloc(known.patched.size)).verdict, 'patched')
  assert.equal(classifyArchive(Buffer.from(KNOWN_ARCHIVES[0].patched.sha256)).verdict, 'unknown')
  const unknown = classifyArchive(Buffer.from('nope'))
  assert.equal(unknown.verdict, 'unknown')
  assert.equal(unknown.dshVersion, null)
  assert.match(unknown.note, /not in the verified set/)
})

test('KNOWN_ARCHIVES pins the sizes and the patched hash this package was built against', () => {
  assert.equal(KNOWN_ARCHIVES.length >= 1, true)
  const [known] = KNOWN_ARCHIVES
  assert.equal(known.official.size, 121348951)
  assert.equal(known.patched.size, 121355145)
  assert.equal(known.patched.sha256, 'D79B6BA04FF56991629802FAF8629CED23679A0F7B13D4668B6282D00725B812')
})

test('inspectDshRoot agrees with the installation applyPatch was given', () => {
  const scenario = newScenario({ label: 'inspect' })
  const inspected = inspectDshRoot(scenario.root)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.asarPath, scenario.asarPath)
})

test('a write is refused while DSH Desktop is running, before any work is done', async () => {
  // Windows will not let a memory-mapped app.asar be replaced, so the honest answer is
  // an instruction, not a rename error after 121 MB of work. The probe is injected so
  // the test says the same thing whether or not the app happens to be running here.
  const scenario = newScenario({ label: 'running' })
  const running = { run: () => '4321\r\n' }

  const applied = await applyPatch({ ...scenario.args({ allowRunning: false }), ...running })
  assert.equal(applied.applied, false)
  assert.equal(applied.appRunning, true)
  assert.match(applied.reason, /DSH Desktop is running/)
  assert.equal(applied.backup, null, 'a refusal must not create a backup')
  assert.equal(applied.artifact, null)
  assert.deepEqual(scenario.installed(), scenario.original, 'a refusal must not touch the archive')
  assert.equal(fs.existsSync(scenario.state), false, 'a refusal must not create state')
})

test('a restore is refused while DSH Desktop is running, once a restore point exists', async () => {
  // The order matters and is deliberate: `restoreOfficial` reports a missing backup
  // before it reports a running app, because "there is nothing to restore from" is the
  // more useful answer. So a backup has to exist for the running check to be reached —
  // created here through the documented escape hatch.
  const scenario = newScenario({ label: 'running-restore' })
  const applied = await applyPatch(scenario.args())
  assert.equal(applied.applied, true, 'the escape hatch must let the write through')

  const restored = await restoreOfficial({
    dshRoot: scenario.root,
    stateDir: scenario.state,
    allowRunning: false,
    platform: 'win32',
    run: () => '4321\r\n',
  })
  assert.equal(restored.restored, false)
  assert.equal(restored.appRunning, true)
  assert.match(restored.reason, /DSH Desktop is running/)
  assert.notDeepEqual(scenario.installed(), scenario.original, 'the refusal must leave the patched archive in place')
})

test('a broken running-probe is reported instead of being read as "not running"', async () => {
  // The failure this guards against actually shipped once: a missing import made the
  // probe throw, the throw was swallowed, and the write path went on to replace a
  // memory-mapped archive. Now the failure travels as a warning.
  const scenario = newScenario({ label: 'broken-probe' })
  const applied = await applyPatch({
    ...scenario.args({ allowRunning: false }),
    run: () => { throw new Error('powershell exploded') },
  })
  assert.equal(applied.applied, true, 'the work still happens: a broken detector must not block it')
  assert.ok(
    applied.warnings.some((w) => /could not check whether DSH Desktop is running/.test(w) && /powershell exploded/.test(w)),
    `expected a probe warning, got: ${JSON.stringify(applied.warnings)}`,
  )
})
