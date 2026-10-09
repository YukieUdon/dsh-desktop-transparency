/**
 * glass-tuning.mjs — the glass knobs, in one place.
 *
 * The same values as the old project's `tools/spec-win-css.json` `params` block:
 * both are rendered into the same injected text, and
 * `tools/render-spec.mjs --check-plugin` reports any structural drift (a run of it can
 * also list tuning differences, which are legitimate: the two artifacts ship their own
 * defaults).
 *
 * Every value is the *background of one surface*: `transparent` lets the desktop
 * through, `color-mix(…)` keeps a milky layer whose percentage is the "how frosted"
 * knob (0% ≈ clear, 100% = the panel's own colour). The blur itself is DWM's acrylic
 * material — its radius is not exposed by Electron, so `material` is the only lever
 * on it: acrylic (frostiest) | mica (faintest) | tabbed (darker) | none (no blur).
 *
 * Rendering is strict on purpose: a `${name}` with no value throws, because the
 * template is spliced into DSH's `main.js` and an unresolved placeholder would land
 * there as literal CSS text and quietly do nothing.
 */

/** Window material and per-surface backgrounds, keyed by the placeholder they fill. */
export const glassTuning = {
  __dshGlassMaterial: 'acrylic',
  __dshGlassSidebarBg: 'color-mix(in srgb, var(--dsw-specific-sidebar-fill) 72%, transparent)',
  __dshGlassSidebarDarkBg: 'color-mix(in srgb, var(--dsw-specific-sidebar-fill) 55%, transparent)',
  __dshGlassTitlebarBg: 'color-mix(in srgb, var(--dsw-specific-sidebar-fill) 55%, transparent)',
  __dshGlassFrameBg: 'transparent',
  __dshGlassCenterBg: 'transparent',
  __dshGlassChatBg: 'transparent',
  __dshGlassDockBg: 'transparent',
  __dshGlassComposerBg: 'transparent',
  // The code block: one value on the card, and every layer inside it (its <pre> and the
  // language banner) is flattened to transparent — applying the same alpha to each layer
  // stacks it (0.72 x 0.72 ~= 0.92), which reads as "only the banner changed".
  __dshGlassCodeBg: 'var(--dsw-specific-sidebar-fill)',
}

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g

/**
 * Fill every `${name}` in a piece of template/rule text.
 *
 * @param text - raw text carrying placeholders.
 * @param tuning - values to use; defaults to {@link glassTuning}.
 * @param where - label used in the error message.
 * @returns The rendered text, and the names it used.
 */
export function renderGlassTuning(text, tuning = glassTuning, where = 'template') {
  if (typeof text !== 'string') return { text, used: [] }
  const used = new Set()
  const rendered = text.replace(PLACEHOLDER, (match, name) => {
    if (!(name in tuning)) throw new Error(`${where} uses ${match}, which glass-tuning.mjs does not define`)
    used.add(name)
    return tuning[name]
  })
  const leftovers = [...new Set(rendered.match(PLACEHOLDER) ?? [])]
  if (leftovers.length > 0) throw new Error(`${where} has unresolved placeholder(s): ${leftovers.join(', ')}`)
  return { text: rendered, used: [...used] }
}

/**
 * Knobs no supplied text refers to.
 *
 * @param texts - raw template and rule strings.
 * @param tuning - the values in play.
 * @returns Names that nothing uses (a renamed placeholder, or a knob whose rule is gone).
 */
export function unusedGlassTuning(texts, tuning = glassTuning) {
  const used = new Set()
  for (const text of texts) for (const match of String(text).matchAll(PLACEHOLDER)) used.add(match[1])
  return Object.keys(tuning).filter((name) => !used.has(name))
}
