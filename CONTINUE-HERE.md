# Continue here — `dsh-desktop-transparency`

Handoff notes for whoever picks this up (agent or human). The work came out of a DSH
session running in the `desktop` profile, workspace
`default-workspace/dsh-desktop-transparent`.

## Where things stand

**The bundle is installed and active in the `desktop` profile.** The profile's
`package.json` lists `dsh-desktop-transparency` in `dsh.profile.bundles` and links it to
this directory, so edits here are live on the next host start — no reinstall needed.

**Version 1.0.1: the host half works now.** 1.0.0 shipped a plugin whose entire startup
path was blind, and one restart found it: the boot record said `installed: false` next to
`existsSync(app.asar) === true` for the same path.

The cause, measured in the real host (Electron 44.0.0 / Node 24.18.1 — the desktop host is
`DeepSeek Harness.exe` run as node, so it inherits Electron's asar-aware `fs`):

| | `existsSync` | `statSync().isFile()` | `isDirectory()` | `size` | `readFileSync` |
|---|---|---|---|---|---|
| `node:fs` | true | **false** | true | 0 | `ENOENT` |
| `original-fs` | true | true | false | 121,355,145 | reads 121,355,145 bytes |

`resources\app.asar` is the virtual root of the archive under that `fs`, never a file — so
classification, patching, restore and the boot check could not work from inside the app.
Fixed by `lib/fs-io.mjs`, which resolves `original-fs` inside Electron and `node:fs`
everywhere else. The CLI was never affected (plain node), which is why this survived 60
green tests. Do not "simplify" those imports back to `node:fs` — `test/host-fs.test.mjs`
starts a real host process to catch exactly that, and `test/fs-io.test.mjs` pins the rest.

**All gates pass, on both platforms.** `npm test` → 74 tests: 74 pass on Windows with
`DSH_OFFICIAL_ASAR` set (real-archive integration tests plus the host probe), 70 pass and
4 skip on Linux — the 4 need a DSH installation, which the ubuntu CI runner does not have.
The Linux run is the one that matters for CI and it was red until this was fixed: seven
tests passed on Windows and failed on ubuntu because discovery built Windows paths with
`path.join`/`path.basename`. Verify it in WSL before pushing anything:

```powershell
wsl -e bash -lc "cd '<path>/dsh-desktop-transparency' && node --test 'test/*.test.mjs'"
```

Template/CSS consistency, edit-list diagnostics, the selector check and the syntax check all
pass there too; `npm pack` ships no `test/`, `tools/` or archive bytes.

**The claim that matters**: this package's rules are the same text as the old project's spec, and
with the same tuning both build the same archive.

```
this package, its own defaults : 121356903 bytes  2F2211A079098DE0F6FEA765EC24F34236EAFFDCAAFC8D950C2D64A02985170B
old project, its current spec  : 121356903 bytes  2F2211A079098DE0F6FEA765EC24F34236EAFFDCAAFC8D950C2D64A02985170B
```

Both sides are on their defaults, so the artifacts are byte-identical. Re-checked after the
composer change and the glass parameterisation (see `CHANGELOG.md`, "Unreleased"): the old
project's `spec-win-css.json` and this package's `lib/patch-template.js` are the same bytes
*as sources* — both carry the `${__dshGlass…}` placeholders that `lib/glass-tuning.mjs` fills
in — and the rendered text is what the archive gets. `node tools/render-spec.mjs --check-plugin`
(from the old project) compares both in one command: it fails on any structural difference and
only *reports* tuning differences. The 121,355,145 B figures elsewhere in this file are the
1.0.1 record, not the current output.

## Two hard facts learned from the real machine (both change the product)

1. **Windows will not let a running app's `app.asar` be replaced.** Reproduced:
   `EPERM: operation not permitted, rename '…app.asar.tmp-…' -> '…app.asar'`. So `apply`
   and `restore` refuse up front while DSH Desktop is running, and the plugin **cannot**
   re-apply the patch from inside the app — it records `needs-manual-apply` and tells the
   user to close DSH and run the CLI. Anything that claims automatic recovery after a DSH
   update from inside the app is wrong on Windows.
2. **A patched installation with no backup is recoverable.** `reconstructOfficial`
   reverses the four substitutions; `apply --force` uses it, verifies the result carries
   no patch marker, and stores it as a real backup. Proven byte-for-byte against the real
   121 MB archives in `test/reconstruct.test.mjs`.

A third one, smaller but worth keeping: `isDshRunning()` once returned `false` on a
machine where the app was plainly running, because a missing `spawnSync` import threw and
the `catch` swallowed it. The detector now tries PowerShell and `tasklist`, reports its
failures as a warning, and has a test that injects a throwing runner.

## Remaining work

**Already verified in the app** (1.0.1, after a real restart): the boot record reads
`verdictAtBoot: patched`, `action: none`, `reason: already patched`,
`host.archiveFs: original-fs`, `fsProbe.asarIsFile: true` — before 1.0.1 the same record
said `installed: false` — and the CDP check on the restarted window reported `fadeCount 1`,
`display: none`, `removed: true`. A restart is fired through
`tools/restart-dsh-outside-session.ps1` and a one-shot scheduled task, because stopping DSH
ends the session that lives in it; that script must not be deleted, since a scheduled task
pointing at a missing script fails silently.
1. **Re-run the black-bar check in the app** against the restarted window: the source of
   truth is `test/fixtures/live-classes.json` + `tools/check-selectors.mjs` (in the repo),
   and the in-app proof is the old project's CDP probe over port 9222, opened by the
   restart script — that probe (`cdp-eval.mjs` + `cdp-check-fade-gone.js`) lives in the
   *parent* directory and is **not** part of this repository, so a fresh clone cannot
   reproduce it. Verified once already: `fadeCount 1`, `display: none`, `removed: true`,
   `frameBg`/`htmlBg` transparent, sidebar at 55%. If it is worth keeping, move those two
   files into `tools/` here.
2. **Publishing** (what the user is doing next):
   - **GitHub**: owner `YukieUdon`, repository `dsh-desktop-transparency`, and the three
     URLs in `package.json` (`repository`, `bugs`, `homepage`) name exactly that. `gh` is
     not installed, so the repository is created on the web and pushed with git.
   - **Where to `git init`**: this directory, not its parent — `git init -b main` has been
     run here. The parent holds `build\app-transparent.asar` (121 MB), screenshots and the
     archived first project, none of which belongs in the repository.
   - `CONTINUE-HERE.md` stays at the repository root on purpose, and is deliberately
     **not** in `package.json`'s `files`: it is development history, not something an npm
     user needs (it used to ship, which is why the published package no longer lists it).
   - Still open before the first commit: no screenshot exists anywhere in the repository —
     this is a visual plugin, and usable before/after images are in the parent's `assets\`
     and `build\` — and the README is written for developers in Chinese, which is fine for
     the repository but is not an install guide for a stranger.
   - npm name `dsh-desktop-transparency` is still free (`npm view` → 404); local npm is
     10.9.2 and not logged in. Trusted Publishing needs npm ≥ 11.5.1, which `publish.yml`
     installs on the runner, so no long-lived `NPM_TOKEN` is needed — but npm's Trusted
     Publisher entry must name `YukieUdon/dsh-desktop-transparency` and workflow
     `publish.yml`.
   - Order: first commit → create the repository → push → configure Trusted Publishing →
     Actions → *Publish to npm* (dry run first) → real publish. Details in `RELEASING.md`.
     CI runs on ubuntu, so the Linux suite must stay green.
3. **Optional polish**: a Client half with a plugin page (status card + re-apply / restore
   buttons) using `--dsw-alias-*` tokens. `cordis_inspect_query` client
   `Slots.listSubTree` is the starting point and the plugin page is the design reference.
   Note it cannot fix fact 1: a button inside the running app still cannot write
   `app.asar`, so the page should explain the close-then-apply flow rather than pretend
   otherwise.

## Things not to redo

- Do not hand-write patch anchors or the template. Both mistakes are silent: the suite can
  stay green while an anchor matches nothing (`test/anchors.test.mjs` exists because that
  happened).
- Do not "fix" `test/synthetic-asar.mjs` back into hand-written anchors; it deliberately
  splices `FIXTURE_ANCHORS` so the fixture cannot drift from the patcher.
- Do not add a `Config` export without a real Standard Schema (a `zod` dependency, or an
  object with a working `'~standard'.validate`); a JSON-Schema literal reintroduces the
  activation crash that cost a restart.
- Do not make the write paths ignore a running app without saying so; the EPERM is real
  and the refusal message is the product here.
- Do not reach the archive through `node:fs` from the host. See the table above; the host
  cannot see the file that way, and the failure looks like a discovery bug.
