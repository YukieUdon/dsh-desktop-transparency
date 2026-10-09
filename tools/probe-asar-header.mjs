/**
 * probe-asar-header.mjs — print how the scanner that locates the header JSON
 * behaves on real and synthetic archives. Diagnostic only; the authoritative
 * reader is lib/archive.mjs.
 *
 * Usage: node tools/probe-asar-header.mjs <archive...>
 */
import fs from 'node:fs'

function scan(buf) {
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
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  return end
}

for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file)
  const field = buf.readUInt32LE(12)
  const end = scan(buf)
  const jsonSize = end - 16
  // how much trailing whitespace is inside the declared payload?
  const declared = buf.subarray(16, 16 + field).toString('utf8')
  const trimmed = declared.replace(/\s+$/, '')
  console.log(`file         : ${file}`)
  console.log(`  bytes      : ${buf.length}`)
  console.log(`  u32@0..15  : ${[0, 4, 8, 12].map((o) => buf.readUInt32LE(o)).join(', ')}`)
  console.log(`  scan end   : ${end} -> jsonSize ${jsonSize}`)
  console.log(`  declared   : ${field}`)
  console.log(`  trimmed len: ${trimmed.length}`)
  console.log(`  parse OK   : ${(() => { try { JSON.parse(declared); return 'yes' } catch (e) { return e.message } })()}`)
  console.log(`  trimmed OK : ${(() => { try { JSON.parse(trimmed); return 'yes' } catch (e) { return e.message } })()}`)
  console.log(`  head bytes : ${JSON.stringify(declared.slice(0, 40))}`)
  console.log(`  tail bytes : ${JSON.stringify(declared.slice(-40))}`)
}
