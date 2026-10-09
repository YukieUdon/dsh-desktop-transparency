#!/usr/bin/env node
/**
 * make-classes-fixture.mjs — turn a raw live-class capture into the selector-check
 * fixture committed for CI.
 *
 * Usage: node tools/make-classes-fixture.mjs <live-classes.json> <out.json> [absentSelector...]
 */
import fs from 'node:fs'

const [src, out, ...absent] = process.argv.slice(2)
if (!src || !out) {
  console.error('usage: node tools/make-classes-fixture.mjs <live-classes.json> <out.json> [absentSelector...]')
  process.exit(2)
}

const raw = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''))
const live = [...new Set(raw.live ?? raw.sidebar ?? [])]
if (live.length === 0) throw new Error(`${src} has no class names`)

const fixture = {
  note: 'Class names captured from a live DSH page with the transparency patch installed. Regenerate with tools/make-classes-fixture.mjs; CI checks every [class*="…"] selector against this list.',
  live,
  absent,
}
fs.writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`, 'utf8')
console.log(`wrote ${out}: ${live.length} class name(s), ${absent.length} known-absent selector(s)`)
