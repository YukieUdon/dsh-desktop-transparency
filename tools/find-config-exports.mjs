#!/usr/bin/env node
/**
 * find-config-exports.mjs — locate how shipped Host plugins declare `Config`.
 *
 * Needed because Cordis validates a plugin row's `config` through the exported binding:
 * a plain JSON-Schema literal makes `resolveConfig` throw
 * `Cannot read properties of undefined (reading 'validate')`. Reading one real export is
 * faster and more honest than guessing the API.
 *
 * Usage: node tools/find-config-exports.mjs <app.asar> [maxFiles]
 */
import fs from 'node:fs'

const [asarPath, maxArg] = process.argv.slice(2)
const maxFiles = Number(maxArg) || 400
if (!asarPath) {
  console.error('usage: node tools/find-config-exports.mjs <app.asar> [maxFiles]')
  process.exit(2)
}

const buf = fs.readFileSync(asarPath)
if (buf.readUInt32LE(0) !== 4) throw new Error('unexpected pickle start code')
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

const leaves = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (entry.files) walk(entry, p)
    else leaves.push({ path: p.replace(/^\//, ''), entry })
  }
}
walk(json, '')

const candidates = leaves.filter((l) => /\/lib\/index\.js$/.test(l.path) && !l.entry.unpacked)
let inspected = 0
for (const leaf of candidates.slice(0, maxFiles)) {
  inspected += 1
  const text = buf
    .subarray(dataStart + Number(leaf.entry.offset), dataStart + Number(leaf.entry.offset) + Number(leaf.entry.size))
    .toString('utf8')
  if (!/export\s+(const|let)\s+Config\b/.test(text)) continue
  const at = text.search(/export\s+(const|let)\s+Config\b/)
  const snippet = text.slice(at, at + 320)
  console.log(`\n=== ${leaf.path} ===`)
  console.log(snippet)
  if (inspected > 120) break
}
console.log(`\ninspected ${inspected} file(s)`)
