/**
 * Builds tiny synthetic asar archives with the same layout as DSH's real one, so
 * the reader/writer can be tested without a 121 MB installation.
 *
 * Layout (identical to Electron's):
 *   u32 @0   4                pickle start
 *   u32 @4   jsonSize + 8     string size
 *   u32 @8   jsonSize + 4     inner size
 *   u32 @12  jsonSize         payload size
 *   JSON     from @16, jsonSize bytes (trailing spaces are legal JSON whitespace)
 *   padding  to an 8-byte boundary, then packed file data
 *
 * Only metadata goes into the JSON — never file content. The reader locates the
 * header by brace matching, so a `{` inside a JSON string is a lie this format
 * never tells, and a fixture that tells it tests the wrong thing.
 */
import { createHash } from 'node:crypto'

const ALIGN = 8

/**
 * Integrity block size used by the fixtures. Real archives use a fixed block size
 * (Electron hashes the content in chunks), which is what lets a patched file grow
 * without changing the number of block hashes the header has to carry.
 */
const BLOCK_SIZE = 4096

/**
 * Block size for the `lib/main.js` fixture. The patcher cannot grow the `blocks[]`
 * array, so the fixture must stay inside one block even after the ~6 KB template is
 * spliced in — the same situation as the real 490 KB entry, which also sits in a
 * single block.
 */
const BIG_BLOCK_SIZE = 256 * 1024

function integrityFor(bytes, blockSize) {
  const digest = (b) => createHash('sha256').update(b).digest('hex')
  const blocks = []
  for (let from = 0; from < bytes.length; from += blockSize) {
    blocks.push(digest(bytes.subarray(from, Math.min(from + blockSize, bytes.length))))
  }
  return { algorithm: 'SHA256', hash: digest(bytes), blockSize, blocks }
}

/**
 * @param {Array<{path: string, content: string|Buffer, unpacked?: boolean, omitIntegrity?: boolean, blockSize?: number}>} entries
 * @returns {Buffer}
 */
export function buildSyntheticAsar(entries) {
  const root = { files: {} }
  const packed = []

  for (const spec of entries) {
    const parts = spec.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.files[part]) node.files[part] = { files: {} }
      node = node.files[part]
    }
    const bytes = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content, 'utf8')
    const integrity = spec.omitIntegrity ? {} : { integrity: integrityFor(bytes, spec.blockSize ?? BLOCK_SIZE) }
    const entry = { size: bytes.length, offset: '0', ...(spec.unpacked ? { unpacked: true } : {}), ...integrity }
    node.files[parts.at(-1)] = entry
    if (!spec.unpacked) packed.push({ entry, bytes })
  }

  let cursor = 0
  for (const item of packed) {
    item.entry.offset = String(cursor)
    cursor += item.bytes.length
  }

  // Compose the JSON, then derive the size fields from exactly those bytes. A real
  // archive does not pad its JSON: the header is short and the *data* section is
  // what gets 8-byte aligned. (Padding the JSON with spaces makes the parser's
  // brace-matched length disagree with the declared one, which is a fixture bug,
  // not a reader bug — this cost an hour once.)
  const jsonBytes = Buffer.from(JSON.stringify(root), 'utf8')
  const jsonSize = jsonBytes.length

  const dataStart = (16 + jsonSize + (ALIGN - 1)) & ~(ALIGN - 1)
  const head = Buffer.alloc(dataStart)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(jsonSize + 8, 4)
  head.writeUInt32LE(jsonSize + 4, 8)
  head.writeUInt32LE(jsonSize, 12)
  jsonBytes.copy(head, 16)

  return Buffer.concat([head, ...packed.map((item) => item.bytes)])
}

/**
 * Synthetic `lib/main.js` sized so patching it does not change its integrity block
 * count.
 *
 * The patcher cannot grow the `blocks[]` array the header carries, so the fixture
 * must stay inside one block even after the ~6 KB template is spliced in. The real
 * 490 KB entry is in the same situation (one big block), which is why this is
 * representative rather than a workaround: pair it with {@link BIG_BLOCK_SIZE}.
 */
export function syntheticMainJsPatchable() {
  return syntheticMainJs(`/* filler: ${'x'.repeat(200 * 1024)} */`)
}

/** Block size that keeps {@link syntheticMainJsPatchable} inside a single block. */
export const PATCHABLE_BLOCK_SIZE = BIG_BLOCK_SIZE

/**
 * The real patch anchors, repeated here so the fixture can be *assembled from them*
 * instead of written out by hand.
 *
 * This is the fix for a bug class, not a style choice: every hand-written anchor in a
 * fixture is an indentation and wording guess, and a fixture that guesses wrong makes
 * the tests pass while testing nothing (one did exactly that — `titlebar-repaint`
 * reported 0 hits in the fixture while the suite stayed green).
 *
 * `test/anchors.test.mjs` asserts these strings are identical to the ones in
 * `lib/patch-rules.mjs`, so they cannot drift.
 */
export const FIXTURE_ANCHORS = {
  spread: '\t\t...process.platform === "win32" && primary ? {\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: chromeFallbackFill(),',
  titlebar: '\t\t\tif (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({\n\t\t\t\tcolor,\n\t\t\t\tsymbolColor\n\t\t\t});',
  createWindow: 'function createWindow(preload, show = false, primary = false) {',
  windowOpen: '\twindow.webContents.setWindowOpenHandler(({ url }) => {\n\t\tif (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);\n\t\treturn { action: "deny" };\n\t});',
}

/**
 * Minimal `lib/main.js` text whose anchors match the real patch rules.
 *
 * The four anchors appear in the same order and shape as in DSH's own file, so the
 * substitution order that matters for real archives is exercised here too.
 */
export function syntheticMainJs(extra = '') {
  const { spread, titlebar, createWindow, windowOpen } = FIXTURE_ANCHORS
  return [
    'import { shell } from "electron";',
    'import { createRequire } from "node:module";',
    'function chromeFallbackFill() { return "#202020"; }',
    'function validColor(c) { return typeof c === "string"; }',
    // The title-bar code lives in this helper in the pristine file, and the edit that
    // rewrites it targets exactly this one occurrence. It must NOT appear a second time
    // below: DSH updates the overlay here, while the template is what adds the same
    // handling inside createWindow (whose original body the template replaces).
    'function installWindowsAppearance(mainWindow, color, symbolColor) {',
    '\tif (userWantsOverlay) {',
    titlebar,
    '\t}',
    '}',
    createWindow,
    '\tconst options = {',
    '\t\twebPreferences: {},',
    `${spread}\n\t\t\t\tsymbolColor: "#ffffff"\n\t\t\t}\n\t\t} : {}`,
    '\t};',
    '\tconst window = { webContents: { on() {}, insertCSS() { return Promise.resolve(); } }, isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) };',
    windowOpen,
    '\treturn window;',
    '}',
    extra,
    '',
  ].join('\n')
}
