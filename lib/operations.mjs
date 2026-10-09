/**
 * The maintenance lifecycle: status, patch, verify, restore, list backups.
 *
 * Three rules decide the shape of everything here.
 *
 * Nothing stops or starts DSH. `app.asar` is memory-mapped while the app runs, so
 * the overwrite is the caller's job to make safe (stop DSH, then patch, then
 * restart); this module reports what it did rather than reaching for process
 * control it cannot do reliably from inside the app.
 *
 * The official archive is the only faithful restore source, so it is copied
 * before anything is overwritten — a 121 MB copy is expensive, but it is the one
 * file that can put the installation back. The patched artifact is kept beside it
 * so a machine where the patch stops the app from booting still has both halves.
 *
 * No function throws for a condition the user can be in: no install, an unknown
 * archive, an already-patched archive, a missing backup. Each of those is a
 * `reason`/`note` in the returned object, because callers are UI code that must
 * not turn "not installed" into a stack trace. Bad arguments still throw.
 */
import ownFs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Two filesystems, deliberately. `fs` (fs-io.mjs) touches the installed archive, the
// backups and the state directory — inside DSH Desktop the host inherits Electron's
// asar-aware fs, under which `resources\app.asar` is a directory that cannot be read or
// classified at all. `ownFs` reads this package's *own* files, which may live inside that
// very archive: the one case where asar support is required rather than harmful.
import fs from './fs-io.mjs'

import {
  assertParsesAsEsm,
  parseArchive,
  patchArchive,
  readArchiveFile,
  readEntry,
  reconstructOfficial,
  sha256,
  verifyIntegrity,
} from './archive.mjs'
import { expectedCssRules, PATCH_MARKER, diagnoseEdits, resolveEdits } from './patch-rules.mjs'
import { dshRootCandidates, findDshRoot, inspectDshRoot, stateDir as defaultStateDir } from './detect.mjs'
import { EXE_NAME } from './detect.mjs'

/**
 * The process queries used by {@link isDshRunning}, tried in order.
 *
 * Two of them on purpose. `Get-CimInstance` is the precise answer, but it needs a
 * PowerShell that can be spawned, and a failure there must not be read as "not
 * running": an earlier version of this function swallowed exactly such a failure (a
 * missing import) and cheerfully tried to replace a memory-mapped archive. `tasklist`
 * ships with Windows and needs no script host, so it answers when the first cannot.
 *
 * `detect.mjs` has its own copy for install discovery, which asks a different question
 * (where is the executable) and is allowed to be PowerShell-only.
 */
const PROCESS_QUERIES = [
  {
    command: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | ForEach-Object { $_.ProcessId }`],
  },
  {
    command: 'tasklist',
    args: ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH', '/FO', 'CSV'],
  },
]

const ENTRY_PATH = 'lib/main.js'
const BACKUP_PREFIX = 'app.asar.'
const ARTIFACT_NAME = 'app-transparent.asar'

/**
 * The archives this package has been verified against, per DSH version.
 *
 * `official.sha256` is deliberately absent: the official archive is what we copy
 * and restore, so a size match is enough to treat it as official, and the note
 * says so rather than pretending a hash was compared. The patched hash is stored
 * because it is the field a bug report quotes, and because it is an independent
 * check on the built bytes.
 */
export const KNOWN_ARCHIVES = [
  {
    dshVersion: '0.2.0-rc.2',
    official: { size: 121348951 },
    patched: { size: 121355145, sha256: 'D79B6BA04FF56991629802FAF8629CED23679A0F7B13D4668B6282D00725B812' },
  },
]

/**
 * Classifies archive bytes by size first, then by hash. Size alone counts as
 * known, because classification only decides whether the user is warned —
 * `diagnoseEdits` is the real gate that decides whether anything is written.
 *
 * @param {Buffer} bytes
 */
export function classifyArchive(bytes) {
  const size = bytes.length
  const hash = sha256(bytes)
  for (const known of KNOWN_ARCHIVES) {
    for (const kind of ['official', 'patched']) {
      const entry = known[kind]
      if (!entry) continue
      if (entry.sha256 && entry.sha256 === hash) {
        return {
          verdict: kind,
          dshVersion: known.dshVersion,
          size,
          sha256: hash,
          note: `matches the stored ${kind} sha256 for ${known.dshVersion}`,
        }
      }
      if (entry.size === size) {
        return {
          verdict: kind,
          dshVersion: known.dshVersion,
          size,
          sha256: hash,
          note: kind === 'official'
            ? `size matches the official ${known.dshVersion} archive; no stored hash to compare against`
            : `size matches the patched ${known.dshVersion} archive; hash not compared against a stored value`,
        }
      }
    }
  }
  return {
    verdict: 'unknown',
    dshVersion: null,
    size,
    sha256: hash,
    note: `archive is not in the verified set (size ${size}, sha256 ${hash})`,
  }
}

function failArgument(message) {
  throw new TypeError(message)
}

function hostInfo({ env, platform } = {}) {
  return {
    env: env ?? process.env,
    platform: platform ?? process.platform,
    stateDirFor: (override) => override ?? defaultStateDir({ env, platform }),
    runner: (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
      if (result.error) throw result.error
      return result.stdout ?? ''
    },
  }
}

/**
 * Resolves the installation to act on. A named root is never silently replaced by
 * another one: patching a different copy than the caller asked about is worse than
 * reporting that the named one is unusable.
 */
/**
 * Resolves the installation to act on.
 *
 * A named root is never silently replaced by another one: patching a different copy than
 * the caller asked about is worse than reporting that the named one is unusable. With no
 * name given, discovery runs — including the process's own arguments, which is the only
 * source that works when this code runs *inside* DSH Desktop and nothing was configured.
 */
function resolveRoot({ dshRoot, env, platform, explicit, argv, execPath, resourcesPath, existsSync }) {
  const requested = dshRoot ?? explicit
  if (requested) return inspectDshRoot(requested)
  return findDshRoot({ env, platform, argv, execPath, resourcesPath, existsSync }) ?? inspectDshRoot('')
}

/**
 * What discovery actually saw. Recorded in the boot record because the host process cannot
 * be inspected from outside: when a user reports "it says no installation", this is the
 * difference between "it looked in the wrong places" and "it never ran the new code".
 */
export function describeDetection({ env, platform, argv, execPath, resourcesPath, existsSync } = {}) {
  const args = argv ?? process.argv
  const exe = execPath ?? process.execPath
  const res = resourcesPath ?? process.resourcesPath
  let candidates = []
  let error = null
  try {
    candidates = dshRootCandidates({ env, platform, argv: args, execPath: exe, resourcesPath: res, existsSync })
  } catch (problem) {
    error = String(problem?.message ?? problem)
  }
  return {
    argv: args.slice(1, 4),
    execPath: exe ?? null,
    resourcesPath: res ?? null,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 6),
    error,
  }
}

function readBytes(file) {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function createdAtOf(file) {
  try {
    const stat = fs.statSync(file)
    // A filesystem that cannot report a creation time gives the epoch; mtime is
    // the honest fallback there.
    return new Date(stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

/** The version DSH reports about itself, as recorded in the archive's package.json. */
function dshVersionOf(archive) {
  try {
    const parsed = JSON.parse(readEntry(archive, 'package.json').toString('utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** Every identifier in a snippet. Used to prove a substitution body survived. */
function identifiersOf(source) {
  return [...new Set(String(source).match(/[A-Za-z_$][A-Za-z0-9_$]{5,}/g) ?? [])]
}

/** Identifiers the template must export into the patched file. */
const REQUIRED_IDENTIFIERS = ['installWindowsTransparency', 'roundWindowsCorners', 'applyWindowsCorners']

/**
 * Every offline gate a built `lib/main.js` must pass, as a list of problems.
 *
 * Verifying the archive proves it is structurally intact; it says nothing about
 * whether the *substitution* did what it promised. A template edited into a no-op
 * still round-trips perfectly, so the promised identifiers and every CSS rule are
 * checked by name. The edit-by-edit check catches the other half: a `replace`
 * whose own body was dropped would pass the marker test while doing nothing.
 *
 * @param {string} text the substituted `lib/main.js`
 * @param {{promised?: string[]}} [expected]
 */
async function problemsInBuiltMainJs(text, promised = REQUIRED_IDENTIFIERS) {
  const problems = []
  for (const id of promised) {
    if (!text.includes(id)) problems.push(`substituted ${ENTRY_PATH} lost ${id}`)
  }
  for (const rule of expectedCssRules) {
    if (!text.includes(rule)) problems.push(`stylesheet rule missing: ${rule}`)
  }
  if (!text.includes(PATCH_MARKER)) problems.push(`marker ${PATCH_MARKER} missing`)

  const present = identifiersOf(text)
  for (const edit of resolveEdits()) {
    if (!edit.replace || edit.replace === edit.find) continue
    for (const id of identifiersOf(edit.replace)) {
      if (present.includes(id) && !text.includes(id)) problems.push(`edit ${edit.id} promised ${id}, which is not in the patched file`)
    }
  }

  if (problems.length === 0) {
    try {
      await assertParsesAsEsm(text, ENTRY_PATH)
    } catch (error) {
      problems.push(error.message)
    }
  }
  return problems
}

/** Builds the patched archive in memory and verifies it. Throws on the first fault. */
async function buildPatched(sourceBytes, edits) {
  const originalText = readEntry(parseArchive(sourceBytes), ENTRY_PATH).toString('utf8')
  const { buffer, report, roundTrip } = patchArchive(sourceBytes, { entryPath: ENTRY_PATH, edits, verify: true })

  const text = readEntry(parseArchive(buffer), ENTRY_PATH).toString('utf8')
  // Only identifiers the *original* already used can be expected to survive: a
  // substitution body that dropped one of them is the failure this catches.
  const promised = [...new Set(edits.flatMap((edit) => identifiersOf(edit.replace ?? '')))].filter(
    (id) => originalText.includes(id),
  )

  // The hit count itself is enforced by `applyEdits` while it patches, so what is
  // left to check is what the new text *contains*.
  const problems = await problemsInBuiltMainJs(text, [...new Set([...REQUIRED_IDENTIFIERS, ...promised])])
  try {
    verifyIntegrity(parseArchive(buffer))
  } catch (error) {
    problems.push(error.message)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))

  return { buffer, report, roundTrip, text, cssRules: expectedCssRules.length }
}

/**
 * Whether a backup file is one of ours, and what it is.
 *
 * A recorded sidecar digest is the proof that the file is this package's own
 * backup, and it is what makes a restore possible on a machine whose archive is
 * not in the version table (an unseen DSH build, or a fixture): the whole point of
 * the copy is that *we* made it and hashed it. A backup without a usable sidecar
 * still counts, but then only its classification can speak for it.
 */
function backupCandidate(file) {
  const bytes = readBytes(file)
  if (!bytes) return null
  const hash = sha256(bytes)
  let sidecar = null
  try {
    sidecar = fs.readFileSync(`${file}.sha256`, 'utf8').trim()
  } catch {
    sidecar = null
  }
  const classified = classifyArchive(bytes)
  return {
    file,
    size: bytes.length,
    sha256: hash,
    verdict: classified.verdict,
    sidecar,
    sidecarMatches: sidecar !== null && sidecar === hash,
    note: classified.note,
  }
}

function isUsableRestorePoint(candidate) {
  return candidate.verdict === 'official' || candidate.sidecarMatches
}

/** The newest backup that is usable as a restore point, or null. */
function newestOfficialBackup(backupsDir) {
  for (const file of listBackupFiles(backupsDir)) {
    const candidate = backupCandidate(file)
    if (candidate && isUsableRestorePoint(candidate)) return candidate
  }
  return null
}

/** Newest first: restore takes the head, and the list is what a user reads. */
function listBackupFiles(backupsDir) {
  return listDir(backupsDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && !name.endsWith('.sha256'))
    .map((name) => path.join(backupsDir, name))
    .map((file) => ({ file, mtimeMs: fileSize(file) === null ? 0 : statMtime(file) }))
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.file.localeCompare(b.file))
    .map((entry) => entry.file)
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Time-stamped name, never colliding with an existing backup. */
function nextBackupFile(backupsDir, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  let candidate = path.join(backupsDir, `${BACKUP_PREFIX}${stamp}`)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(backupsDir, `${BACKUP_PREFIX}${stamp}-${suffix}`)
    suffix += 1
  }
  return candidate
}

/**
 * Writes the backup and its sidecar hash. The archive is written with `wx`, so an
 * existing name is never overwritten; the sidecar is written afterwards and never
 * fatal, because the archive is the thing that restores.
 */
function writeBackup(backupsDir, bytes) {
  fs.mkdirSync(backupsDir, { recursive: true })
  const file = nextBackupFile(backupsDir)
  const hash = sha256(bytes)
  fs.writeFileSync(file, bytes, { flag: 'wx' })
  try {
    fs.writeFileSync(`${file}.sha256`, `${hash}\n`, 'utf8')
  } catch {
    /* a missing sidecar only costs a re-hash later */
  }
  return { file, sha256: hash }
}

/**
 * Atomic replace: the temp file lives in the target's own directory (a rename
 * across volumes is a copy, not a rename) and is removed on every failure path, so
 * a crash leaves either the old archive or the new one — never a half file, and
 * never stray `.tmp-` litter that the next run would trip over.
 */
function writeFileAtomic(file, bytes) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* already gone */
    }
    return { ok: false, reason: error.message }
  }
}

/** Keeps the rollback artifact next to the backups; failing to is only a warning. */
function writeArtifact(buildDir, bytes) {
  try {
    fs.mkdirSync(buildDir, { recursive: true })
    const file = path.join(buildDir, ARTIFACT_NAME)
    fs.writeFileSync(file, bytes)
    return { file, error: null }
  } catch (error) {
    return { file: null, error: error.message }
  }
}

/**
 * Re-exported for the plugin half, which records the candidate list as data.
 *
 * A "no installation" answer is the one a user cannot debug from outside the app, so the
 * plugin writes down what discovery saw. That needs the candidate function itself, not just
 * the resolved root.
 */
export { dshRootCandidates, findDshRoot }

/**
 * Whether a DSH Desktop process is running right now.
 *
 * This matters more than it looks. While the app runs, Windows refuses to replace the
 * memory-mapped `app.asar`: the atomic rename fails with `EPERM`. Discovering that
 * *after* reading 121 MB and writing a backup is expensive and confusing, so the write
 * paths check first and refuse with an instruction instead. `allowRunning` exists for
 * the case where the caller knows better (the process may be an unrelated stray copy),
 * and because refusing on a detector's word alone would be worse than the problem.
 */
export async function isDshRunning({ env, platform, run } = {}) {
  return probeRunning({ env, platform, run }).running
}

/**
 * Whether the app is running, plus what happened to the probes.
 *
 * The failures are reported because silence is the failure mode that hurt: a broken
 * detector once reported "not running" and the write path then tried to replace a
 * memory-mapped archive. Every probe failing is still reported as "not running" — a
 * detector that cannot run must not block legitimate work — but the caller can now
 * pass those failures on as a warning instead of pretending the check succeeded.
 */
export function probeRunning({ env, platform, run } = {}) {
  const { runner, platform: hostPlatform } = hostInfo({ env, platform })
  if ((hostPlatform ?? process.platform) !== 'win32') {
    return { running: false, failures: [], checked: false }
  }
  const execute = run ?? runner
  const failures = []
  for (const query of PROCESS_QUERIES) {
    try {
      const output = execute(query.command, query.args)
      // A probe that ran and printed nothing is a real answer: the app is not running.
      return { running: typeof output === 'string' && output.trim().length > 0, failures, checked: true }
    } catch (error) {
      failures.push(`${query.command}: ${error?.message ?? error}`)
    }
  }
  return { running: false, failures, checked: false }
}

function refusal(root, asarPath, before, extra) {
  return {
    applied: false,
    root: root.root || null,
    asarPath: asarPath ?? root.asarPath ?? null,
    before: before ?? null,
    after: null,
    backup: null,
    artifact: null,
    restartRequired: false,
    warnings: [],
    ...extra,
  }
}

/**
 * Whether the archive's own `lib/main.js` carries the marker.
 *
 * The hash table cannot answer this for an archive built from different sources
 * (a synthetic fixture, or a DSH version this package has not seen), and "is it
 * patched" is exactly the question a caller asks before writing. As expensive as
 * it is, the marker is the definitive answer; the classification is the hint.
 */
function markerInArchive(archive) {
  try {
    return readEntry(archive, ENTRY_PATH).toString('utf8').includes(PATCH_MARKER)
  } catch {
    return false
  }
}

/**
 * The full status of one installation, never throwing for "not installed".
 */
export async function status({ dshRoot, stateDir: stateDirOverride, env, platform, argv, execPath, resourcesPath, existsSync } = {}) {
  const { stateDirFor } = hostInfo({ env, platform })
  const dir = stateDirFor(stateDirOverride)
  const backups = await listBackups({ stateDir: dir })
  const root = resolveRoot({ dshRoot, env, platform, argv, execPath, resourcesPath, existsSync })
  // What discovery saw, whether or not it found anything. A "no installation" answer is
  // the one a user cannot debug from the outside, and this is what makes it checkable.
  const detection = describeDetection({ env, platform, argv, execPath, resourcesPath, existsSync })
  const empty = {
    installed: false,
    root: root.root || null,
    exePath: root.exePath || null,
    asarPath: root.asarPath || null,
    size: null,
    sha256: null,
    verdict: 'missing',
    dshVersion: null,
    note: root.problems.join('; '),
    patchVersion: null,
    backups,
    actionable: false,
    detection,
  }
  if (!root.ok) return empty

  const bytes = readBytes(root.asarPath)
  if (!bytes) {
    return { ...empty, installed: true, note: `app.asar cannot be read: ${root.asarPath}`, verdict: 'unreadable' }
  }

  const classified = classifyArchive(bytes)
  let archive = null
  let dshVersion = classified.dshVersion
  try {
    archive = parseArchive(bytes)
    dshVersion = dshVersionOf(archive) ?? dshVersion
  } catch {
    /* an archive we recognise by hash may still be too unusual to read */
  }

  const marked = archive ? markerInArchive(archive) : false
  const verdict = marked ? 'patched' : classified.verdict
  const note = marked && classified.verdict !== 'patched'
    ? `the archive is not in the verified set (${classified.note}) but its ${ENTRY_PATH} carries the patch marker`
    : classified.note
  const known = KNOWN_ARCHIVES.find((entry) => entry.dshVersion === dshVersion)
  return {
    installed: true,
    root: root.root,
    exePath: root.exePath,
    asarPath: root.asarPath,
    size: bytes.length,
    sha256: classified.sha256,
    verdict,
    dshVersion,
    note,
    patchVersion: verdict === 'patched' ? (known?.dshVersion ?? dshVersion) : null,
    backups,
    actionable: verdict !== 'patched',
    detection,
  }
}

/**
 * Applies the patch.
 *
 * The order is load-bearing: diagnose the anchors in *this* archive, build and
 * verify the new bytes entirely in memory, and only then touch the disk. A patch
 * that cannot be built never reaches the backup or the target.
 *
 * @param {object} [options]
 */
export async function applyPatch({ dshRoot, stateDir: stateDirOverride, env, platform, force = false, allowRunning = false, run, argv, execPath, resourcesPath, existsSync } = {}) {
  if (typeof force !== 'boolean') failArgument('applyPatch: force must be a boolean')
  const { stateDirFor } = hostInfo({ env, platform })
  const dir = stateDirFor(stateDirOverride)
  const backupsDir = path.join(dir, 'backups')
  const buildDir = path.join(dir, 'build')
  const root = resolveRoot({ dshRoot, env, platform, argv, execPath, resourcesPath, existsSync })
  const warnings = []

  if (!root.ok) {
    return refusal(root, null, null, { reason: `no usable DSH installation: ${root.problems.join('; ')}` })
  }

  const target = root.asarPath
  const installedBytes = readBytes(target)
  if (!installedBytes) {
    return refusal(root, target, null, { reason: `app.asar cannot be read: ${target}` })
  }

  const installed = classifyArchive(installedBytes)
  const before = { size: installedBytes.length, sha256: installed.sha256, verdict: installed.verdict }

  // Windows refuses to replace a file another process has memory-mapped, so a running
  // app turns the final rename into `EPERM` (verified on a real installation). Check
  // first, because every later refusal message would otherwise be misleading: telling
  // someone to "pass force" is useless advice while the app holds the archive open.
  const probe = probeRunning({ env, platform, run })
  if (!allowRunning && probe.running) {
    return refusal(root, target, before, {
      appRunning: true,
      reason:
        'DSH Desktop is running, and Windows will not let its app.asar be replaced while it is; ' +
        'close DSH Desktop and run this again (or pass allowRunning to try anyway)',
    })
  }
  if (!probe.checked && probe.failures.length > 0) {
    warnings.push(
      `could not check whether DSH Desktop is running (${probe.failures.join('; ')}); ` +
      'if it is, replacing app.asar will fail with EPERM',
    )
  }

  // The marker in the installed `lib/main.js` outranks the hash table: an archive
  // that carries it *is* patched, whether or not its bytes are in the table. If it
  // cannot even be parsed, fall back to the classification and let the build fail
  // with a real reason instead of refusing for the wrong one.
  let alreadyPatched = installed.verdict === 'patched'
  if (!alreadyPatched) {
    try {
      alreadyPatched = markerInArchive(parseArchive(installedBytes))
    } catch {
      alreadyPatched = false
    }
  }

  if (alreadyPatched && !force) {
    return refusal(root, target, before, {
      reason: 'app.asar is already patched; pass force to re-patch from the newest official backup',
    })
  }

  // The bytes the patch is built from, and which backup it restores to.
  let sourceBytes = installedBytes
  let backupRef = null
  if (alreadyPatched) {
    const official = newestOfficialBackup(backupsDir)
    if (official) {
      const officialBytes = readBytes(official.file)
      if (!officialBytes) {
        return refusal(root, target, before, { reason: `the newest official backup cannot be read: ${official.file}` })
      }
      sourceBytes = officialBytes
      backupRef = { file: official.file, sha256: official.sha256 }
      warnings.push(`already patched: re-patching from the official backup ${official.file}`)
    } else {
      // No backup on this machine. That is the normal state for an installation
      // patched before this package existed, and refusing here would leave the user
      // with no way to re-apply or roll back at all. The edits are deterministic
      // substitutions, so the official bytes can be recovered by undoing them — and
      // the result is kept as a real backup so every later operation has a restore
      // point. The reconstruction is only used when it reproduces a marker-free
      // archive; otherwise nothing is written.
      const edits = resolveEdits()
      let reconstructed
      try {
        reconstructed = reconstructOfficial(installedBytes, { entryPath: ENTRY_PATH, edits })
      } catch (error) {
        return refusal(root, target, before, {
          reason:
            'app.asar is already patched and no official backup exists; rebuilding the official archive ' +
            `from the patched one failed: ${error.message}`,
        })
      }
      const restoredText = readEntry(parseArchive(reconstructed.buffer), ENTRY_PATH).toString('utf8')
      if (restoredText.includes(PATCH_MARKER)) {
        return refusal(root, target, before, {
          reason: 'app.asar is already patched and no official backup exists; the rebuilt archive still carries the patch marker',
        })
      }
      const officialBackup = writeBackup(backupsDir, reconstructed.buffer)
      sourceBytes = reconstructed.buffer
      backupRef = { file: officialBackup.file, sha256: officialBackup.sha256 }
      warnings.push(
        'no official backup existed; rebuilt the official archive by reversing the patch ' +
        `(undid ${reconstructed.undone.join(', ')}) and stored it as ${officialBackup.file}`,
      )
    }
  }
  if (installed.verdict === 'unknown') {
    warnings.push(
      `app.asar is not in the verified set (size ${installed.size}, sha256 ${installed.sha256}); ` +
      'the anchors diagnosed clean so it is patched anyway, but confirm this is the DSH archive you expect',
    )
  }

  let sourceArchive
  let originalText
  try {
    // `readArchiveFile` reads a *path*; the source bytes may be a backup rather
    // than the installed file, so parse the buffer we already hold.
    sourceArchive = parseArchive(sourceBytes)
    originalText = readEntry(sourceArchive, ENTRY_PATH).toString('utf8')
  } catch (error) {
    return refusal(root, target, before, { reason: `app.asar cannot be read as an asar archive: ${error.message}` })
  }

  const diagnostics = diagnoseEdits(originalText)
  const failed = diagnostics.filter((entry) => !entry.ok)
  if (failed.length > 0) {
    return refusal(root, target, before, {
      backup: backupRef,
      reason: `refusing to patch: ${failed.map((entry) => `edit ${entry.id} ${entry.note ?? 'does not match exactly once'}`).join('; ')}`,
      diagnostics,
    })
  }

  const edits = resolveEdits()
  let built
  try {
    built = await buildPatched(sourceBytes, edits)
  } catch (error) {
    return refusal(root, target, before, { backup: backupRef, reason: `refusing to write: ${error.message}`, diagnostics })
  }

  // Keep the artifact before the target: if the build directory cannot be created,
  // the user still gets a warning instead of a half-applied patch.
  const artifact = writeArtifact(buildDir, built.buffer)
  if (artifact.error) warnings.push(`could not write the rollback artifact in ${buildDir}: ${artifact.error}`)

  let backup
  if (backupRef) {
    // The archive on disk is already patched; copying *it* would add a restore
    // point that restores the patch, so the run keeps referencing the official
    // backup it rebuilt from.
    backup = backupRef
  } else {
    try {
      backup = writeBackup(backupsDir, installedBytes)
    } catch (error) {
      return refusal(root, target, before, {
        artifact: artifact.file,
        warnings,
        reason: `refusing to overwrite app.asar: the official backup could not be written (${error.message})`,
      })
    }
  }

  const written = writeFileAtomic(target, built.buffer)
  if (!written.ok) {
    return refusal(root, target, before, {
      backup,
      artifact: artifact.file,
      warnings,
      reason: `app.asar was not replaced (${written.reason}); if DSH is running, stop it and try again`,
    })
  }

  // The rename is not proof: hash what is on disk now, and put the official archive
  // back automatically if it is not exactly the bytes that were verified.
  const afterBytes = readBytes(target)
  const afterHash = afterBytes ? sha256(afterBytes) : null
  if (afterHash !== sha256(built.buffer)) {
    warnings.push('the installed app.asar does not match the verified bytes; restoring the backup automatically')
    const restored = backup ? writeFileAtomic(target, readBytes(backup.file) ?? Buffer.alloc(0)) : { ok: false }
    if (!restored.ok) {
      warnings.push(`automatic restore failed; run restoreOfficial({ backupFile: ${JSON.stringify(backup?.file ?? null)} })`)
    }
    return refusal(root, target, before, {
      backup,
      artifact: artifact.file,
      warnings,
      reason: 'the written app.asar did not verify; the previous archive was restored',
    })
  }

  return {
    applied: true,
    root: root.root,
    asarPath: target,
    before,
    after: { size: afterBytes.length, sha256: afterHash },
    backup,
    artifact: artifact.file,
    restartRequired: true,
    warnings,
    diagnostics,
    cssRules: built.cssRules,
    report: built.report,
  }
}

/**
 * Verifies the installed archive without trusting anything the patch wrote down.
 *
 * Usable on a machine with no DSH at all: every check is reported, and the
 * aggregate `patched` is true only when all of them pass.
 */
export async function verifyPatch({ dshRoot, env, platform, argv, execPath, resourcesPath, existsSync } = {}) {
  const root = resolveRoot({ dshRoot, env, platform, argv, execPath, resourcesPath, existsSync })
  const checks = []
  const result = {
    patched: false,
    root: root.root || null,
    asarPath: root.asarPath || null,
    size: null,
    sha256: null,
    markerPresent: false,
    cssRules: 0,
    dshVersion: null,
    checks,
  }

  checks.push({
    name: 'install',
    ok: root.ok,
    detail: root.ok ? root.root : root.problems.join('; '),
  })
  if (!root.ok) return result

  const bytes = readBytes(root.asarPath)
  checks.push({
    name: 'readable',
    ok: Boolean(bytes),
    detail: bytes ? `${bytes.length} bytes` : `cannot read ${root.asarPath}`,
  })
  if (!bytes) return result
  result.size = bytes.length
  result.sha256 = sha256(bytes)

  let archive = null
  try {
    archive = await readArchiveFile(root.asarPath)
    checks.push({ name: 'asar', ok: true, detail: `${archive.all.length} entries, ${archive.unpacked} unpacked` })
  } catch (error) {
    checks.push({ name: 'asar', ok: false, detail: error.message })
  }
  if (!archive) return result
  result.dshVersion = dshVersionOf(archive)

  let text = null
  try {
    text = readEntry(archive, ENTRY_PATH).toString('utf8')
    checks.push({ name: 'mainJs', ok: true, detail: `${Buffer.byteLength(text, 'utf8')} bytes` })
  } catch (error) {
    checks.push({ name: 'mainJs', ok: false, detail: error.message })
  }
  if (text === null) return result

  result.markerPresent = text.includes(PATCH_MARKER)
  checks.push({
    name: 'marker',
    ok: result.markerPresent,
    detail: result.markerPresent ? `${PATCH_MARKER} found in ${ENTRY_PATH}` : `${PATCH_MARKER} not found in ${ENTRY_PATH}`,
  })

  result.cssRules = expectedCssRules.filter((rule) => text.includes(rule)).length
  checks.push({
    name: 'cssRules',
    ok: result.cssRules === expectedCssRules.length,
    detail: `${result.cssRules}/${expectedCssRules.length} expected rules present`,
  })

  let integrity = null
  try {
    integrity = verifyIntegrity(archive)
    checks.push({ name: 'integrity', ok: true, detail: `${integrity} entries verified` })
  } catch (error) {
    checks.push({ name: 'integrity', ok: false, detail: error.message })
  }

  try {
    await assertParsesAsEsm(text, ENTRY_PATH)
    checks.push({ name: 'esm', ok: true, detail: `${ENTRY_PATH} parses as an ES module` })
  } catch (error) {
    checks.push({ name: 'esm', ok: false, detail: error.message })
  }

  // A digest of the archive shape, reported but never a gate: an archive this
  // package has not seen before can still be patched, and calling a working patch
  // unverified because of the version table would be wrong. `advisory` says so.
  const known = KNOWN_ARCHIVES.find((entry) => entry.dshVersion === result.dshVersion)
  const knownBytes = Boolean(known) && (known.patched.sha256 === result.sha256 || known.patched.size === bytes.length)
  checks.push({
    name: 'knownArchive',
    ok: knownBytes,
    advisory: true,
    detail: knownBytes
      ? `${bytes.length} bytes matches the recorded shape for ${result.dshVersion}`
      : `not the recorded shape for ${result.dshVersion ?? 'an unknown DSH version'} (${bytes.length} bytes, sha256 ${result.sha256})`,
  })

  result.patched = result.markerPresent && checks.every((check) => check.ok || check.advisory)
  return result
}

/**
 * The backups this package keeps, newest first, each classified by its own bytes.
 *
 * The verdict says what the bytes *are*, not whether they can be restored from: a
 * backup of an archive this package has never seen is honestly 'unknown' and is
 * still usable, because its sidecar digest proves where it came from.
 */
export async function listBackups({ stateDir: stateDirOverride, env, platform } = {}) {
  const { stateDirFor } = hostInfo({ env, platform })
  const dir = stateDirFor(stateDirOverride)
  const backupsDir = path.join(dir, 'backups')
  return listBackupFiles(backupsDir).flatMap((file) => {
    const candidate = backupCandidate(file)
    if (!candidate) return []
    return [{
      file,
      size: candidate.size,
      sha256: candidate.sha256,
      createdAt: createdAtOf(file),
      verdict: candidate.verdict,
    }]
  })
}

/**
 * Records what the boot check did.
 *
 * The plugin runs inside the desktop host, where its log output is visible only to
 * whoever is watching the app's console — which is nobody, most of the time. A small
 * JSON record in the state directory turns "did it run, and what did it decide" into
 * something a user, a bug report or a verification run can read, and it is what makes
 * the re-apply after a DSH update observable instead of a claim.
 */
export function writeBootRecord(record, { stateDir: stateDirOverride, env, platform } = {}) {
  const { stateDirFor } = hostInfo({ env, platform })
  const dir = stateDirFor(stateDirOverride)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'last-boot.json')
  const payload = { patchVersion: packageVersion(), at: new Date().toISOString(), ...record }
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return file
}

/**
 * This package's own version, read from its manifest.
 *
 * Read rather than inlined so the value cannot disagree with what npm published. A
 * failure here is reported as unknown instead of breaking the caller: a boot record
 * without a version is still worth having.
 */
function packageVersion() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(ownFs.readFileSync(manifest, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Reads the record {@link writeBootRecord} wrote, or null when there is none. */
export function readBootRecord({ stateDir: stateDirOverride, env, platform } = {}) {
  const { stateDirFor } = hostInfo({ env, platform })
  const file = path.join(stateDirFor(stateDirOverride), 'last-boot.json')
  if (!fs.existsSync(file)) return null
  try {
    return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { file, error: `the boot record is unreadable: ${error.message}` }
  }
}

/**
 * Puts the newest usable backup back, or an explicitly named one.
 *
 * Explicit means explicit: a named file that is missing or is not a restore point
 * is reported rather than quietly skipped in favour of another backup, because the
 * caller asked for that exact restore.
 */
export async function restoreOfficial({ dshRoot, backupFile, stateDir: stateDirOverride, env, platform, allowRunning = false, run, argv, execPath, resourcesPath, existsSync } = {}) {
  const { stateDirFor } = hostInfo({ env, platform })
  const dir = stateDirFor(stateDirOverride)
  const backupsDir = path.join(dir, 'backups')
  const root = resolveRoot({ dshRoot, env, platform, argv, execPath, resourcesPath, existsSync })
  const empty = { restored: false, backupUsed: null, sha256: null }

  if (!root.ok) return { ...empty, reason: `no usable DSH installation: ${root.problems.join('; ')}` }

  let chosen = null
  if (backupFile) {
    chosen = backupCandidate(backupFile)
    if (!chosen) return { ...empty, reason: `backup does not exist or cannot be read: ${backupFile}` }
    if (!isUsableRestorePoint(chosen)) {
      return {
        ...empty,
        reason: `${backupFile} is not a restore point: it is not an official archive (classified ${chosen.verdict}) ` +
          'and has no matching .sha256 beside it',
      }
    }
  } else {
    chosen = newestOfficialBackup(backupsDir)
    if (!chosen) return { ...empty, reason: `no usable backup found in ${backupsDir}` }
  }

  const bytes = readBytes(chosen.file)
  if (!bytes) return { ...empty, reason: `backup cannot be read: ${chosen.file}` }

  if (readBytes(root.asarPath)?.equals(bytes)) {
    return { restored: false, backupUsed: chosen.file, sha256: chosen.sha256, reason: 'app.asar already matches that backup' }
  }

  // Same constraint as applying: a running app holds the archive open, so the replace
  // fails with EPERM. Refuse with the instruction instead of a rename error.
  const probe = probeRunning({ env, platform, run })
  if (!allowRunning && probe.running) {
    return {
      ...empty,
      backupUsed: chosen.file,
      appRunning: true,
      reason: 'DSH Desktop is running, and Windows will not let its app.asar be replaced while it is; close DSH Desktop and run this again',
    }
  }

  const written = writeFileAtomic(root.asarPath, bytes)
  if (!written.ok) {
    return { ...empty, backupUsed: chosen.file, reason: `app.asar was not replaced (${written.reason}); if DSH is running, stop it and try again` }
  }

  const installed = readBytes(root.asarPath)
  const installedHash = installed ? sha256(installed) : null
  if (installedHash !== chosen.sha256) {
    return {
      restored: false,
      backupUsed: chosen.file,
      sha256: installedHash,
      reason: `the restored app.asar does not match the backup (${installedHash} != ${chosen.sha256})`,
    }
  }
  return { restored: true, backupUsed: chosen.file, sha256: installedHash }
}
