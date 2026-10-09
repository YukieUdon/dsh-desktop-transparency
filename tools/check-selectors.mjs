#!/usr/bin/env node
/**
 * check-selectors.mjs — verify every `[class*="…"]` selector in the patch template
 * against a recorded list of class names from a live DSH page.
 *
 * Why this exists: `[class*="…"]` matches a substring, so a single wrong character
 * turns the rule into a silent no-op. That is not hypothetical — this project once
 * shipped `[class*="_9lTDKa_fade_"]` while the real class is `_9lTDKa_fade`, and the
 * sidebar kept its black bar through a whole round of "verification". A substring
 * check against real class names catches it in a second.
 *
 * Usage: node tools/check-selectors.mjs <live-classes.json>
 *   live-classes.json: { "live": ["_9lTDKa_fade", "_dockScrim_6nhg2_599", …] }
 *                       or a bare array of class names
 *   Selectors whose element is knowingly not mounted in the recorded page state
 *   (the dock scrim only exists while a dock is open) are reported as SKIP when the
 *   file records them as { "absent": [...] }.
 */
import fs from 'node:fs'
import { readTemplate, templateCssRules } from '../lib/patch-rules.mjs'

const [fixturePath] = process.argv.slice(2)
if (!fixturePath) {
  console.error('usage: node tools/check-selectors.mjs <live-classes.json>')
  process.exit(2)
}

const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, ''))
const live = new Set(Array.isArray(raw) ? raw : raw.live ?? [])
const knownAbsent = new Set(Array.isArray(raw) ? [] : raw.absent ?? [])
if (live.size === 0) {
  console.error(`FAILED: ${fixturePath} records no live class names`)
  process.exit(2)
}

const selectors = [...new Set(
  templateCssRules(readTemplate())
    .flatMap((rule) => [...rule.matchAll(/\[class\*="([^"]+)"\]/g)].map((m) => m[1])),
)]

console.log(`fixture   : ${fixturePath} (${live.size} class names)`)
console.log(`selectors : ${selectors.length}\n`)

let failed = 0
let skipped = 0
for (const selector of selectors) {
  const exact = [...live].filter((c) => c.includes(selector))
  if (exact.length > 0) {
    console.log(`OK   [class*="${selector}"] -> ${exact.length} match(es)  ${exact.slice(0, 2).join(', ')}`)
    continue
  }
  if (knownAbsent.has(selector)) {
    skipped += 1
    console.log(`SKIP [class*="${selector}"] -> element not mounted in the recorded page state`)
    continue
  }
  failed += 1
  const nearMiss = [...live].filter((c) => c.replace(/_+$/, '') === selector.replace(/_+$/, '') || c.startsWith(selector))
  console.log(
    `MISS [class*="${selector}"] -> no match.` +
    (nearMiss.length ? ` NEAR MISS: ${nearMiss.slice(0, 3).join(', ')} (wrong character?)` : ''),
  )
}

console.log(
  failed
    ? `\nFAILED: ${failed} selector(s) cannot match anything the app renders`
    : `\nresult  : OK — every class* selector matches a recorded live class name${skipped ? ` (${skipped} not mounted)` : ''}`,
)
process.exit(failed ? 1 : 0)
