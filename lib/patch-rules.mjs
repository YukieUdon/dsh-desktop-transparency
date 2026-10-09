/**
 * The transparency template and the expectations that guard it.
 *
 * `patch-template.js` is the exact code block substituted into DSH's
 * `lib/main.js` where `createWindow(...)` used to be. It is extracted from a
 * patched archive that already ran on a real installation
 * (`tools/extract-patch-template.mjs`), never retyped by hand: one wrong byte and
 * DSH stops booting, because this block is spliced into code Electron executes.
 *
 * The template is *data* for this package (the patcher substitutes it as text), so
 * it is read here rather than imported as a module. `expectedCssRules` is the
 * independent copy of the CSS the template must contain: when someone edits one
 * and not the other, {@link assertTemplateMatchesRules} fails instead of shipping a
 * patch whose selectors no longer match anything.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const TEMPLATE_PATH = path.join(packageDir, 'lib', 'patch-template.js')

/** CSS the template must carry, in order. Every selector must match live DOM classes. */
export const expectedCssRules = [
  'html,body{background-color:transparent !important}',
  'html[data-platform="win32"] .BynINW_frame{background:transparent !important;background-image:none !important}',
  'html[data-platform="win32"] [data-windows-titlebar] .BynINW_frame:before{',
  'html[data-platform="win32"] .BynINW_centerCol{background:transparent !important;border-left:0 !important}',
  'html[data-platform="win32"] [class*="Dc7zOa_root"]{background:transparent !important}',
  'html[data-platform="win32"] [class*="Dc7zOa_composerSeat"]{background:transparent !important;background-image:none !important}',
  'html[data-platform="win32"] [class*="_emptyTabHost_"]{background:transparent !important}',
  'html[data-platform="win32"] [class*="_dockScrim_"]{display:none !important}',
  'html[data-platform="win32"] [class*="_9lTDKa_fade"]{display:none !important}',
  'html[data-platform="win32"] .BynINW_sidebarCol{',
  'html[data-platform="win32"] [class*="_2H3hWW_root"]{background:transparent !important}',
  'html[data-platform="win32"] [data-ds-dark-theme] .BynINW_sidebarCol{',
]

/** The marker that makes a patched archive identifiable without hashing it. */
export const PATCH_MARKER = '__dshDesktopTransparencyCss'

/** The line the template must end with: it re-declares the function it replaced. */
export const CREATE_WINDOW_SIGNATURE = 'function createWindow(preload, show = false, primary = false) {'

/**
 * Substitutions applied to `lib/main.js`, in order.
 *
 * Order matters and is enforced by {@link diagnoseEdits}: each anchor must match
 * exactly once in DSH's own text, and `transparency-stylesheet` is the one edit
 * that *creates* text (it splices {@link TEMPLATE_PATH} in). The two edits after it
 * target the original file; the original titlebar code is rewritten by
 * `titlebar-repaint` before the template replaces the surrounding function, which is
 * why the patch carries the same logic in two places (inside the template, and as a
 * substitution in DSH's own function).
 */
export const mainJsEdits = [
  {
    id: 'transparent-window',
    why: 'transparent + acrylic window so the desktop shows through',
    find: '\t\t...process.platform === "win32" && primary ? {\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: chromeFallbackFill(),',
    replace: '\t\t...process.platform === "win32" && primary ? {\n\t\t\ttransparent: true,\n\t\t\tbackgroundColor: "#00000000",\n\t\t\tbackgroundMaterial: "acrylic",\n\t\t\ttitleBarStyle: "hidden",\n\t\t\ttitleBarOverlay: {\n\t\t\t\theight: 40,\n\t\t\t\tcolor: "#00000000",',
  },
  {
    id: 'titlebar-repaint',
    why: 'keep the title-bar overlay transparent after the renderer reports its palette',
    find: '\t\t\tif (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({\n\t\t\t\tcolor,\n\t\t\t\tsymbolColor\n\t\t\t});',
    replace: '\t\t\tif (validColor(color) && validColor(symbolColor)) {\n\t\t\t\tmainWindow.setTitleBarOverlay({\n\t\t\t\t\tcolor: "#00000000",\n\t\t\t\t\tsymbolColor\n\t\t\t\t});\n\t\t\t\tapplyWindowsCorners(mainWindow);\n\t\t\t}',
  },
  {
    id: 'transparency-stylesheet',
    why: 'installs the stylesheet, the bounded corner log and the DWM rounding helpers',
    find: CREATE_WINDOW_SIGNATURE,
    replaceTemplate: true,
  },
  {
    id: 'install-stylesheet',
    why: 'wires the stylesheet and corner rounding onto the primary win32 window',
    find: '\twindow.webContents.setWindowOpenHandler(({ url }) => {\n\t\tif (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);\n\t\treturn { action: "deny" };\n\t});',
    replace: '\tif (process.platform === "win32" && primary) {\n\t\tinstallWindowsTransparency(window);\n\t\troundWindowsCorners(window);\n\t}\n\twindow.webContents.setWindowOpenHandler(({ url }) => {\n\t\tif (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);\n\t\treturn { action: "deny" };\n\t});',
  },
]

export function readTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`patch template missing: ${TEMPLATE_PATH}`)
  }
  return fs.readFileSync(TEMPLATE_PATH, 'utf8')
}

/** CSS rules as they appear inside the template, unescaped enough to inspect. */
export function templateCssRules(template = readTemplate()) {
  const start = template.indexOf('= [')
  const end = template.indexOf('].join(', start)
  if (start < 0 || end < 0) throw new Error('the template has no CSS array')
  const body = template.slice(start + 3, end)
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, '').replace(/^'/, '').replace(/'$/, '').replace(/^"/, '').replace(/",?$/, '').replace(/\\"/g, '"'))
}

/**
 * Fails when the template and {@link expectedCssRules} disagree — the check that
 * would have caught a rule silently losing its selector.
 */
export function assertTemplateMatchesRules(template = readTemplate()) {
  const rules = templateCssRules(template)
  if (rules.length !== expectedCssRules.length) {
    throw new Error(`template carries ${rules.length} CSS rules, expected ${expectedCssRules.length}`)
  }
  const problems = []
  expectedCssRules.forEach((expected, i) => {
    if (!rules[i].startsWith(expected)) {
      problems.push(`rule ${i}: expected to start with ${JSON.stringify(expected)}, found ${JSON.stringify(rules[i])}`)
    }
  })
  if (!template.includes(PATCH_MARKER)) problems.push(`template lost the marker ${PATCH_MARKER}`)
  if (!template.includes('DwmSetWindowAttribute')) problems.push('template lost the DWM corner rounding call')
  if (!template.endsWith(CREATE_WINDOW_SIGNATURE)) problems.push(`template must end with ${JSON.stringify(CREATE_WINDOW_SIGNATURE)}`)
  if (problems.length) throw new Error(`patch template is inconsistent:\n  ${problems.join('\n  ')}`)
  return rules
}

/** The concrete `{find, replace, expect}` list the archive patcher runs. */
export function resolveEdits() {
  const template = readTemplate()
  assertTemplateMatchesRules(template)
  return mainJsEdits.map((edit) => ({
    id: edit.id,
    why: edit.why,
    find: edit.find,
    replace: edit.replaceTemplate ? template : edit.replace,
    expect: 1,
  }))
}

/**
 * Checks the edit list against DSH's *own* `lib/main.js`, before anything is
 * written, and reports what each edit would do.
 *
 * The failure this exists for: an edit whose anchor only appears *after* another edit
 * ran. The template re-declares `createWindow`, so code inside it is not in DSH's
 * original text; listing such an anchor as an edit makes the patch refuse to apply on
 * a real archive. Repeated by the second pass: simulating the edits in order (each
 * one seeing the previous output) is the only honest way to check the list.
 *
 * @param {string} mainJs DSH's original `lib/main.js` text
 */
export function diagnoseEdits(mainJs) {
  const edits = resolveEdits()
  const findings = []
  let text = mainJs

  for (const edit of edits) {
    const pristineHits = mainJs.split(edit.find).length - 1
    const hitsNow = text.split(edit.find).length - 1
    findings.push({
      id: edit.id,
      hitsInOriginal: pristineHits,
      hitsWhenAppliedInOrder: hitsNow,
      ok: hitsNow === 1,
      note: hitsNow !== 1
        ? pristineHits === 0
          ? 'anchor only exists after another edit ran — its find text must cover the pristine code'
          : pristineHits > 1
            ? 'anchor appears more than once in DSH’s own text'
            : 'anchor disappears once an earlier edit runs'
        : undefined,
    })
    if (hitsNow === 1) text = text.split(edit.find).join(edit.replace)
  }
  return findings
}
