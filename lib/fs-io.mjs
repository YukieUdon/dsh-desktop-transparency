/**
 * Which `fs` the installed archive is touched through.
 *
 * The plugin's normal habitat is inside the running app: DSH Desktop launches its
 * desktop host as `DeepSeek Harness.exe` executing a script from *inside* `app.asar`,
 * and Electron replaces `node:fs` in its own processes with an asar-aware wrapper. Under
 * that wrapper `resources\app.asar` is not a file — it is the virtual root directory of
 * the archive it holds. Measured inside the real host (Electron 44.0.0, Node 24.18.1):
 *
 *   node:fs       existsSync true   statSync().isFile() false  isDirectory() true   size 0          readFileSync -> ENOENT
 *   original-fs   existsSync true   statSync().isFile() true   isDirectory() false  size 121355145  readFileSync -> 121355145 bytes
 *
 * That one substitution is the difference between the whole lifecycle working and being
 * blind: `status()` answered "no installation" from inside a running installation, and
 * the boot record said `installed: false` next to an `existsSync` of `true` for the
 * archive it could not find. Nothing in this package was wrong about *where* to look —
 * the filesystem it looked through could not see the file.
 *
 * `process.noAsar = true` would fix the reads too, and it is not an option: the host
 * loads its own modules from inside `app.asar`, so disabling asar globally breaks the
 * process this plugin lives in. `original-fs` is Electron's own unpatched `fs`, which is
 * exactly the scope needed — the archive and this package's state directory, which are
 * ordinary files either way.
 *
 * Outside Electron — the CLI, every test — `original-fs` does not exist and `node:fs` is
 * already correct, so the fallback is not a degraded mode; it is the right answer there.
 * This module deliberately reads it synchronously: a top-level `await` would make every
 * importer of this package an async module.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

/** Electron's unpatched `fs`, or a throw when this is not an Electron process. */
function loadOriginalFs() {
  return createRequire(import.meta.url)('original-fs')
}

/**
 * Candidate fs objects that could take over every read are checked before they do: a
 * module by that name which is not an fs is worse than none. The two calls below are the
 * ones the lifecycle cannot work without.
 */
function isFsLike(candidate) {
  return Boolean(candidate)
    && typeof candidate.statSync === 'function'
    && typeof candidate.readFileSync === 'function'
}

/**
 * The fs to use, plus the name to record with it.
 *
 * The name travels into the boot record: "which filesystem did the host see the archive
 * through" is the one fact that ended this bug, and it cannot be reconstructed after the
 * fact from outside the process.
 *
 * `DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS=node` pins the plain fs. It exists to reproduce
 * the host's blindness on purpose — the integration test runs the same host process both
 * ways, and a report of "no installation found" can be checked against a run that is
 * known to be blind rather than guessed at.
 *
 * @param {object} [options]
 * @param {() => object|null} [options.loadOriginal] Electron's fs; throws or returns null off Electron
 * @param {object} [options.plain] the fallback implementation
 * @param {string} [options.plainName] what to call the fallback in diagnostics
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {{fs: object, name: string}}
 */
export function resolveArchiveFs({
  loadOriginal = loadOriginalFs,
  plain = fs,
  plainName = 'node:fs',
  env = process.env,
} = {}) {
  const pinned = String(env.DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS ?? '').trim().toLowerCase()
  if (pinned === 'node' || pinned === 'node:fs') return { fs: plain, name: `${plainName} (pinned)` }
  try {
    const original = loadOriginal()
    if (isFsLike(original)) return { fs: original, name: 'original-fs' }
  } catch {
    /* not Electron, or no original-fs: the fallback is the correct answer, not a failure */
  }
  return { fs: plain, name: plainName }
}

const resolved = resolveArchiveFs()

/** The fs for the installed archive, the backups and this package's state directory. */
export const archiveFs = resolved.fs

/** `'original-fs'` inside an Electron process, `'node:fs'` anywhere else. */
export const archiveFsName = resolved.name

export default archiveFs
