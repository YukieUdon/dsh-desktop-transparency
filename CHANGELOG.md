# Changelog

## Unreleased

**Fixed: the transcript no longer collides with the composer's stats row — without painting an opaque band.**

The conversation scrolls *under* the composer by design — `composerSeat` is
`position: sticky / absolute; bottom: 0` above the scroller — and DSH hides that under-scroll
with a gradient the seat paints itself (transparent at its top edge, panel colour 36px down).
The patch cleared that gradient (`background:transparent !important;
background-image:none !important`) in the name of transparency, which removed the only thing
hiding the text: the last conversation row stayed legible on top of the stats line
(`conversation.composer.dock` → `div[data-composer-stats]`, rendered *inside* the seat).

Restoring the gradient (the first attempt) does hide the text, but it also paints an opaque
panel band over the desktop at the bottom of the window, and hiding content without painting
is not possible here: `backdrop-filter` is inert in this transparent window — measured, `invert(1)`
on both the sticky seat and a `position:fixed` overlay changed nothing.

- The transcript scrollport is now shortened by `--dsh-composer-height`, and the seat is lifted
  out of it with `position: absolute` (its containing block is the relative `Dc7zOa_body`), so
  nothing is ever painted behind the composer and no band is needed. This agrees with DSH's own
  scroll code, which already treats the seat's top edge as the bottom of the reading viewport.
- The two offsets DSH wrote for the old full-height scrollport are re-based:
  `toBottomSlot { bottom: 16px }` and `--turn-rail-band: var(--dsh-conversation-viewport-height)`.
- The trajectory view is excluded (`:not(:has([data-conversation-composer-overlay]))`): there DSH
  positions the seat itself and its ledger reserves the clearance, so interfering put the composer
  in mid-window. The "seat paints no backdrop" rule applies to both views.
- Cost: the transcript now ends at the composer's top edge (a clean cut, no fade into the input bar).
- A patched archive from the same official source is 121,356,696 bytes / sha256 `DDC12073…`.

**The glass tuning is now a named parameter block instead of values buried in the stylesheet.**

`lib/glass-tuning.mjs` holds the window material and one background value per surface; the
template refers to them as `${__dshGlass…}` and `lib/patch-rules.mjs` renders them before any
anchor is matched, so the values a build bakes in are readable without opening an archive.

- A `${name}` with no value throws instead of reaching `main.js`, where it would be injected as
  literal CSS text and quietly do nothing; a knob nothing refers to is reported.
- `operations.mjs` checks the rendered rules (`renderedExpectedCssRules()`), not the raw entries,
  so the tuning cannot drift from what the archive must contain.
- Same nine values, same defaults: the rendered output — and therefore the archive — is
  byte-for-byte what it was (121,356,696 B / `DDC12073…`).

**Added: a knob for the code blocks.**

A code block paints several opaque layers (measured live: the card and its inner `<pre>` in
`rgb(27,27,28)`, over a language banner). `__dshGlassCodeBg` puts the value on the **card** and
flattens everything inside it (`[class*="md-code-block"] *{background:transparent}`): applying
the same alpha to every layer *stacks* it (0.72 x 0.72 ~= 0.92), which reads as "only the
banner changed". The default is `var(--dsw-specific-sidebar-fill)` — what the card paints
today — so the default changes nothing, and `transparent` or a `color-mix(…)` with an alpha
makes the whole block one translucent layer. Caveat: a block's *own* inner tints (highlighted
lines) are flattened too, so keep the value opaque if you want them.

- The old project's `tools/verify-patched.mjs` had `backgroundMaterial: "acrylic"` hardcoded as
  an expectation, so selecting a different material failed its own verification. There (this
  package never had the problem) the material and per-surface expectations are now read from the
  spec's `params`, and every value the spec declares must appear in the archive.

## 1.0.1

**Fixed: the plugin could not see the installation it runs inside.**

The desktop host is `DeepSeek Harness.exe` started as node, so it inherits Electron's
asar-aware `fs` — and under that `fs`, `resources\app.asar` is not a file: it is the
virtual root directory of the archive it holds. Measured in the real host (Electron
44.0.0 / Node 24.18.1):

| | `existsSync` | `statSync().isFile()` | `isDirectory()` | `size` | `readFileSync` |
|---|---|---|---|---|---|
| `node:fs` | true | **false** | true | 0 | `ENOENT` |
| `original-fs` | true | true | false | 121,355,145 | 121,355,145 bytes |

Every module reached the archive through `node:fs`, so nothing could be classified or read
from inside the app: `status()` answered "no installation" from inside a running
installation, and the boot record carried the contradiction (`installed: false` next to
`existsSync(archive) === true`) with nothing to explain it. The patch itself was never
affected — the CLI works, which is why this went unnoticed.

- The archive, its backups and the state directory are now reached through
  `lib/fs-io.mjs`, which resolves Electron's unpatched `original-fs` when it exists and
  `node:fs` everywhere else (the CLI, every test). The plugin's *own* files keep
  `node:fs`: they may live inside the very archive, where asar support is required rather
  than harmful. `process.noAsar = true` would also fix the reads and is not an option —
  the host loads its own modules from inside `app.asar`.
- The boot record now records which filesystem the archive was reached through, and
  whether it was a regular file there: the pair of facts that ended this bug.
- `DSH_DESKTOP_TRANSPARENCY_ARCHIVE_FS=node` pins the plain fs, to reproduce the
  blindness on purpose when diagnosing.

**Fixed: the suite failed on Linux, so CI was red before the first push.**

Seven tests passed on Windows and failed on the ubuntu runner, and the cause was in the
implementation, not the runner: discovery built and split Windows paths with
`path.join`/`path.basename`/`path.dirname`, which are platform-flavoured. On Linux the
well-known locations came out as `C:\Users\u\AppData\Local/Programs/DSH`, and
`X:\Other\resources\app.asar` was read as a single filename, so no root was ever found from
the process's own arguments. Discovery now uses the module's own flavour-independent
helpers (`joinWindows`, `baseName`, `dirName`) and takes the archive path from the caller's
own spelling. Windows behaviour is unchanged (re-verified against the real installation
from inside the running host), and on Linux 70 tests pass with 4 skipped (the real-archive
integration tests and the host probe, which need a DSH installation). The three
running-app refusal tests now inject `platform: 'win32'` — the file lock they describe is
a Windows property, and inheriting the host's platform made them mean different things on
different machines. New test pins the invariant directly: every candidate is built with
backslashes on any host.

**Fixed: `boot` printed "no installation" for a patched installation.**

`record.verdictAtBoot ?? record.installed === false ? 'no installation' : 'unknown'` binds
as `(verdictAtBoot ?? (installed === false)) ? … : …`, so every non-empty verdict —
`patched` included — rendered as "no installation". This is the one line a user reads when
they are trying to find out whether the plugin's work happened at all, and it lied in the
most alarming direction. New `test/cli.test.mjs` renders the command's output for a
recorded verdict, for a missing installation and for an empty record.

- New `test/host-fs.test.mjs` starts a **real** host process
  (`DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`, the way DSH starts it) and runs
  both arms: the pinned one must report no installation beside an archive that exists, the
  default one must find the installation, read DSH's version out of the archive and
  classify it. Skipped where no DSH installation exists. New `test/fs-io.test.mjs` pins
  the resolution itself and the exact shape of the failure. Suite: 74 tests — 74 pass on
  Windows, 70 pass and 4 skip on Linux with the real-archive integration tests enabled,
  which is what CI runs.

## 1.0.0

First release as a DSH bundle. The patch itself is the result of the earlier
single-purpose project (versions V1–V21 there), which is where the hard parts were
learned; this release turns it into something installable and reversible.

**Delivered**

- DSH bundle (`dsh.bundle.patch`): installing it detects the DSH installation and
  reports whether the archive is patched, official or unknown. It never overwrites an
  already patched archive.
- CLI: `status`, `apply`, `verify`, `restore`, `backups`, `boot` (`--json` everywhere).
- Restore path that works even when the patched app will not start, because it does
  not need the app to be running.
- **Recovery without a backup**: when a machine was patched before this package
  existed, `apply --force` rebuilds the official archive by reversing the patch and
  keeps it as a backup. The rebuilt bytes are only used when they carry no patch
  marker. Verified against the real 121 MB archives.
- **The running-app requirement, handled honestly**: Windows refuses to replace the
  `app.asar` of a running app (`EPERM`, reproduced on a real installation), so
  `apply`/`restore` check first and refuse with an instruction instead of failing
  after 121 MB of work. The plugin cannot re-apply from inside the running app for
  the same reason, so it records `needs-manual-apply` instead of claiming success.
- `boot` record (`%LOCALAPPDATA%\dsh-desktop-transparency\last-boot.json`): the plugin
  runs where nobody reads its console, so what it decided at the last start is written
  down: `applied`, `needs-manual-apply`, `refused` or `none`, with the backup, the
  installed hash, or the exact edit that failed.
- Install-root detection: explicit `--dsh-root` / config, `DSH_DESKTOP_ROOT`, the
  Windows uninstall registry, the running process image path, then common locations.
- Safety gates before anything is written: archive classification, per-edit anchor
  count, round-trip byte comparison for every untouched entry, integrity hash and
  block recomputation, and an ESM syntax check of the patched `lib/main.js`.
- Atomic replacement with automatic rollback when the written bytes do not match.
- Unit tests over synthetic archives plus integration tests over a real official
  archive, so a stale anchor fails in CI instead of on a user's machine.
- Configuration without a dependency: the bundle row's `config` plus
  `DSH_DESKTOP_ROOT` / `DSH_DESKTOP_TRANSPARENCY_*`. No `Config` export, deliberately —
  Cordis validates that through Standard Schema (a real schema object, which would mean
  a `zod` dependency), and a JSON-Schema literal crashes activation.

**Patch contents**

- Window: `transparent: true`, `backgroundColor: "#00000000"`, acrylic kept,
  title-bar overlay forced transparent (including after the renderer reports its own
  palette).
- Page transparency: canvas, conversation area, dock tab host, sidebar content; the
  sidebar keeps a 55% (dark) / 72% (light) readable backdrop.
- Removed overlays that read as defects once the window is translucent: the session
  list's bottom fade (an opaque-to-black gradient — a black bar above the profile
  row), the composer bottom fade, and the blurred dock scrim.
- Rounded corners through DWM (`DWMWA_WINDOW_CORNER_PREFERENCE = 2`), reached with
  the koffi FFI that ships inside DSH, with a bounded diagnostic log at
  `%APPDATA%\@deepseek-ai\dsh-desktop\desktop-corners.log`.

**Known limitations**

- Windows only.
- A restart of DSH Desktop is required for a patch (or a restore) to be visible.
- Acrylic needs Windows 11 22H2+ and the system transparency setting enabled.
- The corner radius is DWM's native radius and cannot be customised.
