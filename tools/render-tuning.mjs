#!/usr/bin/env node
/**
 * render-tuning.mjs — show what the glass tuning actually renders to.
 *
 * Why this exists: `lib/glass-tuning.mjs` holds the values and `lib/patch-template.js`
 * refers to them as `${…}`, but what a build splices into DSH's `main.js` is the rendered
 * result. Without this tool, "what did I just set?" means patching an archive or reading
 * the template by hand.
 *
 * Usage:
 *   node tools/render-tuning.mjs                                  # values + the rendered CSS
 *   node tools/render-tuning.mjs --set __dshGlassCodeBg=transparent   # preview (repeatable)
 *   node tools/render-tuning.mjs --out block.js                   # write the rendered block
 *   node tools/render-tuning.mjs --compare <spec.json>            # check against the old
 *                                                                 # project's spec
 *
 * `--compare` is for whoever also runs the original hand-patched project: it compares the
 * *sources* (anchors and rule text, placeholders and all) — which must be identical — and
 * then *reports* tuning differences, which are legitimate because the two artifacts ship
 * their own defaults.
 */
import fs from 'node:fs'

const { glassTuning, renderGlassTuning } = await import('../lib/glass-tuning.mjs')
const { mainJsEdits, readTemplate, templateCssRules } = await import('../lib/patch-rules.mjs')

const argv = process.argv.slice(2)
const takeValue = (name) => {
  const at = argv.indexOf(name)
  if (at < 0) return null
  const value = argv[at + 1]
  return value === undefined || value.startsWith('--') ? '' : value
}

const outPath = takeValue('--out')
const comparePath = takeValue('--compare')
const overrides = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--set') continue
  const pair = argv[i + 1] ?? ''
  const eq = pair.indexOf('=')
  if (eq <= 0) {
    console.error(`--set needs KEY=VALUE, got ${JSON.stringify(pair)}`)
    process.exit(2)
  }
  overrides[pair.slice(0, eq)] = pair.slice(eq + 1)
}

const values = { ...glassTuning, ...overrides }
console.log(`tuning : ${Object.keys(values).length} value(s)${Object.keys(overrides).length ? ` (${Object.keys(overrides).length} from --set)` : ''}`)
for (const [name, value] of Object.entries(values)) {
  console.log(`         ${name} = ${value}${name in overrides ? '   (--set: preview only)' : ''}`)
}

const rendered = renderGlassTuning(readTemplate(), values, 'patch-template.js').text
const rules = templateCssRules(rendered)
console.log(`\ncss    : ${rules.length} rule(s), as spliced into lib/main.js`)
for (const rule of rules) console.log(`         ${rule}`)

if (outPath) {
  fs.writeFileSync(outPath, rendered)
  console.log(`\nwrote  : ${outPath} (${rendered.length} bytes)`)
}

if (comparePath) {
  if (!fs.existsSync(comparePath)) {
    console.error(`\ncompare: no spec at ${comparePath}`)
    process.exit(1)
  }
  const spec = JSON.parse(fs.readFileSync(comparePath, 'utf8').replace(/^\uFEFF/, ''))
  const specEdits = spec.files?.['lib/main.js']?.edits ?? []
  const theirs = mainJsEdits.map((edit) => ({
    id: edit.id,
    find: edit.find,
    replace: edit.replaceTemplate ? readTemplate() : edit.replace,
  }))
  const problems = []
  if (specEdits.length !== theirs.length) problems.push(`${specEdits.length} edit(s) in the spec, ${theirs.length} here`)
  specEdits.forEach((specEdit, i) => {
    const theirsEdit = theirs[i]
    if (theirsEdit === undefined) return
    if (specEdit.find !== theirsEdit.find) problems.push(`edit #${i} (${theirsEdit.id}): anchors differ`)
    if (specEdit.replace !== theirsEdit.replace) problems.push(`edit #${i} (${theirsEdit.id}): rule text differs`)
  })
  if (problems.length > 0) {
    console.error(`\ncompare: the spec and this package disagree`)
    for (const problem of problems) console.error(`         - ${problem}`)
    process.exit(1)
  }
  console.log(`\ncompare: ${theirs.length} edit(s) structurally identical to ${comparePath}`)
  const specValues = Object.fromEntries(Object.entries(spec.params ?? {}).filter(([key]) => key.startsWith('__')))
  const drift = Object.entries(specValues).filter(([name, value]) => name in glassTuning && glassTuning[name] !== value)
  if (drift.length === 0) console.log('values : both are tuned the same (so both build the same archive)')
  else {
    console.log('values : the two are tuned differently — expected, they are separate defaults:')
    for (const [name, value] of drift) console.log(`         ${name}: spec says ${value} | this package ${glassTuning[name]}`)
  }
}
