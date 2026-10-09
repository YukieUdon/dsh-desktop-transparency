/**
 * Which filesystem the archive is reached through, and what the wrong answer costs.
 *
 * These run anywhere, including CI with no DSH installed. The host-process test
 * (`host-fs.test.mjs`) is the one that starts a real host; this file pins the decision
 * itself plus the exact shape of the failure it prevents, so a regression is caught on a
 * machine where no host exists to catch it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { archiveFs, archiveFsName, resolveArchiveFs } from '../lib/fs-io.mjs'
import { inspectDshRoot } from '../lib/detect.mjs'

function tempDir(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `dsh-fs-io-${label}-`))
}

/** A directory that passes inspection for everything except the archive's nature. */
function fakeInstall(label) {
  const root = tempDir(label)
  fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), '')
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'archive bytes')
  return root
}

/**
 * `node:fs` as it behaves inside a DSH host, for the paths that matter: the archive is
 * present, and it is the archive's virtual root directory rather than a file. The numbers
 * are the measured ones (Electron 44.0.0): isDirectory true, size 0.
 */
function asarAwareFs(archivePath) {
  const isArchive = (candidate) => path.resolve(String(candidate)).toLowerCase() === path.resolve(archivePath).toLowerCase()
  return {
    existsSync: (candidate) => (isArchive(candidate) ? true : fs.existsSync(candidate)),
    statSync: (candidate) => {
      if (!isArchive(candidate)) return fs.statSync(candidate)
      return { isFile: () => false, isDirectory: () => true, size: 0 }
    },
  }
}

test('resolveArchiveFs prefers Electron\'s unpatched fs when it is there', () => {
  const original = { statSync: () => {}, readFileSync: () => {} }
  const resolved = resolveArchiveFs({ loadOriginal: () => original })
  assert.equal(resolved.fs, original)
  assert.equal(resolved.name, 'original-fs')
})

test('resolveArchiveFs falls back to the plain fs off Electron, and when the module is a stub', () => {
  const plain = { statSync: () => {}, readFileSync: () => {} }

  const missing = resolveArchiveFs({
    loadOriginal: () => {
      throw new Error('MODULE_NOT_FOUND')
    },
    plain,
  })
  assert.equal(missing.fs, plain)
  assert.equal(missing.name, 'node:fs')

  assert.equal(resolveArchiveFs({ loadOriginal: () => null, plain }).fs, plain)
  // A resolvable module that is not an fs must not take over every read.
  assert.equal(resolveArchiveFs({ loadOriginal: () => ({ nope: true }), plain }).fs, plain)
})

test('the plain fs is the default when this process is not Electron', { skip: process.versions.electron ? 'running inside Electron' : false }, () => {
  assert.equal(archiveFs, fs)
  assert.equal(archiveFsName, 'node:fs')
})

test('DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS=node pins the plain fs, and says so', () => {
  const pinned = resolveArchiveFs({ loadOriginal: () => ({ statSync: () => {}, readFileSync: () => {} }), env: { DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS: 'node' } })
  assert.equal(pinned.fs, fs)
  assert.equal(pinned.name, 'node:fs (pinned)')
})

test('a run through the asar-aware fs finds no installation; the resolved fs does', () => {
  const root = fakeInstall('host')
  try {
    const archivePath = path.join(root, 'resources', 'app.asar')
    const aware = asarAwareFs(archivePath)

    // What the host used to do: everything present, archive "not found".
    const blind = inspectDshRoot(root, { existsSync: aware.existsSync, statSync: aware.statSync })
    assert.equal(blind.ok, false)
    assert.deepEqual(blind.problems, [
      `archive not found: ${archivePath} (expected resources${path.sep}app.asar next to the launcher)`,
    ])
    // The contradiction that made the boot record unreadable: it exists and it is not a file.
    assert.equal(aware.existsSync(archivePath), true)
    assert.equal(aware.statSync(archivePath).isFile(), false)

    // What it does now: the resolved fs is the one discovery uses by default.
    const found = inspectDshRoot(root, { existsSync: archiveFs.existsSync, statSync: archiveFs.statSync })
    assert.equal(found.ok, true)
    assert.deepEqual(found.problems, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
