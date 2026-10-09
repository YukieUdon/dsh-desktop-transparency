# Live-page probes (`tools/cdp/`)

The patched app fails **silently**: a selector with one wrong character, a stale anchor or a
missing integrity recomputation all produce a window that just stays square and opaque. Pixels
are the only honest report, so these probes read the running app over the Chrome DevTools
Protocol and print the numbers instead of an opinion.

They were the working tool for every "why does it still look like that?" in this project — the
composer/transcript geometry, the sidebar's black bar, the code block's stacked layers and the
material question were all settled by reading computed styles and boxes here, not by comparing
screenshots.

## Attaching

The window has to be started with a debugging port. `tools/restart-dsh-outside-session.ps1`
does that (and has to run from *outside* the app's process tree: stopping DSH also stops the
session that would call it):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-dsh-outside-session.ps1
curl.exe -s http://127.0.0.1:9222/json/list | Select-Object -First 1   # a target must be listed
```

Then run one expression against the page. `cdp-eval.mjs` writes the value the expression
returns to a log file and prints it:

```powershell
node tools/cdp/cdp-eval.mjs stats.log 9222 tools/cdp/cdp-corner-report.js
node tools/cdp/cdp-eval.mjs            # no expression file: a built-in transparency report
```

## The expressions

| File | What it answers |
|---|---|
| `cdp-corner-report.js` | The four window corners: are the pixels outside the rounded corner the desktop, or is material still painted there? Also reports the DWM corner preference. |
| `cdp-dump-classes.js` | Every class name the page mounts — the input for `tools/make-classes-fixture.mjs`, which CI then checks every `[class*="…"]` selector against. |
| `cdp-find-opaque.js` | Which elements paint a large opaque background (the "why is my window still opaque" scan). |
| `cdp-probe-sidebar.js` | Point-by-point hit testing down the sidebar plus the list of dark elements near the bottom — this is how the black bar was traced to `_9lTDKa_fade`. |
| `cdp-hide-fade.js` | Tries a fix in the *live* page (inline style) before it goes into the template. Note: inline styles bypass the selectors, so this proves the *effect* is right, never that the *selector* is right. |
| `cdp-check-fade-gone.js` | Answers whether the fade is really gone once the patch is installed, and prints the pixel region to measure. |

Anything else is one expression away — `cdp-eval.mjs` takes any file:

```js
(() => {
  const seat = document.querySelector('[data-composer-seat]')
  const r = seat.getBoundingClientRect()
  return JSON.stringify({ box: [r.left, r.top, r.right, r.bottom].map(Math.round), bg: getComputedStyle(seat).backgroundColor })
})()
```

A probe that reads geometry or computed styles is read-only and safe to run against a live
session. `cdp-hide-fade.js` and any expression you write yourself are not: they mutate the page
until it reloads.
