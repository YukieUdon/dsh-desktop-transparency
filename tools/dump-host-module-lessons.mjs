#!/usr/bin/env node
/**
 * dump-host-module-lessons.mjs — print the exact code paths discovery takes, so a record
 * written inside the host can be compared against the file on disk.
 *
 * Usage: node tools/dump-host-module-lessons.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const detectSource = readFileSync(path.join(here, '..', 'lib', 'detect.mjs'), 'utf8')

const marker = 'for (const candidate of dshRootCandidates('
const at = detectSource.indexOf(marker)
console.log('--- findDshRoot body, as it exists on disk ---')
console.log(detectSource.slice(at, at + 260))

console.log('\n--- rootsFromOwnProcess guard, as it exists on disk ---')
const guard = detectSource.indexOf('if (!existsSync(path.join(resourcesDir')
console.log(detectSource.slice(guard - 120, guard + 120))

// Prove the on-disk code answers correctly for the host's exact inputs.
const { dshRootCandidates, findDshRoot, rootsFromOwnProcess } = await import('../lib/detect.mjs')
const host = {
  argv: [
    'D:\\Tools\\DSH\\DeepSeek Harness.exe',
    '--expose-internals',
    'D:\\Tools\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  ],
  execPath: 'D:\\Tools\\DSH\\DeepSeek Harness.exe',
  resourcesPath: 'D:\\Tools\\DSH\\resources',
  run: () => '',
}
console.log('\nrootsFromOwnProcess (host) :', JSON.stringify(rootsFromOwnProcess(host)))
console.log('dshRootCandidates  (host) :', JSON.stringify(dshRootCandidates(host)))
console.log('findDshRoot        (host) :', findDshRoot(host)?.root ?? null)
