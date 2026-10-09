import { patchArchive, reconstructOfficial, parseArchive, readEntry } from '../lib/archive.mjs'
import { resolveEdits } from '../lib/patch-rules.mjs'
import { buildSyntheticAsar, PATCHABLE_BLOCK_SIZE, syntheticMainJsPatchable } from '../test/synthetic-asar.mjs'

const official = buildSyntheticAsar([
  { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
  { path: 'README.md', content: '# dsh' },
])
const editions = resolveEdits()
const pristine = readEntry(parseArchive(official), 'lib/main.js').toString('utf8')

console.log('=== hits of each edit.replace in the PRISTINE file (must all be 0) ===')
for (const edit of editions) {
  console.log(`  ${edit.id.padEnd(24)} find x${pristine.split(edit.find).length - 1}  replace x${pristine.split(edit.replace).length - 1}`)
}

const patched = patchArchive(official, { edits: editions }).buffer
const patchedText = readEntry(parseArchive(patched), 'lib/main.js').toString('utf8')

console.log('\n=== hits of each edit.replace in the PATCHED file (must all be 1) ===')
for (const edit of editions) {
  console.log(`  ${edit.id.padEnd(24)} find x${patchedText.split(edit.find).length - 1}  replace x${patchedText.split(edit.replace).length - 1}`)
}

// which reverse step breaks?
let text = patchedText
for (const edit of [...editions].reverse()) {
  const hits = text.split(edit.replace).length - 1
  console.log(`\nreverse ${edit.id}: replace x${hits}`)
  if (hits !== 1) {
    const anchor = edit.replace.slice(0, 60)
    console.log('  looking for:', JSON.stringify(anchor))
    const at = text.indexOf(anchor.slice(0, 40))
    console.log('  first 40 chars at index:', at)
    if (at >= 0) console.log('  context:', JSON.stringify(text.slice(Math.max(0, at - 60), at + 100)))
    break
  }
  text = text.split(edit.replace).join(edit.find)
}
