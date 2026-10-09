#!/usr/bin/env node
/**
 * CLI for dsh-desktop-transparency.
 *
 * The plugin half runs inside DSH and reports to the host log; this CLI is how a
 * person checks, installs or undoes the patch from a terminal — including after a
 * DSH update, and including when the patched app will not start at all (the case
 * where nothing inside the app can help you).
 *
 * Usage:
 *   dsh-desktop-transparency status    [--json] [--dsh-root DIR] [--state-dir DIR]
 *   dsh-desktop-transparency apply     [--json] [--dsh-root DIR] [--state-dir DIR] [--force]
 *   dsh-desktop-transparency verify    [--json] [--dsh-root DIR]
 *   dsh-desktop-transparency restore   [--json] [--dsh-root DIR] [--state-dir DIR] [--backup FILE]
 *   dsh-desktop-transparency backups   [--json] [--state-dir DIR]
 */
import process from 'node:process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { applyPatch, listBackups, readBootRecord, restoreOfficial, status, verifyPatch } from './operations.mjs'

const USAGE = `dsh-desktop-transparency — transparent DSH Desktop window on Windows

Usage:
  dsh-desktop-transparency status   [--json] [--dsh-root DIR]
  dsh-desktop-transparency apply    [--json] [--dsh-root DIR] [--force] [--allow-running]
  dsh-desktop-transparency verify   [--json] [--dsh-root DIR]
  dsh-desktop-transparency restore  [--json] [--dsh-root DIR] [--backup FILE] [--allow-running]
  dsh-desktop-transparency backups  [--json] [--state-dir DIR]
  dsh-desktop-transparency boot     [--json] [--state-dir DIR]

Options:
  --dsh-root DIR    DSH install directory (auto-detected when omitted)
  --state-dir DIR   where backups are kept
  --backup FILE     a specific backup to restore
  --force           re-patch from the newest official backup even when already patched
  --allow-running   try the write even though DSH Desktop is running. It will fail with
                    EPERM: Windows does not let a running app's app.asar be replaced.
  --json            print the raw result instead of a summary
  -h, --help        show this help
`

function parseArgs(argv) {
  const args = { command: null, json: false, force: false, allowRunning: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') args.help = true
    else if (arg === '--json') args.json = true
    else if (arg === '--force') args.force = true
    else if (arg === '--allow-running') args.allowRunning = true
    else if (arg === '--dsh-root') args.dshRoot = argv[++i]
    else if (arg === '--state-dir') args.stateDir = argv[++i]
    else if (arg === '--backup') args.backupFile = argv[++i]
    else if (arg.startsWith('--dsh-root=')) args.dshRoot = arg.slice('--dsh-root='.length)
    else if (arg.startsWith('--state-dir=')) args.stateDir = arg.slice('--state-dir='.length)
    else if (arg.startsWith('--backup=')) args.backupFile = arg.slice('--backup='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else if (!args.command) args.command = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return args
}

const bytes = (n) => (typeof n === 'number' ? `${n.toLocaleString('en-US')} bytes` : 'n/a')

function printStatus(result) {
  const lines = []
  if (!result.installed) {
    lines.push('DSH Desktop: not found')
    lines.push(`  ${result.note}`)
    lines.push('  pass --dsh-root DIR to point at the installation')
  } else {
    lines.push(`DSH Desktop : ${result.root}`)
    lines.push(`  app.asar  : ${result.asarPath}`)
    lines.push(`  size      : ${bytes(result.size)}`)
    lines.push(`  sha256    : ${result.sha256}`)
    lines.push(`  state     : ${result.verdict}${result.dshVersion ? ` (DSH ${result.dshVersion})` : ''}`)
    lines.push(`  note      : ${result.note}`)
    if (result.patchVersion) lines.push(`  patched as: v${result.patchVersion}`)
    lines.push(`  backups   : ${result.backups.length}`)
    for (const backup of result.backups.slice(0, 5)) {
      lines.push(`    ${backup.createdAt}  ${backup.verdict.padEnd(8)}  ${backup.file}`)
    }
  }
  lines.push('')
  lines.push(
    result.verdict === 'patched'
      ? 'The transparency patch is installed. It takes effect when DSH Desktop starts.'
      : result.actionable
        ? 'Run "dsh-desktop-transparency apply" to install the patch, then restart DSH Desktop.'
        : 'Nothing to do until a DSH installation is found.',
  )
  console.log(lines.join('\n'))
}

function printApply(result) {
  if (result.applied) {
    console.log(`Patched ${result.asarPath}`)
    console.log(`  before : ${bytes(result.before.size)}  ${result.before.sha256}`)
    console.log(`  after  : ${bytes(result.after.size)}  ${result.after.sha256}`)
    console.log(`  backup : ${result.backup.file}`)
    console.log(`  copy   : ${result.artifact}`)
    for (const warning of result.warnings ?? []) console.log(`  warning: ${warning}`)
    console.log('\nRESTART DSH Desktop for the change to take effect.')
  } else {
    console.log(`Not applied: ${result.reason}`)
    if (result.diagnostics) {
      for (const d of result.diagnostics) {
        console.log(`  edit ${d.id}: ${d.ok ? 'ok' : 'FAILS'} (in original x${d.hitsInOriginal}, when applied in order x${d.hitsWhenAppliedInOrder})`)
        if (d.note) console.log(`    ${d.note}`)
      }
    }
    process.exitCode = 1
  }
}

function printVerify(result) {
  console.log(`Installed archive: ${result.asarPath ?? '(not found)'}`)
  // An advisory check is reported without failing the command: a patch that works on a
  // DSH version this package has not recorded is still a working patch.
  for (const check of result.checks) {
    const mark = check.ok ? 'ok   ' : check.advisory ? 'advis' : 'FAIL '
    console.log(`  ${mark} ${check.name}: ${check.detail}`)
  }
  if (result.patched === false) {
    console.log('\nThis installation is NOT patched.')
    process.exitCode = 1
  } else {
    console.log('\nInstalled archive is patched and intact. It takes effect when DSH Desktop starts.')
  }
}

function printRestore(result) {
  if (result.restored) {
    console.log(`Restored the official archive from ${result.backupUsed}`)
    console.log(`  sha256: ${result.sha256}`)
    console.log('\nRESTART DSH Desktop to leave the patched appearance behind.')
  } else {
    console.log(`Not restored: ${result.reason}`)
    process.exitCode = 1
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) {
    console.log(USAGE)
    return
  }
  const shared = { dshRoot: args.dshRoot, stateDir: args.stateDir }

  switch (args.command) {
    case 'status': {
      const result = await status(shared)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else printStatus(result)
      return
    }
    case 'apply': {
      const result = await applyPatch({ ...shared, force: args.force, allowRunning: args.allowRunning })
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else printApply(result)
      return
    }
    case 'verify': {
      const result = await verifyPatch(shared)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else printVerify(result)
      return
    }
    case 'restore': {
      const result = await restoreOfficial({ ...shared, backupFile: args.backupFile, allowRunning: args.allowRunning })
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else printRestore(result)
      return
    }
    case 'backups': {
      const result = await listBackups(shared)
      if (args.json) console.log(JSON.stringify(result, null, 2))
      else if (result.length === 0) console.log('No backups yet.')
      else for (const backup of result) console.log(`${backup.createdAt}  ${backup.verdict.padEnd(8)}  ${bytes(backup.size).padStart(16)}  ${backup.file}`)
      return
    }
    case 'boot': {
      // What the plugin decided at the last start. This is the only trace of the Host
      // half's work, because its log output goes to the app's console.
      const record = readBootRecord(shared)
      if (args.json) console.log(JSON.stringify(record, null, 2))
      else if (!record) console.log('No boot record yet — the plugin has not run on this machine.')
      else {
        // `??` and `===` bind tighter than `?:`, so the verdict has to be folded into a
        // value before it is chosen between: written as one expression, any non-empty
        // verdict — `patched` included — printed as "no installation".
        const atBoot = record.verdictAtBoot ?? (record.installed === false ? 'no installation' : 'unknown')
        console.log(`Boot record : ${record.file}`)
        console.log(`  when      : ${record.at ?? 'unknown'}`)
        console.log(`  plugin    : v${record.patchVersion ?? 'unknown'}`)
        console.log(`  at boot   : ${atBoot}`)
        console.log(`  action    : ${record.action ?? 'unknown'}`)
        if (record.reason) console.log(`  reason    : ${record.reason}`)
        if (record.backup) console.log(`  backup    : ${record.backup}`)
        if (record.sha256) console.log(`  installed : ${record.sha256}`)
        for (const warning of record.warnings ?? []) console.log(`  warning   : ${warning}`)
        if (record.restartRequired) console.log('  → a restart was required for the change to take effect')
      }
      return
    }
    default:
      throw new Error(`unknown command: ${args.command}`)
  }
}

/**
 * Only run when this file *is* the program.
 *
 * The package exports this module (`./cli`), and a module that prints a usage screen
 * merely because something imported it is a trap: a test or a UI half that pulls in the
 * CLI to reuse `parseArgs` would get a process that behaves like a command.
 */
const invokedDirectly = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`FAILED: ${error.message}`)
    process.exitCode = 1
  })
}

export { main, parseArgs }