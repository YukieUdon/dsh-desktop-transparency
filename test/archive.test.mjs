/**
 * Archive reader/writer tests. These run against synthetic archives whose layout
 * mirrors DSH's real one (string offsets, numeric sizes, integrity hash + blocks),
 * plus an optional integration pass over a real archive when
 * `DSH_OFFICIAL_ASAR` points at an official backup.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

import {
  applyEdits,
  buildArchive,
  entryAt,
  parseArchive,
  patchArchive,
  readEntry,
  sha256,
  verifyIntegrity,
  verifyRoundTrip,
} from '../lib/archive.mjs'
import { resolveEdits } from '../lib/patch-rules.mjs'
import { buildSyntheticAsar, PATCHABLE_BLOCK_SIZE, syntheticMainJs, syntheticMainJsPatchable } from './synthetic-asar.mjs'

test('parses a synthetic archive and reports its layout', () => {
  const buf = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJs() },
    { path: 'package.json', content: '{"name":"x"}' },
  ])
  const archive = parseArchive(buf)
  assert.equal(archive.all.length, 2)
  assert.equal(archive.unpacked, 0)
  assert.equal(archive.dataStart + archive.packed, buf.length)
  assert.equal(readEntry(archive, 'package.json').toString('utf8'), '{"name":"x"}')
  assert.ok(entryAt(archive.json, 'lib/main.js'))
  assert.equal(entryAt(archive.json, 'nope.js'), null)
})

test('applies the real patch rules to lib/main.js', () => {
  const buf = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
  ])
  const result = patchArchive(buf, { edits: resolveEdits() })
  const text = readEntry(parseArchive(result.buffer), 'lib/main.js').toString('utf8')

  assert.match(text, /transparent: true/)
  assert.match(text, /backgroundColor: "#00000000"/)
  assert.match(text, /backgroundMaterial: "acrylic"/)
  assert.match(text, /installWindowsTransparency\(window\)/)
  assert.match(text, /roundWindowsCorners\(window\)/)
  assert.match(text, /DwmSetWindowAttribute/)
  assert.match(text, /__dshDesktopTransparencyCss/)
  // The fade rule must survive with its exact class substring.
  assert.match(text, /\[class\*="_9lTDKa_fade"\]/)
  assert.doesNotMatch(text, /\[class\*="_9lTDKa_fade_"\]/)
  // The original createWindow signature is re-declared exactly once.
  assert.equal(text.split('function createWindow(preload, show = false, primary = false) {').length - 1, 1)
  assert.equal(result.roundTrip.identical, 0)
  assert.equal(result.roundTrip.patched, 1)
})

test('every untouched entry stays byte-identical and integrity is preserved', () => {
  const payload = Buffer.from('a'.repeat(4096))
  const source = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
    { path: 'lib/other.js', content: payload },
    { path: 'README.md', content: '# hi' },
  ])
  const sourceArchive = parseArchive(source)
  const before = verifyIntegrity(sourceArchive)

  const patched = patchArchive(source, { edits: resolveEdits() })
  const patchedArchive = parseArchive(patched.buffer)

  assert.equal(verifyIntegrity(patchedArchive), before)
  for (const path of ['lib/other.js', 'README.md']) {
    assert.deepEqual(readEntry(patchedArchive, path), readEntry(sourceArchive, path), `${path} changed`)
  }
})

test('a stale anchor refuses to patch instead of writing', () => {
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: 'function createWindow() {}\n' }])
  assert.throws(
    () => patchArchive(buf, { edits: resolveEdits() }),
    /matched 0 time\(s\), expected 1/,
  )
})

test('an anchor that matches twice refuses to patch', () => {
  const duplicated = `${syntheticMainJs()}\n${syntheticMainJs()}`
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: duplicated }])
  assert.throws(() => patchArchive(buf, { edits: resolveEdits() }), /matched 2 time\(s\), expected 1/)
})

test('rejects a patched entry with no integrity metadata', () => {
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJs(), omitIntegrity: true }])
  assert.throws(() => patchArchive(buf, { edits: resolveEdits() }), /no integrity\.hash to update/)
})

test('refuses a patch that would change the integrity block count', () => {
  // A ~700-byte entry is one 4096-byte integrity block; the ~6 KB template pushes it
  // to two. The header cannot carry a longer blocks array, so this must fail loudly
  // instead of writing an archive Electron would reject.
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJs() }])
  const archive = parseArchive(buf)
  assert.equal(entryAt(archive.json, 'lib/main.js').integrity.blocks.length, 1)
  assert.throws(() => patchArchive(buf, { edits: resolveEdits() }), /block-count changes are not supported|integrity/)
})

test('rejects a header whose pickle length fields disagree', () => {
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJs() }])
  const broken = Buffer.from(buf)
  broken.writeUInt32LE(0, 12)
  assert.throws(() => parseArchive(broken), /header length fields disagree/)
})

test('rejects an archive whose packed size does not match the file length', () => {
  const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJs() }])
  // Cut bytes off the *data* section: the head still parses, but the entries no
  // longer add up to the file length — the check that catches a truncated download.
  const truncated = buf.subarray(0, buf.length - 4)
  assert.throws(() => parseArchive(truncated), /layout check failed/)
})

test('rejects bytes that are not an asar at all', () => {
  assert.throws(() => parseArchive(Buffer.from('PK\u0003\u0004not an asar')), /not an asar archive/)
})

test('applyEdits reports what it substituted', () => {
  const { text, report } = applyEdits('a.js', 'one two', [{ id: 'x', find: 'two', replace: 'three' }])
  assert.equal(text, 'one three')
  assert.deepEqual(report, ['x: 1 hit(s)'])
})

test('buildArchive keeps offsets/sizes consistent for a large replacement', () => {
  const buf = buildSyntheticAsar([
    { path: 'lib/main.js', content: syntheticMainJsPatchable(), blockSize: PATCHABLE_BLOCK_SIZE },
    // A big block keeps this entry's block count stable while it grows; the
    // block-count rule itself is covered by its own test.
    { path: 'lib/z.js', content: 'after me', blockSize: PATCHABLE_BLOCK_SIZE },
  ])
  const archive = parseArchive(buf)
  // Grow the *other* file: lib/z.js is too small to have integrity metadata, so the
  // block-count rule does not apply, and this isolates offset rewriting.
  const grown = Buffer.concat([readEntry(archive, 'lib/z.js'), Buffer.from('\n'.repeat(5000))])
  const out = buildArchive(archive, new Map([['lib/z.js', grown]]))
  const reread = parseArchive(out)
  assert.equal(verifyRoundTrip(out, archive, new Map([['lib/z.js', grown]])).patched, 1)
  assert.equal(readEntry(reread, 'lib/z.js').length, grown.length)
  assert.deepEqual(
    readEntry(reread, 'lib/main.js'),
    readEntry(archive, 'lib/main.js'),
    'the untouched entry must not move or change',
  )
})

test('sha256 matches node crypto', () => {
  assert.equal(sha256(Buffer.from('abc')), createHash('sha256').update('abc').digest('hex'))
})

// Integration: only when a real official archive is available.
const official = process.env.DSH_OFFICIAL_ASAR
test('integration: patches a real official archive', { skip: !official || !fs.existsSync(official) }, () => {
  const source = fs.readFileSync(official)
  const result = patchArchive(source, { edits: resolveEdits() })
  assert.equal(result.before.entries, result.after.entries)
  assert.ok(result.after.bytes > result.before.bytes)
  const patched = parseArchive(result.buffer)
  const text = readEntry(patched, 'lib/main.js').toString('utf8')
  assert.match(text, /__dshDesktopTransparencyCss/)
  assert.match(text, /\[class\*="_9lTDKa_fade"\]/)
  // Every other entry must be untouched.
  assert.equal(result.roundTrip.identical, result.before.entries - result.before.unpacked - 1)
})
