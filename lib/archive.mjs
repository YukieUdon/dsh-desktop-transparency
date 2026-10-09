/**
 * Minimal, verifiable reader/writer for an Electron `app.asar`.
 *
 * Layout, verified against the archives DSH ships with (12,967 entries):
 *   u32 @0   4                (the pickle's inner u32 length)
 *   u32 @4   jsonSize + 8     (string size)
 *   u32 @8   jsonSize + 4     (inner size)
 *   u32 @12  jsonSize         (payload size)
 *   JSON     from @16, jsonSize bytes; offsets/sizes inside are JSON strings/numbers
 *   padding  to an 8-byte boundary, then packed file data
 *
 * The writer never re-serializes the header. It substitutes `"offset":…` and
 * `"size":…` text inside the original bytes, so every field this tool does not
 * intend to touch survives byte-for-byte and the header keeps its length.
 *
 * Everything here refuses to write rather than guessing: a wrong offset field or a
 * stale integrity hash makes Electron fall back to its bundled default app with no
 * error in the UI, which is indistinguishable from "the patch did nothing".
 */
import { createHash } from 'node:crypto'

// Deliberately not `node:fs`: the archive is invisible to the asar-aware fs the desktop
// host inherits from Electron (it reads `resources\app.asar` as a directory, and
// `readFileSync` on it throws ENOENT). fs-io.mjs resolves the fs that can see the file.
import fs from './fs-io.mjs'

const ALIGN = 8
const PICKLE_START = 4

export class AsarError extends Error {}

function fail(message) {
  throw new AsarError(message)
}

/**
 * Reads the header and returns everything the writer needs.
 * @param {Buffer} buf
 */
export function parseArchive(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== PICKLE_START) {
    fail(`not an asar archive: expected pickle start code ${PICKLE_START}`)
  }
  // Locate the JSON by brace matching: the closing brace is exact, the pickle's
  // length fields are exactly what a bad writer gets wrong.
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
  if (end < 0) fail('header JSON is unterminated')

  const jsonSize = end - 16
  const stringSize = buf.readUInt32LE(4)
  const innerSize = buf.readUInt32LE(8)
  const payloadSize = buf.readUInt32LE(12)
  if (stringSize !== jsonSize + 8 || innerSize !== jsonSize + 4 || payloadSize !== jsonSize) {
    fail(
      `header length fields disagree with the JSON: stringSize=${stringSize} innerSize=${innerSize} ` +
      `payloadSize=${payloadSize} for jsonSize=${jsonSize}`,
    )
  }

  let json
  try {
    json = JSON.parse(buf.subarray(16, end).toString('utf8'))
  } catch (error) {
    fail(`header JSON does not parse: ${error.message}`)
  }

  const dataStart = (end + (ALIGN - 1)) & ~(ALIGN - 1)
  const all = leaves(json)
  const packed = all.reduce((sum, { entry }) => sum + (entry.unpacked ? 0 : Number(entry.size)), 0)
  if (dataStart + packed !== buf.length) {
    fail(
      `layout check failed: dataStart(${dataStart}) + packed(${packed}) = ${dataStart + packed}, ` +
      `but the archive is ${buf.length} bytes`,
    )
  }
  const unpacked = all.filter(({ entry }) => entry.unpacked).length
  return { buf, json, jsonSize, dataStart, packed, unpacked, all }
}

export function readArchiveFile(file) {
  return parseArchive(fs.readFileSync(file))
}

/** Every file entry, flattened, in archive order. */
export function leaves(node, prefix = '', out = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (entry.files) leaves(entry, p, out)
    else out.push({ path: p.replace(/^\//, ''), entry })
  }
  return out
}

export function entryAt(root, filePath) {
  let node = root
  for (const part of filePath.split('/')) {
    node = node?.files?.[part]
    if (!node) return null
  }
  return node.files ? null : node
}

export function readEntry(archive, filePath) {
  const entry = entryAt(archive.json, filePath)
  if (!entry) fail(`entry not found: ${filePath}`)
  if (entry.files) fail(`${filePath} is a directory`)
  if (entry.unpacked) fail(`${filePath} is stored unpacked and has no bytes in the archive`)
  return archive.buf.subarray(
    archive.dataStart + Number(entry.offset),
    archive.dataStart + Number(entry.offset) + Number(entry.size),
  )
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Applies `{find, replace, expect}` edits to one file's text.
 * @returns {{text: string, report: string[]}}
 */
export function applyEdits(filePath, original, edits) {
  let text = original
  const report = []
  edits.forEach((edit, i) => {
    if (typeof edit.find !== 'string') fail(`edit #${i} for ${filePath} needs a "find" string`)
    if (typeof edit.replace !== 'string') fail(`edit #${i} for ${filePath} needs a "replace" string`)
    const parts = text.split(edit.find)
    const hits = parts.length - 1
    const expect = edit.expect ?? 1
    if (hits !== expect) {
      fail(
        `edit #${i} (${edit.id ?? 'unnamed'}) for ${filePath} matched ${hits} time(s), expected ${expect}` +
        `${hits === 0 ? ' — the anchor is stale for this DSH version; refusing to write' : ''}`,
      )
    }
    text = parts.join(edit.replace)
    report.push(`${edit.id ?? `edit#${i}`}: ${hits} hit(s)`)
  })
  return { text, report }
}

/**
 * Rebuilds the archive with `replacements` (a Map of entry path -> Buffer).
 * @returns {Buffer}
 */
export function buildArchive(archive, replacements) {
  const { buf, jsonSize, dataStart } = archive
  const chunks = []
  let cursor = 0
  for (const { path: filePath, entry } of archive.all) {
    if (entry.unpacked) continue
    const replacement = replacements.get(filePath)
    const data = replacement ?? buf.subarray(
      dataStart + Number(entry.offset),
      dataStart + Number(entry.offset) + Number(entry.size),
    )
    chunks.push({ filePath, entry, offset: cursor, data, replaced: Boolean(replacement) })
    cursor += data.length
  }

  let header = buf.subarray(16, 16 + jsonSize).toString('latin1')
  const rewrites = chunks
    .filter((c) => String(c.entry.offset) !== String(c.offset) || Number(c.entry.size) !== c.data.length)
    .sort((a, b) => Number(b.entry.offset) - Number(a.entry.offset))

  for (const chunk of rewrites) {
    // Field types differ per key and must be preserved exactly:
    // offset is a JSON string, size a JSON number. Writing size as a string makes
    // Electron reject the archive with "Invalid package".
    if (Number(chunk.entry.size) !== chunk.data.length) {
      const oldSize = `"size":${Number(chunk.entry.size)}`
      if (!header.includes(oldSize)) fail(`size anchor for ${chunk.filePath} not found in the header (${oldSize})`)
      header = header.replace(oldSize, `"size":${chunk.data.length}`)
    }
    if (String(chunk.entry.offset) !== String(chunk.offset)) {
      const wasString = typeof chunk.entry.offset === 'string'
      const from = wasString ? `"offset":${JSON.stringify(String(chunk.entry.offset))}` : `"offset":${Number(chunk.entry.offset)}`
      const to = wasString ? `"offset":${JSON.stringify(String(chunk.offset))}` : `"offset":${chunk.offset}`
      if (!header.includes(from)) fail(`offset anchor for ${chunk.filePath} not found in the header`)
      header = header.replace(from, to)
    }
  }

  // Electron verifies integrity.hash (SHA256 of the content, split into blockSize
  // chunks) and silently falls back to its default app when a checked file fails.
  for (const chunk of chunks) {
    if (!chunk.replaced) continue
    const integrity = chunk.entry.integrity
    if (!integrity || typeof integrity.hash !== 'string') {
      fail(`patched entry ${chunk.filePath} has no integrity.hash to update; Electron would reject the archive`)
    }
    const algorithm = String(integrity.algorithm ?? 'SHA256').toLowerCase().replace('-', '')
    const blockSize = Number(integrity.blockSize) || chunk.data.length
    const hashOf = (bytes) => createHash(algorithm).update(bytes).digest('hex')
    const newHash = hashOf(chunk.data)
    const newBlocks = []
    for (let from = 0; from < chunk.data.length; from += blockSize) {
      newBlocks.push(hashOf(chunk.data.subarray(from, Math.min(from + blockSize, chunk.data.length))))
    }
    const substitute = (text, from, to) => {
      if (!text.includes(from)) fail(`integrity anchor for ${chunk.filePath} not found in the header: ${from}`)
      return text.replace(from, to)
    }
    if (integrity.hash !== newHash) header = substitute(header, `"hash":"${integrity.hash}"`, `"hash":"${newHash}"`)
    const oldBlocks = Array.isArray(integrity.blocks) ? integrity.blocks : []
    if (newBlocks.length !== oldBlocks.length) {
      fail(
        `patched entry ${chunk.filePath} now needs ${newBlocks.length} integrity block(s) but the header has ` +
        `${oldBlocks.length}; block-count changes are not supported`,
      )
    }
    oldBlocks.forEach((old, i) => {
      if (old !== newBlocks[i]) header = substitute(header, `"${old}"`, `"${newBlocks[i]}"`)
    })
  }

  if (header.length > jsonSize + 64) fail(`header grew by ${header.length - jsonSize} bytes, which is not supported`)
  if (header.length < jsonSize) fail(`header shrank by ${jsonSize - header.length} bytes; pad the JSON instead`)
  const outHeaderSize = header.length
  const outDataStart = (16 + outHeaderSize + (ALIGN - 1)) & ~(ALIGN - 1)

  const head = Buffer.alloc(outDataStart)
  head.writeUInt32LE(PICKLE_START, 0)
  head.writeUInt32LE(outHeaderSize + 8, 4)
  head.writeUInt32LE(outHeaderSize + 4, 8)
  head.writeUInt32LE(outHeaderSize, 12)
  head.write(header, 16, 'latin1')

  return Buffer.concat([head, ...chunks.map((c) => c.data)])
}

/**
 * Proves a rebuilt archive round-trips: every untouched packed entry byte-identical,
 * every patched entry equal to its replacement.
 *
 * Unpacked entries carry no bytes in the archive (their content lives beside it in
 * `app.asar.unpacked`), so they are counted but not compared.
 */
export function verifyRoundTrip(outBuf, sourceArchive, replacements) {
  const check = parseArchive(outBuf)
  if (check.all.length !== sourceArchive.all.length) {
    fail(`entry count changed: ${sourceArchive.all.length} -> ${check.all.length}`)
  }
  let identical = 0
  let patched = 0
  let skippedUnpacked = 0
  for (const { path: filePath, entry } of check.all) {
    if (entry.unpacked) {
      skippedUnpacked += 1
      continue
    }
    const got = readEntry(check, filePath)
    if (replacements.has(filePath)) {
      if (!got.equals(replacements.get(filePath))) fail(`patched entry ${filePath} did not round-trip`)
      patched += 1
    } else {
      const want = readEntry(sourceArchive, filePath)
      if (!got.equals(want)) fail(`untouched entry ${filePath} is not byte-identical`)
      identical += 1
    }
  }
  return { identical, patched, skippedUnpacked, entries: check.all.length }
}

/** Every entry's integrity metadata must match its content. */
export function verifyIntegrity(archive) {
  let checked = 0
  for (const { path: filePath, entry } of archive.all) {
    if (entry.unpacked) continue
    const integrity = entry.integrity
    if (!integrity || typeof integrity.hash !== 'string') continue
    const bytes = readEntry(archive, filePath)
    const algorithm = String(integrity.algorithm ?? 'SHA256').toLowerCase().replace('-', '')
    const hashOf = (b) => createHash(algorithm).update(b).digest('hex')
    if (integrity.hash !== hashOf(bytes)) fail(`${filePath} integrity.hash does not match its content`)
    if (Array.isArray(integrity.blocks)) {
      const blockSize = Number(integrity.blockSize) || bytes.length
      integrity.blocks.forEach((block, i) => {
        const chunk = bytes.subarray(i * blockSize, Math.min(i * blockSize + blockSize, bytes.length))
        if (block !== hashOf(chunk)) fail(`${filePath} integrity.blocks[${i}] mismatch`)
      })
    }
    checked += 1
  }
  return checked
}

/**
 * Parses `source` as an ES module. Electron loads `lib/main.js` as ESM, so a
 * substitution that breaks the syntax makes the whole app fall back to its
 * bundled default — with nothing in the UI to say so. This is the cheapest gate
 * that catches a corrupted splice, wrong line endings or a bad template.
 *
 * Implemented by checking a temporary `.mjs` file with the running Node, because
 * `vm.SourceTextModule` needs the `--experimental-vm-modules` flag, which a CLI
 * invocation or the host process does not necessarily carry. When that flag *is*
 * present, the in-process check is used and no file is written.
 *
 * @param {string} source
 * @param {string} [label]
 */
export async function assertParsesAsEsm(source, label = 'lib/main.js') {
  const vm = await import('node:vm')
  if (typeof vm.SourceTextModule === 'function') {
    try {
      // Nothing is evaluated; only the module goal is parsed.
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(source, { identifier: label })
      return
    } catch (error) {
      fail(`${label} does not parse as an ES module after patching: ${error.message}`)
    }
  }
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-transparency-esm-'))
  const file = path.join(dir, 'main.mjs')
  try {
    fs.writeFileSync(file, source, 'utf8')
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const detail = (error.stderr ?? error.stdout ?? Buffer.alloc(0)).toString('utf8').trim().split('\n').slice(0, 4).join(' ')
    fail(`${label} does not parse as an ES module after patching: ${detail || error.message}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Reconstructs the official archive from a patched one by undoing the edits.
 *
 * This exists because a patch can predate any backup: someone applies the patch,
 * the machine keeps no official copy, and later a DSH update or a `restore` has
 * nothing to restore *from*. The edits are deterministic substitutions, so they can
 * be reversed — `replace` becomes `find` and vice versa, in reverse order because
 * `transparency-stylesheet` is the edit that inserts the template.
 *
 * Reverse engineering a wanted binary is only as good as the evidence, so the caller
 * must check the result (size/hash against a known official archive, or at least the
 * absence of the patch marker) before trusting it. This function only refuses the
 * cases where reversal is impossible: an entry that does not contain every
 * replacement.
 *
 * @param {Buffer} patchedBuf
 * @param {{entryPath?: string, edits: Array<{id?: string, find: string, replace: string}>}} options
 */
export function reconstructOfficial(patchedBuf, { entryPath = 'lib/main.js', edits }) {
  const archive = parseArchive(patchedBuf)
  let text = readEntry(archive, entryPath).toString('utf8')
  const undone = []
  for (const edit of [...edits].reverse()) {
    const hits = text.split(edit.replace).length - 1
    if (hits !== 1) {
      fail(
        `cannot reconstruct the official ${entryPath}: the replacement of edit ` +
        `"${edit.id ?? 'unnamed'}" appears ${hits} time(s), expected 1`,
      )
    }
    text = text.split(edit.replace).join(edit.find)
    undone.push(edit.id ?? 'unnamed')
  }
  const replacements = new Map([[entryPath, Buffer.from(text, 'utf8')]])
  const out = buildArchive(archive, replacements)
  const roundTrip = verifyRoundTrip(out, archive, replacements)
  return { buffer: out, undone, roundTrip, officialEntryBytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * Patches `sourceBuf` by replacing `entryPath` text and returns the new archive.
 * Pure: no filesystem access, so it is unit-testable on synthetic archives.
 */
export function patchArchive(sourceBuf, { entryPath = 'lib/main.js', edits, verify = true }) {
  const source = parseArchive(sourceBuf)
  const original = readEntry(source, entryPath).toString('utf8')
  const { text, report } = applyEdits(entryPath, original, edits)
  const replacements = new Map([[entryPath, Buffer.from(text, 'utf8')]])
  const out = buildArchive(source, replacements)
  const roundTrip = verify ? verifyRoundTrip(out, source, replacements) : null
  const patched = out.length ? parseArchive(out) : null
  return {
    buffer: out,
    report,
    roundTrip,
    before: { bytes: sourceBuf.length, entryBytes: original.length, entries: source.all.length, unpacked: source.unpacked },
    after: patched
      ? { bytes: out.length, entryBytes: Buffer.byteLength(text, 'utf8'), entries: patched.all.length }
      : null,
  }
}
