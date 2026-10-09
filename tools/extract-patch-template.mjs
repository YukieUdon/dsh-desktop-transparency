#!/usr/bin/env node
/**
 * extract-patch-template.mjs — pull the transparency header out of a *verified
 * patched* archive and write it as this package's canonical template.
 *
 * The template is the only part of the patch that is a large code block, and every
 * byte of it matters: DSH's own `lib/main.js` must keep compiling after it is
 * substituted in. Copying it from an archive that already ran (and that the old
 * project's verifier accepted) is safer than retyping it from memory.
 *
 * The file is written verbatim as JavaScript source, so it is written with the
 * string quoting the archive uses. The patcher reads it as text and never parses
 * it, which keeps escaping out of the picture entirely.
 *
 * Usage: node tools/extract-patch-template.mjs <patched.asar> <out-file>
 */
import fs from 'node:fs'
import path from 'node:path'

const [asarPath, outFile] = process.argv.slice(2)
if (!asarPath || !outFile) {
  console.error('usage: node tools/extract-patch-template.mjs <patched.asar> <out-file>')
  process.exit(2)
}

const buf = fs.readFileSync(asarPath)
if (buf.readUInt32LE(0) !== 4) throw new Error(`unexpected pickle start code ${buf.readUInt32LE(0)}`)
let depth = 0
let inString = false
let escaped = false
let end = -1
for (let i = 16; i < buf.length; i += 1) {
  const c = buf[i]
  if (inString) {
    if (escaped) escaped = false
    else if (c === 0x5c) escaped = true
    else if (c === 0x22) inString = false
    continue
  }
  if (c === 0x22) inString = true
  else if (c === 0x7b) depth += 1
  else if (c === 0x7d) { depth -= 1; if (depth === 0) { end = i + 1; break } }
}
const json = JSON.parse(buf.subarray(16, end).toString('utf8'))
const dataStart = (end + 7) & ~7
let node = json
for (const part of 'lib/main.js'.split('/')) node = node.files[part]
if (!node || node.files) throw new Error('lib/main.js not found')
const text = buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size)).toString('utf8')

// The patched file contains the header we substituted for the original
// `function createWindow(preload, show = false, primary = false) {` line, and the
// header ends with that same line (it re-declares it). Slice from our comment
// banner to the end of the createWindow signature.
const start = text.indexOf('/**\n* Desktop-only appearance for the Windows product window.')
if (start < 0) throw new Error('transparency header banner not found in the patched main.js')
const signature = 'function createWindow(preload, show = false, primary = false) {'
const sigAt = text.indexOf(signature, start)
if (sigAt < 0) throw new Error('createWindow signature not found after the banner')
const header = text.slice(start, sigAt + signature.length)

// Fail loudly if the CSS array lost rules on the way out. Count the array entries
// by their closing `'` or `",` at the end of a line — escaping-independent.
const ruleCount = (header.match(/',?\n\t'|\\",?\n\t'/g) || []).length
if (ruleCount < 10) throw new Error(`only ${ruleCount} CSS rules found in the header — refusing to write a template`)

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
fs.writeFileSync(outFile, header, 'utf8')
console.log(`wrote ${outFile}`)
console.log(`bytes       : ${Buffer.byteLength(header, 'utf8')}`)
console.log(`css rules   : ${ruleCount}`)
console.log(`has marker  : ${header.includes('__dshDesktopTransparencyCss')}`)
console.log(`has corners : ${header.includes('DwmSetWindowAttribute')}`)
