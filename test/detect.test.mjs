/**
 * Discovery tests. Every route is exercised through an injected `run`, so these
 * pass on a machine with no DSH installed and no PowerShell available: the point
 * of the injection is that the *parsing* of registry/process output is what can
 * break, and captured text is the only fixture for it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  dshRootCandidates,
  findDshRoot,
  inspectDshRoot,
  isDshInstallName,
  parseProcessRoots,
  parseRegistryRoots,
  rootsFromOwnProcess,
  stateDir,
} from '../lib/detect.mjs'

const LF = String.fromCharCode(10)
const SEP = String.fromCharCode(1)

function tempDir(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `dsh-${label}-`))
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** A fake InstallLocation with the real launcher name and a non-empty archive. */
function fakeInstall(label) {
  const root = tempDir(label)
  fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), '')
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'not really an asar, just bytes')
  return root
}

test('inspectDshRoot names every missing piece separately', () => {
  const dir = tempDir('empty')
  try {
    const result = inspectDshRoot(dir)
    assert.equal(result.ok, false)
    assert.equal(result.exists, true)
    assert.equal(result.root, path.resolve(dir))
    assert.deepEqual(result.problems, [
      `launcher not found: ${path.join(dir, 'DeepSeek Harness.exe')}`,
      `archive not found: ${path.join(dir, 'resources', 'app.asar')} (expected resources${path.sep}app.asar next to the launcher)`,
    ])
  } finally {
    cleanup(dir)
  }
})

test('inspectDshRoot rejects a directory with only the launcher', () => {
  const dir = tempDir('launcher-only')
  try {
    fs.writeFileSync(path.join(dir, 'DeepSeek Harness.exe'), '')
    const result = inspectDshRoot(dir)
    assert.equal(result.ok, false)
    assert.equal(result.problems.length, 1)
    assert.match(result.problems[0], /^archive not found: /)
  } finally {
    cleanup(dir)
  }
})

test('inspectDshRoot rejects an empty archive', () => {
  const dir = tempDir('empty-archive')
  try {
    fs.writeFileSync(path.join(dir, 'DeepSeek Harness.exe'), '')
    fs.mkdirSync(path.join(dir, 'resources'))
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), '')
    const result = inspectDshRoot(dir)
    assert.equal(result.ok, false)
    assert.deepEqual(result.problems, [`archive is empty: ${path.join(dir, 'resources', 'app.asar')}`])
  } finally {
    cleanup(dir)
  }
})

test('inspectDshRoot rejects a directory that does not exist', () => {
  const missing = path.join(tempDir('gone'), 'nope')
  const result = inspectDshRoot(missing)
  assert.equal(result.ok, false)
  assert.equal(result.exists, false)
  assert.match(result.problems[0], /install directory does not exist/)
  assert.equal(result.problems.length, 3)
})

test('inspectDshRoot accepts a complete install and uses injected fs helpers', () => {
  const dir = fakeInstall('complete')
  try {
    const result = inspectDshRoot(dir)
    assert.equal(result.ok, true)
    assert.deepEqual(result.problems, [])
    assert.equal(result.exePath, path.join(dir, 'DeepSeek Harness.exe'))
    assert.equal(result.asarPath, path.join(dir, 'resources', 'app.asar'))

    const files = new Set([
      path.resolve(dir),
      path.resolve(path.join(dir, 'DeepSeek Harness.exe')),
      path.resolve(path.join(dir, 'resources', 'app.asar')),
    ])
    const injected = inspectDshRoot(dir, {
      existsSync: (p) => files.has(path.resolve(String(p))),
      statSync: (p) => ({
        isDirectory: () => path.resolve(String(p)) === path.resolve(dir),
        isFile: () => files.has(path.resolve(String(p))) && path.resolve(String(p)) !== path.resolve(dir),
        size: 1024,
      }),
    })
    assert.equal(injected.ok, true)
  } finally {
    cleanup(dir)
  }
})

test('findDshRoot skips broken candidates and returns the first usable one', () => {
  const broken = tempDir('broken')
  const good = fakeInstall('good')
  try {
    // The broken directory is the *better* candidate on every axis (explicit beats
    // env), so this proves the walk continues past a failure instead of stopping.
    const found = findDshRoot({
      explicit: broken,
      env: { DSH_DESKTOP_ROOT: good },
      platform: 'win32',
      run: () => '',
    })
    assert.equal(found.root, path.resolve(good))
    assert.equal(found.ok, true)
  } finally {
    cleanup(broken)
    cleanup(good)
  }
})

test('findDshRoot returns null instead of throwing when nothing matches', () => {
  assert.equal(findDshRoot({ env: {}, platform: 'linux' }), null)
  // The injected fs is what makes this portable: this machine really does have
  // DSH at one of the well-known paths.
  assert.equal(
    findDshRoot({ explicit: '', env: {}, platform: 'win32', run: () => '', existsSync: () => false, statSync: () => ({ size: 0 }) }),
    null,
  )
})

test('candidate order is explicit, env, registry, process, common paths', () => {
  const run = () => [
    `DeepSeek Harness${SEP}DeepSeek Harness${SEP}C:\\reg\\A`,
    `Unrelated App${SEP}Unrelated App${SEP}C:\\reg\\Nope`,
    `DSH Desktop${SEP}DSH Desktop (x64)${SEP}C:\\reg\\B`,
    `C:\\proc\\DeepSeek Harness.exe`,
  ].join(LF)

  const candidates = dshRootCandidates({
    explicit: 'C:\\explicit',
    env: { DSH_DESKTOP_ROOT: 'C:\\env', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' },
    platform: 'win32',
    run,
  })

  assert.deepEqual(candidates.slice(0, 6), [
    'C:\\explicit',
    'C:\\env',
    'C:\\reg\\A',
    'C:\\reg\\B',
    'C:\\proc',
    'C:\\Program Files\\DSH',
  ])
  assert.ok(candidates.includes('C:\\Users\\u\\AppData\\Local\\Programs\\DSH'))
  assert.ok(candidates.includes('C:\\Users\\u\\DSH'))
  assert.ok(!candidates.includes('C:\\reg\\Nope'))
})

/*
 * The host process names the very archive this package patches, and that fact outranks
 * anything seen from outside. This case has to work with no environment variable set:
 * running inside DSH Desktop, "detect the installation" must not depend on the user
 * having exported anything.
 *
 * Existence is injected because these paths do not exist on the test machine. The real
 * check is exercised in "does not invent a root from a path that does not exist".
 */
test('reads the install root out of the running process own arguments', () => {
  const exists = () => true
  const hostArgv = [
    'D:\\Tools\\DSH\\DeepSeek Harness.exe',
    '--expose-internals',
    'D:\\Tools\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'D:\\Tools\\DSH\\resources\\app.asar\\dsh',
    'C:\\Users\\u\\.dsh\\profiles\\desktop',
  ]
  const roots = rootsFromOwnProcess({ argv: hostArgv, existsSync: exists })
  assert.deepEqual([...new Set(roots)], ['D:\\Tools\\DSH'])

  // Plain arguments name nothing, so this contributes nothing rather than guessing.
  assert.deepEqual(rootsFromOwnProcess({ argv: ['node', 'script.mjs'], existsSync: exists }), [])

  // A launcher path is enough on its own.
  assert.deepEqual(
    rootsFromOwnProcess({ argv: [], execPath: 'D:\\Tools\\DSH\\DeepSeek Harness.exe', existsSync: exists }),
    ['D:\\Tools\\DSH'],
  )

  // A path that mentions app.asar but is not under resources/ is not an install.
  assert.deepEqual(rootsFromOwnProcess({ argv: ['C:\\tmp\\app.asar'], existsSync: exists }), [])
})

test('does not invent a root from a path that does not exist', () => {
  // The failure this guards: a fallback built from the bundled `node.exe` produced a
  // candidate like `…\dependencies\node\resources\app.asar`, which does not exist, and
  // the candidate list stopped describing the machine (two detection tests broke on it).
  const roots = rootsFromOwnProcess({
    argv: [],
    execPath: 'C:\\somewhere\\node\\bin\\node.exe',
    existsSync: () => false,
  })
  assert.deepEqual(roots, [])
})

test('the process own root is tried before anything discovered from outside', () => {
  const candidates = dshRootCandidates({
    explicit: 'C:\\explicit',
    env: { DSH_DESKTOP_ROOT: 'C:\\env' },
    platform: 'win32',
    argv: ['X:\\Other\\DeepSeek Harness.exe', 'X:\\Other\\resources\\app.asar\\dsh'],
    execPath: undefined,
    resourcesPath: undefined,
    existsSync: () => true,
    run: () => [`DeepSeek Harness${SEP}DeepSeek Harness${SEP}C:\\reg\\A`].join(LF),
  })
  assert.deepEqual(candidates.slice(0, 3), ['C:\\explicit', 'C:\\env', 'X:\\Other'])
  assert.ok(candidates.includes('C:\\reg\\A'), 'discovery from outside still contributes')
})

test('candidate roots are deduplicated case-insensitively, keeping the first spelling', () => {  const run = () => [
    `DeepSeek Harness${SEP}DeepSeek Harness${SEP}c:\\tools\\dsh`,
  ].join(LF)

  // A trailing separator is the same directory, so it must not survive as a
  // second candidate that inspectDshRoot would be asked about twice.
  const candidates = dshRootCandidates({
    explicit: 'C:\\Tools\\DSH\\',
    env: { DSH_DESKTOP_ROOT: 'c:\\tools\\dsh' },
    platform: 'win32',
    run,
  })

  assert.equal(candidates.filter((c) => c.toLowerCase().replace(/\\+$/, '') === 'c:\\tools\\dsh').length, 1)
  assert.equal(candidates[0], 'C:\\Tools\\DSH')
})

test('dshRootCandidates is empty on non-win32 and never runs a command there', () => {
  let calls = 0
  const candidates = dshRootCandidates({
    explicit: 'C:\\explicit',
    env: { DSH_DESKTOP_ROOT: 'C:\\env' },
    platform: 'darwin',
    run: () => {
      calls += 1
      return ''
    },
  })
  assert.deepEqual(candidates, [])
  assert.equal(calls, 0, 'the patch is Windows-only, so discovery must not shell out on other platforms')
})

/*
 * Discovery answers with Windows paths, so it has to *build and split* them as Windows
 * paths whatever the host's flavour is. It did not: `path.join` and `path.basename` are
 * platform-flavoured, so on Linux the well-known locations came out as
 * `C:\Users\u\AppData\Local/Programs/DSH` and `X:\Other\resources\app.asar` was read as a
 * single filename. Four discovery tests failed on the CI runner while passing on Windows,
 * which is the worst shape a failure can take — it is a property of the machine the test
 * ran on, not of the code. The assertions below are the same on every platform on purpose.
 */
test('every candidate is built as a Windows path, on any host', () => {
  const candidates = dshRootCandidates({
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' },
    platform: 'win32',
    run: () => '',
    resourcesPath: 'X:\\Other\\resources',
  })
  assert.ok(candidates.includes('C:\\Users\\u\\AppData\\Local\\Programs\\DSH'), candidates.join(' | '))
  assert.ok(candidates.includes('C:\\Users\\u\\DSH'), candidates.join(' | '))
  assert.ok(!candidates.some((candidate) => candidate.includes('/')), 'no candidate mixes separators')
  // The archive path is taken from the caller's own spelling, so a root is found here
  // even on a host whose `path` module has never seen a backslash.
  assert.deepEqual(rootsFromOwnProcess({ argv: [], resourcesPath: 'X:\\Other\\resources', existsSync: () => true }), ['X:\\Other'])
})

test('a broken command runner cannot take discovery down', () => {
  const candidates = dshRootCandidates({
    env: { USERPROFILE: 'C:\\Users\\u' },
    platform: 'win32',
    run: () => {
      throw new Error('pwsh exploded')
    },
    // Injected so the expectations are about the common-path list and not about
    // whatever this machine has installed.
    existsSync: () => false,
    statSync: () => ({ size: 0 }),
  })
  assert.deepEqual(candidates, [
    'C:\\Program Files\\DSH',
    'C:\\Program Files (x86)\\DSH',
    'C:\\Users\\u\\Programs\\DSH',
    'D:\\Tools\\DSH',
    'C:\\Users\\u\\DSH',
  ])
})

test('the registry parser needs the DSH name and a usable location', () => {
  const text = [
    `DeepSeek Harness${SEP}DeepSeek Harness${SEP}C:\\ok`,
    `Other${SEP}DeepSeek Harness Nightly${SEP}C:\\by-display-name`,
    `Other${SEP}Something Else${SEP}C:\\not-dsh`,
    `DSH Desktop${SEP}DSH Desktop${SEP}   `,
    'garbage line with no separator',
    '',
  ].join(LF)
  assert.deepEqual(parseRegistryRoots(text), ['C:\\ok', 'C:\\by-display-name'])
  assert.deepEqual(parseRegistryRoots(''), [])
  assert.equal(isDshInstallName('deepseek harness 0.2.0'), true)
  assert.equal(isDshInstallName('DeepSeek Chat'), false)
})

test('the process parser takes the executable directory and drops bare names', () => {
  const text = ['C:\\apps\\DSH\\DeepSeek Harness.exe', 'DeepSeek Harness.exe', '', 'D:\\Tools\\DSH\\DeepSeek Harness.exe '].join(LF)
  assert.deepEqual(parseProcessRoots(text), ['C:\\apps\\DSH', 'D:\\Tools\\DSH'])
  assert.deepEqual(parseProcessRoots(''), [])
})

test('stateDir honours LOCALAPPDATA, then APPDATA, then the temp directory', () => {
  assert.equal(stateDir({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32' }),
    path.join('C:\\Users\\u\\AppData\\Local', 'dsh-desktop-transparency'))
  assert.equal(stateDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'dsh-desktop-transparency'))
  assert.equal(stateDir({ env: {}, platform: 'win32' }), path.join(os.tmpdir(), 'dsh-desktop-transparency'))
})

test('stateDir never lands in the package directory', () => {
  const dir = stateDir({ env: { XDG_STATE_HOME: '/home/u/.state' }, platform: 'linux' })
  assert.equal(dir, path.join('/home/u/.state', 'dsh-desktop-transparency'))
  assert.ok(!dir.includes('dsh-desktop-transparency/lib'))
})
