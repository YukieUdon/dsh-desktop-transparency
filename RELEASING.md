# Release procedure

Written for the person cutting a release. The npm package name
`dsh-desktop-transparency` was unclaimed when this was written, but **check again
before the first publish**:

```powershell
npm view dsh-desktop-transparency version    # 404 = free, anything else = taken
```

## One-time setup

1. **Create the GitHub repository** and push (the URL in `package.json` must match
   the real one, otherwise npm provenance and the release links point nowhere). The
   repository is `YukieUdon/dsh-desktop-transparency`, and `git init -b main` has
   already been run in this directory:

   ```powershell
   git add -A
   git commit -m "dsh-desktop-transparency 1.0.1"
   git remote add origin https://github.com/YukieUdon/dsh-desktop-transparency.git
   git push -u origin main
   ```

   `.gitignore` keeps `node_modules/` and `*.asar` out, which matters: the patched
   archive is ~121 MB and must never be committed.

2. **Configure Trusted Publishing** on npm (package → Settings → Trusted Publisher →
   GitHub Actions): repository `YukieUdon/dsh-desktop-transparency`, workflow
   `publish.yml`. This is why the workflow needs `id-token: write` and why no
   `NPM_TOKEN` secret is required. npm's side accepts the workflow file name, so
   renaming `publish.yml` breaks publishing until npm is updated too.

   Trusted Publishing needs **npm ≥ 11.5.1**. The run that ships is on a GitHub
   runner, and the workflow upgrades npm explicitly — the npm bundled with Node 22 is
   older and would fail with `ENEEDAUTH` instead of saying why.

3. Optionally enable the release workflow's dry run once (`Run workflow` with
   `dry_run: true`) to see the notes and the packed file list without publishing.

## Cutting a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry. The published
   version is whatever `package.json` says; nothing increments it automatically.
2. Run the same gates CI runs, locally:

   ```powershell
   npm test
   node tools/check-selectors.mjs test/fixtures/live-classes.json
   ```

   If a DSH version moved its CSS-module prefixes or its `lib/main.js` shape, this is
   where it should fail. See "When DSH changes" below.
3. Publish: GitHub → Actions → **Publish to npm** → *Run workflow* on `main`. It
   refuses to run off `main`, refuses a version that already exists on npm, runs the
   checks, then publishes with provenance and creates the tag and release.

## Manual publish (fallback)

If Actions is unavailable, publish from a machine that is logged in
(`npm adduser`). Provenance needs CI, so the fallback is a plain publish:

```powershell
npm test
npm publish --access public
```

## When DSH changes

Three files are tied together and cannot be edited independently:

| File | Holds |
|---|---|
| `lib/patch-rules.mjs` | the four `find`/`replace` anchors and `expectedCssRules` |
| `lib/patch-template.js` | the code spliced into `lib/main.js` (extracted, never hand-written) |
| `test/fixtures/live-classes.json` | real class names, for the selector check |

A new DSH version is handled like this:

1. Run `node lib/cli.mjs status` against it. `verdict: unknown` with clean
   diagnostics means the anchors still match and the patch can be applied; the CLI
   warns that the archive is not in the verified set.
2. If the anchors do **not** match, `apply` refuses and names the edit that failed.
   Update that anchor in `lib/patch-rules.mjs` against the new `lib/main.js`, then
   re-extract the template from a patched archive
   (`node tools/extract-patch-template.mjs <patched.asar> lib/patch-template.js`) and
   adjust `expectedCssRules` if the CSS changed.
3. Refresh the class fixture from a live page
   (`node tools/make-classes-fixture.mjs <capture.json> test/fixtures/live-classes.json _dockScrim_`)
   and re-run the selector check. A changed CSS-module prefix shows up here and
   nowhere else.
4. Add the new archive to `KNOWN_ARCHIVES` in `lib/operations.mjs` (sizes at least;
   the patched `sha256` is worth recording because it is what a user's bug report
   will quote) and to the support table in `README.md`.
5. Prove the whole loop against the real bytes before releasing:

   ```powershell
   $env:DSH_OFFICIAL_ASAR = 'path\to\official\app.asar'
   npm run test:integration
   ```

## Advice worth keeping

- **Never overwrite a published version.** npm allows only `deprecate`, so the
  version guard in the workflow exists to stop a mistimed push from doing it.
- **Do not hand-write an anchor or a template.** The template is extracted from an
  archive that already ran; an anchor must be copied from the real `lib/main.js`.
  Both mistakes cost real time in this project, and both fail *silently*.
- **A green test suite is not proof.** `test/anchors.test.mjs` exists because a
  fixture once drifted from the real anchors and the suite stayed green while
  testing nothing.
