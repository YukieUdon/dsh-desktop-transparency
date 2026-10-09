/**
 * probe-anchors.mjs — show, for each edit anchor, how many leading tabs it expects
 * and whether the fixture (or a real main.js) provides them.
 *
 * Written after losing time to a fixture whose indentation did not match the real
 * anchors: a stale fixture makes the tests pass for the wrong reason.
 *
 * Usage: node tools/probe-anchors.mjs [main.js]
 */
import fs from 'node:fs'
import { resolveEdits } from '../lib/patch-rules.mjs'
import { syntheticMainJs } from '../test/synthetic-asar.mjs'

const tabs = (s) => (s.match(/^\t*/) ?? [''])[0].length
const show = (s) => JSON.stringify(s.split('\n')[0])

const targets = []
if (process.argv[2]) targets.push({ label: process.argv[2], text: fs.readFileSync(process.argv[2], 'utf8') })
targets.push({ label: 'fixture syntheticMainJs()', text: syntheticMainJs() })

const edits = resolveEdits()
for (const target of targets) {
  console.log(`\n### ${target.label} (${target.text.length} chars)`)
  for (const edit of edits) {
    const hits = target.text.split(edit.find).length - 1
    console.log(`  ${edit.id.padEnd(24)} hits=${hits}  anchorTabs=${tabs(edit.find)}  ${show(edit.find)}`)
  }
}

// Every "\t" the anchor expects must appear somewhere in the fixture in the same
// shape; report the closest line for the ones that miss.
const fixture = syntheticMainJs()
for (const edit of edits) {
  if (fixture.split(edit.find).length - 1 > 0) continue
  const firstLine = edit.find.split('\n')[0]
  const wanted = tabs(edit.find)
  const near = fixture
    .split('\n')
    .filter((line) => line.trim() === firstLine.trim())
    .map((line) => `tabs=${tabs(line)} ${show(line)}`)
  console.log(`\nclosest fixture lines to "${edit.id}" (wanted tabs=${wanted}): ${near.length ? near.join(' | ') : '(none)'}`)
}
