/**
 * Finding the DSH installation and choosing where this package keeps its state.
 *
 * Two reasons this is not a one-liner. The install location is not discoverable
 * from the package: this code runs *inside* DSH's own `app.asar`, so `import.meta`
 * points at a path within the app the user is patching, not at a sibling of it.
 * And every discovery route (registry, running process, well-known directory) is a
 * heuristic that is wrong on some machine, so the callers get an ordered list of
 * guesses and the first one that survives {@link inspectDshRoot} wins.
 *
 * Two consequences shape the API. Nothing here throws: a missing registry key is
 * an ordinary answer, not an exception, and one broken candidate must not hide the
 * ones behind it. And the registry/process routes are addressed as a whole through
 * an injectable `run` callback, so the parsers can be tested against captured
 * command output instead of against whatever this machine happens to have
 * installed. The default route uses `spawnSync` rather than `execFileSync`: it can
 * report a missing `pwsh` through `error`, and it keeps stdout away from Node's own
 * inherited pipe (a `pwsh` that writes a warning must not corrupt what we parse).
 */
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Deliberately not `node:fs`: inside DSH Desktop the host process inherits Electron's
// asar-aware fs, under which `resources\app.asar` reads as a *directory*, so every
// candidate fails the archive check and discovery answers "no installation" from inside
// a running installation. fs-io.mjs resolves the fs that can see the archive; this
// import is what makes discovery work from the host.
import fs from './fs-io.mjs'

export const EXE_NAME = 'DeepSeek Harness.exe'
export const ASAR_RELATIVE = path.join('resources', 'app.asar')

/** Names a Windows uninstall entry may carry for DSH. Matched case-insensitively. */
const INSTALL_NAMES = ['deepseek harness', 'dsh desktop']

/**
 * Field separator for the piped registry/process output. A tab is legal inside a
 * registry value, so the pipes ask PowerShell for lines instead of a table.
 */
const SEP = '\u0001'

const REGISTRY_QUERY = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$roots=@(' +
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'" +
  ')',
  `Get-ItemProperty -Path $roots | Where-Object { $_.DisplayName -and $_.InstallLocation } |`,
  `  ForEach-Object { $_.Name + '${SEP}' + $_.DisplayName + '${SEP}' + $_.InstallLocation }`,
].join('\n')

const PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | " +
  'ForEach-Object { $_.ExecutablePath }'

/**
 * The default command runner. Never throws: callers treat an empty string as
 * "this route found nothing", which is the same thing as a command that failed.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function runCommand(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    return result.status === 0 ? (result.stdout ?? '') : ''
  } catch {
    return ''
  }
}

/**
 * Tries `pwsh` (PowerShell 7, where `Get-CimInstance` lives) then Windows
 * PowerShell. A runner that throws — a sandbox that refuses to spawn, a caller
 * that passes a broken fake — contributes nothing, like a command that failed.
 */
function runPowerShell(script, run = runCommand) {
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  const attempt = (command) => {
    try {
      return run(command, args)
    } catch {
      return ''
    }
  }
  return attempt('pwsh') || attempt('powershell') || ''
}

/** Last path segment, independent of the host's path flavour. */
function baseName(p) {
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** The directory holding a path, independent of the host's path flavour. */
function dirName(p) {
  const trimmed = String(p).replace(/[\\/]+$/, '')
  const cut = trimmed.lastIndexOf('\\') > trimmed.lastIndexOf('/')
    ? trimmed.lastIndexOf('\\')
    : trimmed.lastIndexOf('/')
  return cut > 0 ? trimmed.slice(0, cut) : ''
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function isDshInstallName(name) {
  const lower = trim(name).toLowerCase()
  return INSTALL_NAMES.some((needle) => lower.includes(needle))
}

/**
 * Turns the registry query's output into install roots.
 *
 * A row whose name matches DSH but whose `InstallLocation` is empty is dropped
 * rather than kept as a guess: `inspectDshRoot` would reject it anyway, and an
 * uninstall entry without a location is usually a leftover, not an install.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseRegistryRoots(text) {
  const roots = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fields = line.split(SEP)
    if (fields.length < 3) continue
    const [name, displayName, installLocation] = fields
    if (!isDshInstallName(name) && !isDshInstallName(displayName)) continue
    const root = trim(installLocation)
    if (root) roots.push(root)
  }
  return roots
}

/**
 * Turns the process query's output into install roots by taking the directory of
 * each `ExecutablePath`. Blank lines (a protected process reports no path) are
 * skipped; a bare filename with no directory contributes nothing.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseProcessRoots(text) {
  const roots = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = trim(raw)
    if (!line || !/[\\/]/.test(line) || baseName(line).toLowerCase() !== EXE_NAME.toLowerCase()) continue
    const dir = dirName(line)
    if (dir) roots.push(dir)
  }
  return roots
}

/** Drops repeats case-insensitively while preserving the first occurrence. */
function dedupe(roots) {
  const seen = new Set()
  const out = []
  for (const root of roots) {
    if (typeof root !== 'string') continue
    // `C:\Tools\DSH\` and `c:\tools\dsh` are the same directory; keeping both
    // would make inspectDshRoot report the same install twice.
    const normalized = root.trim().replace(/[\\/]+$/, '')
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

/** Joins Windows path segments, whatever flavour of `path` this process happens to have. */
function joinWindows(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map((part, index) => (index === 0 ? String(part).replace(/[\\/]+$/, '') : String(part).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

function defaultCommonRoots(env) {
  // `joinWindows`, not `path.join`: these are Windows install locations on every machine
  // that can run DSH, and `path.join` on Linux would build `C:\Users\u\AppData\Local/Programs/DSH`
  // — a path that describes nothing, in the module whose parsers are deliberately
  // flavour-independent so they can be unit-tested anywhere.
  return [
    'C:\\Program Files\\DSH',
    'C:\\Program Files (x86)\\DSH',
    joinWindows(env.LOCALAPPDATA || env.USERPROFILE || 'C:\\', 'Programs', 'DSH'),
    'D:\\Tools\\DSH',
    joinWindows(env.USERPROFILE || 'C:\\', 'DSH'),
  ]
}

/**
 * Candidate DSH install roots, best guess first. Pure; no filesystem writes.
 *
 * The order is intent, not a guess: a caller that was told where DSH lives is
 * never second-guessed; a configured install beats what is merely installed,
 * and a running process proves the path exists *right now*, which is why it
 * beats the well-known directories.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {string|string[]} [options.explicit]
 * @param {(command: string, args: string[]) => string} [options.run]
 * @returns {string[]}
 */
export function dshRootCandidates({
  env = process.env,
  platform = process.platform,
  explicit,
  run = runCommand,
  argv = process.argv,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  existsSync = pathExists,
} = {}) {
  if (platform !== 'win32') return []
  const configured = Array.isArray(explicit) ? explicit : explicit ? [explicit] : []
  const explicitRoots = configured.map(trim).filter(Boolean)
  const envRoot = trim(env.DSH_DESKTOP_ROOT)

  const registryRoots = parseRegistryRoots(runPowerShell(REGISTRY_QUERY, run))
  const processRoots = parseProcessRoots(runPowerShell(PROCESS_QUERY, run))
  const selfRoots = rootsFromOwnProcess({ argv, execPath, resourcesPath, existsSync })

  return dedupe([
    ...explicitRoots,
    ...(envRoot ? [envRoot] : []),
    // Where *this* process lives outranks anything discovered from outside: when the
    // plugin runs inside DSH Desktop, its own arguments name the very app.asar it is
    // meant to patch, and that is the one fact no registry entry or process scan can
    // contradict. Detected from the inside this way, no environment variable is needed.
    ...selfRoots,
    ...registryRoots,
    ...processRoots,
    ...defaultCommonRoots(env),
  ])
}

/**
 * Install roots implied by the running process itself.
 *
 * The desktop host is launched as
 * `"<root>\DeepSeek Harness.exe" --expose-internals <root>\resources\app.asar\dsh …`,
 * so `app.asar` appears in its own arguments. Anything after `app.asar` is inside the
 * archive (that is how the host's own module path looks), so the root is the part
 * before `resources`.
 *
 * `resourcesPath` covers a plain Electron process; `execPath` covers the launcher
 * itself. All three are cheap and none of them needs a subprocess, which matters
 * because this is the path taken when everything else has already failed.
 */
/** True when `p` is an existing path; injectable so discovery stays testable off-Windows. */
function pathExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * `baseName`/`dirName` rather than `path.dirname`/`path.basename`: the arguments here are
 * *Windows* paths even when this code is running on a machine that is not Windows (the
 * suite exercises this function everywhere, and a caller may pass the arguments the host
 * was launched with). The POSIX `path` would read `X:\Other\resources\app.asar` as one
 * filename and return no root at all — silently, which is how four discovery tests failed
 * on Linux while passing on Windows.
 */
export function rootsFromOwnProcess({ argv = [], execPath, resourcesPath, existsSync = pathExists } = {}) {
  const candidates = []
  const fromPath = (value) => {
    if (typeof value !== 'string') return
    const at = value.toLowerCase().indexOf('app.asar')
    if (at < 0) return
    // The slice *is* the archive path, so the existence check uses the caller's own
    // spelling instead of rebuilding it with a separator this platform may not share.
    const archive = value.slice(0, at + 'app.asar'.length)
    const resourcesDir = dirName(archive)
    if (baseName(resourcesDir).toLowerCase() !== 'resources') return
    const root = dirName(resourcesDir)
    // Only a root that really holds the packaged archive counts. Without this, a fallback
    // path built from an unrelated executable (the bundled `node.exe`, for instance)
    // manufactures a plausible-looking candidate that does not exist, and the candidate
    // list stops describing the machine.
    if (!existsSync(archive)) return
    candidates.push(root)
  }

  for (const argument of argv) fromPath(argument)
  if (resourcesPath) fromPath(joinWindows(resourcesPath, 'app.asar'))
  if (execPath) fromPath(joinWindows(dirName(execPath), 'resources', 'app.asar'))

  return candidates
}

function isRegularFile(statSync, p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Checks one directory for a usable DSH install.
 *
 * `problems` carries every failed check, not just the first: a directory that is
 * a stray copy reports *all* of what is missing, which is what makes the message
 * actionable instead of a guessing game. The three paths are always returned —
 * on an invalid `dir` they are derived from the raw input, so the caller can
 * report where it looked.
 *
 * @param {string} dir
 * @param {{existsSync?: Function, statSync?: Function}} [io]
 * @returns {{root: string, exePath: string, asarPath: string, ok: boolean, exists: boolean, problems: string[]}}
 */
export function inspectDshRoot(dir, { existsSync = fs.existsSync, statSync = fs.statSync } = {}) {
  const raw = typeof dir === 'string' ? dir.trim() : ''
  const root = raw ? path.resolve(raw) : ''
  const exePath = root ? path.join(root, EXE_NAME) : EXE_NAME
  const asarPath = root ? path.join(root, ASAR_RELATIVE) : ASAR_RELATIVE
  const problems = []

  const dirExists = Boolean(root) && existsSync(root)
  const dirIsDirectory = dirExists && isDirectory(statSync, root)
  if (!root || !dirExists) {
    problems.push(`install directory does not exist: ${root || '(none given)'}`)
  } else if (!dirIsDirectory) {
    problems.push(`install directory is not a directory: ${root}`)
  }
  if (!dirIsDirectory || !isRegularFile(statSync, exePath)) {
    problems.push(`launcher not found: ${exePath}`)
  }
  if (!dirIsDirectory || !isRegularFile(statSync, asarPath)) {
    problems.push(`archive not found: ${asarPath} (expected ${path.join('resources', 'app.asar')} next to the launcher)`)
  } else if (statSync(asarPath).size <= 0) {
    problems.push(`archive is empty: ${asarPath}`)
  }

  return { root, exePath, asarPath, ok: problems.length === 0, exists: dirExists, problems }
}

function isDirectory(statSync, p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The first candidate that looks like a real install, or null.
 *
 * Every injected input travels through: `run` for the registry and process queries, and
 * `argv`/`execPath`/`resourcesPath`/`existsSync` for the process's own paths. Dropping any
 * of them here (only `run` used to be forwarded) silently removes that source from
 * discovery while the candidate list still looks healthy — which is exactly how the plugin
 * inside DSH Desktop ended up reporting that no installation existed.
 *
 * Pass `trace` to collect what happened per candidate. It exists because a "found nothing"
 * answer from inside the running app cannot be reproduced from a shell, and guessing at the
 * difference cost several restarts.
 *
 * @param {object} [options]
 * @param {(entry: object) => void} [options.trace]
 * @returns {{root: string, exePath: string, asarPath: string, ok: boolean, exists: boolean, problems: string[]}|null}
 */
export function findDshRoot({ explicit, env, platform, trace, ...io } = {}) {
  const candidates = dshRootCandidates({ env, platform, explicit, ...io })
  if (trace && candidates.length === 0) trace({ candidate: null, ok: false, exists: false, problems: ['no candidates at all'] })
  for (const candidate of candidates) {
    const inspected = inspectDshRoot(candidate, io)
    if (trace) trace({ candidate, ok: inspected.ok, exists: inspected.exists, problems: inspected.problems })
    if (inspected.ok) return inspected
  }
  return null
}

/**
 * Where this package keeps its own state (backups, patched artifact).
 *
 * Never the package directory: installed inside an app bundle, `lib/` sits in a
 * read-only location, and a backup written next to the code it protects is lost
 * exactly when it is needed. `LOCALAPPDATA` is preferred over `APPDATA` because
 * a 121 MB backup must not ride along in a roaming profile.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @returns {string}
 */
export function stateDir({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const base = trim(env.LOCALAPPDATA) || trim(env.APPDATA) || os.tmpdir()
    return path.join(base, 'dsh-desktop-transparency')
  }
  const xdg = trim(env.XDG_STATE_HOME)
  const base = xdg || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'dsh-desktop-transparency')
}
