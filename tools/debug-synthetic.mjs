import { buildSyntheticAsar, syntheticMainJs } from '../test/synthetic-asar.mjs'

const buf = buildSyntheticAsar([{ path: 'lib/main.js', content: syntheticMainJs() }])
const jsonSize = buf.readUInt32LE(12)
const js = buf.subarray(16, 16 + jsonSize).toString('utf8')
console.log('buffer     :', buf.length, 'jsonSize field:', jsonSize, 'actual string length:', js.length)
console.log('JSON.parse :', (() => { try { JSON.parse(js); return 'OK' } catch (e) { return e.message } })())

let inStr = false
let esc = false
const braces = []
for (let i = 0; i < js.length; i += 1) {
  const c = js[i]
  if (inStr) {
    if (esc) esc = false
    else if (c === '\\') esc = true
    else if (c === '"') inStr = false
    continue
  }
  if (c === '"') inStr = true
  else if (c === '{' || c === '}') braces.push(`${c}@${i}`)
}
console.log('braces     :', braces.join(' '))
console.log('trimmed len:', js.trimEnd().length)
console.log('tail       :', JSON.stringify(js.slice(js.trimEnd().length - 20, js.trimEnd().length + 10)))

const { parseArchive } = await import('../lib/archive.mjs')
// Replicate the reader's scan inline so the exact stop position is visible.
{
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  const events = []
  for (let i = 16; i < buf.length; i += 1) {
    const c = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) { depth += 1; if (events.length < 12) events.push(`{@${i} d=${depth}`) }
    else if (c === 0x7d) { depth -= 1; if (events.length < 12) events.push(`}@${i} d=${depth}`); if (depth === 0) { end = i + 1; break } }
  }
  console.log('scan end   :', end, '=> jsonSize', end - 16)
  console.log('scan events:', events.join(' '))
  console.log('byte at 283:', buf[283], JSON.stringify(String.fromCharCode(buf[283])))
}

try {
  const a = parseArchive(buf)
  console.log('parseArchive OK: jsonSize', a.jsonSize, 'entries', a.all.length, 'dataStart', a.dataStart)
} catch (error) {
  console.log('parseArchive FAILED:', error.message)
}

