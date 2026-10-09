/**
 * The host-process regression test.
 *
 * What it exists for: every module used to reach the archive through `node:fs`, which is
 * correct everywhere except the one place this plugin actually runs. Inside a real DSH
 * desktop host — `DeepSeek Harness.exe` started as node — Electron replaces the fs with an
 * asar-aware one, where `resources\app.asar` is the virtual root of the archive:
 *
 *   node:fs      statSync().isFile() false, isDirectory() true, size 0, readFileSync ENOENT
 *   original-fs  statSync().isFile() true, isDirectory() false, size 121355145
 *
 * So discovery answered "no installation" from inside a running installation, and the boot
 * record carried the contradiction (`installed: false` beside `existsSync(archive) === true`)
 * with nothing to explain it. No test caught it, because off the host `node:fs` is right and
 * the whole suite passed.
 *
 * This test does not simulate the host: it starts one. Both arms matter. Pinned to
 * `node:fs` the probe must report the bug — no installation, beside an archive that exists —
 * and with the resolved fs it must find the installation and classify the archive. A test
 * asserting only the good arm would not prove it can fail.
 *
 * Skipped where there is no DSH installation (CI, or a non-Windows machine), because the
 * failure cannot occur there.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { findDshRoot } from '../lib/detect.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const probeScript = path.join(here, 'fixtures', 'host-probe.mjs')

/**
 * The installation to start, discovered the way the plugin discovers it — but without the
 * PowerShell routes, so the test does not spend seconds inside a shell to answer a question
 * the filesystem already answered.
 */
function hostInstall() {
  if (process.platform !== 'win32') return null
  const found = findDshRoot({ run: () => '' })
  return found?.ok ? found : null
}

function runProbe(install, env = {}) {
  const result = spawnSync(install.exePath, [probeScript, pluginRoot], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
  })
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('HOST-PROBE '))
  assert.ok(line, `the host probe printed no report (exit ${result.status}): ${result.stderr || result.stdout}`)
  return JSON.parse(line.slice('HOST-PROBE '.length))
}

test('inside a real DSH host the archive is a file, so the installation is found', { skip: hostInstall() ? false : 'no DSH Desktop installation on this machine' }, () => {
  const install = hostInstall()
  const report = runProbe(install)

  assert.equal(report.electron !== null, true, 'the probe must have run inside Electron')
  assert.equal(report.archiveFs, 'original-fs')
  assert.equal(report.archiveFsSeesArchive.isFile, true)
  assert.ok(report.archiveFsSeesArchive.size > 0)

  assert.equal(report.status.installed, true, `status reported ${report.status.verdict}: ${report.status.note}`)
  assert.notEqual(report.status.verdict, 'missing')
  assert.equal(report.status.root.toLowerCase(), install.root.toLowerCase())
  assert.equal(report.status.detection.error, null)
  // The archive it classified is the one the host is running from, and DSH's own version
  // string is readable inside it — the two facts that prove the bytes were actually read.
  assert.match(String(report.status.dshVersion ?? ''), /^\d+\.\d+\.\d+/)
})

test('pinned to the asar-aware fs the same host reports no installation — the bug this fixes', { skip: hostInstall() ? false : 'no DSH Desktop installation on this machine' }, () => {
  const install = hostInstall()
  const report = runProbe(install, { DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS: 'node' })

  assert.equal(report.archiveFs, 'node:fs (pinned)')
  // The contradiction the boot record showed: the archive exists and is not a file.
  assert.equal(report.nodeFsSeesArchive.isFile, false)
  assert.equal(report.nodeFsSeesArchive.isDirectory, true)
  assert.equal(report.nodeFsSeesArchive.size, 0)
  assert.deepEqual(report.archiveFsSeesArchive, report.nodeFsSeesArchive)

  assert.equal(report.status.installed, false)
  assert.equal(report.status.verdict, 'missing')
  assert.match(report.status.note, /archive not found/)
})
