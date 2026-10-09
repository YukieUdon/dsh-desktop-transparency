/**
 * Host half of dsh-desktop-transparency.
 *
 * What this plugin can and cannot do is decided by where it runs. It runs in the
 * desktop host process (a plain Node process), so it has the filesystem — but the
 * window it wants to change is created by Electron's main process, and
 * `transparent: true` / `backgroundMaterial` can only be set when a BrowserWindow is
 * constructed. No plugin reaches that constructor, so this plugin cannot make the
 * window transparent by itself; it changes the *shipped archive* that Electron boots
 * from, and the change takes effect on the next start.
 *
 * That is why the work here is: detect the installation, patch `app.asar` safely
 * (backup, verify, atomic replace), and tell the user a restart is required.
 *
 * "The desktop host process (a plain Node process)" was wrong, and it cost this plugin
 * its whole startup path: the host is `DeepSeek Harness.exe` running as node, so it
 * inherits Electron's asar-aware `fs`, in which `resources\app.asar` is the virtual root
 * of the archive rather than a file. Every check answered "no installation" from inside
 * a running installation. The archive is reached through fs-io.mjs; what this half
 * records about it is below, because a boot record is the only witness the host leaves.
 */
import path from 'node:path'

import archiveFs, { archiveFsName } from './fs-io.mjs'
import { applyPatch, dshRootCandidates, findDshRoot, status, verifyPatch, writeBootRecord } from './operations.mjs'

/**
 * Configuration, read from the bundle row's `config` and from the environment.
 *
 * There is deliberately **no `Config` export**. Cordis validates that export through
 * the Standard Schema interface (`Config['~standard'].validate`), so it must be a
 * real schema object — every shipped DSH plugin uses `zod` for it — and this package
 * keeps zero dependencies so it can run from inside an app bundle without a
 * `node_modules` of its own. Cordis passes the row's `config` through unchanged when a
 * plugin declares no schema, so the settings below still work; what is lost is the
 * schema shown in the plugin UI, which is why the environment variables exist as an
 * equally supported path.
 *
 * Precedence: the row's config, then the environment, then defaults.
 */
export function readSettings(config = {}, env = process.env) {
  const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    return !/^(?:0|false|no|off)$/i.test(String(value))
  }
  return {
    autoApply: bool(config.autoApply ?? env.DSH_DESKTOP_TRANSPARENCY_AUTO_APPLY, true),
    dshRoot: config.dshRoot ?? env.DSH_DESKTOP_ROOT ?? undefined,
    stateDir: config.stateDir ?? env.DSH_DESKTOP_TRANSPARENCY_STATE_DIR ?? undefined,
  }
}

export const name = 'dsh-desktop-transparency'

/**
 * `inject` is deliberately empty: the plugin only uses Node builtins and Cordis
 * context primitives, so it stays active in any profile shape. A profile without the
 * desktop host simply never needs it.
 */
export function apply(ctx, config = {}) {
  const settings = readSettings(config)

  /**
   * The host's own facts, passed explicitly rather than left to the library's defaults.
   *
   * This is not belt-and-braces: the plugin reported "no installation" from inside a
   * running installation while the library answered correctly for the same inputs off the
   * host, and the difference had to be guessed at from a record written after the fact.
   * Naming these values here removes the guess — and `hostFacts` is what gets recorded, so
   * a failure can be reproduced outside the app.
   */
  const hostFacts = () => ({
    argv: process.argv,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  })

  const options = () => ({ dshRoot: settings.dshRoot, stateDir: settings.stateDir, ...hostFacts() })

  const log = (level, message, detail) => {
    const line = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`
    if (ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](line)
    else console.log(`[dsh-desktop-transparency] ${line}`)
  }

  ctx.logger?.info?.('[dsh-desktop-transparency] host half loaded')

  ctx.effect(() => {
    let disposed = false

    // Every exit from the check writes a boot record, so "did the plugin run, and what
    // did it decide" survives the fact that the desktop host's console is nobody's
    // terminal. It is also what makes the automatic re-apply after a DSH update
    // observable instead of a claim.
    const record = (fields) => {
      try {
        return writeBootRecord(fields, options())
      } catch (error) {
        log('warn', 'could not write the boot record', { message: String(error?.message ?? error) })
        return null
      }
    }

    const run = async () => {
      // The host's own view of itself, recorded before anything else can fail. When the
      // plugin reports "no installation" from inside a running installation, this is the
      // difference between "discovery looked in the wrong places" and "discovery never saw
      // the arguments it needs" — and it cannot be reconstructed from outside the process.
      const host = {
        argv: process.argv.slice(0, 4),
        execPath: process.execPath,
        resourcesPath: process.resourcesPath ?? null,
        platform: process.platform,
        cwd: process.cwd(),
        dshDesktopRootEnv: process.env.DSH_DESKTOP_ROOT ?? null,
        // Which filesystem the archive was reached through. Recorded because the host
        // inherits Electron's asar-aware fs, where the archive is not a file at all —
        // and that fact is invisible from outside the process.
        archiveFs: archiveFsName,
      }
      let report
      try {
        report = await status(options())
      } catch (error) {
        log('error', 'the installation check itself failed', { message: String(error?.message ?? error) })
        record({ host, action: 'error', reason: `the installation check threw: ${String(error?.message ?? error)}` })
        return null
      }
      if (disposed) return report
      log('info', 'installation status', {
        installed: report.installed,
        verdict: report.verdict,
        size: report.size,
        root: report.root,
      })
      // The candidate list, computed here and recorded as data: if discovery misses on this
      // machine, this shows which roots were tried without needing another restart. The trace
      // goes further and records what each candidate looked like on the way — filesystem
      // answers included — because a "nothing found" answer from inside the app cannot be
      // reproduced from a shell.
      let candidates = null
      let candidatesError = null
      let trace = null
      let fsProbe = null
      try {
        candidates = dshRootCandidates({ ...hostFacts(), run: () => '' })
        trace = []
        findDshRoot({ ...hostFacts(), run: () => '', trace: (entry) => trace.push(entry) })
        const first = candidates[0]
        const asarPath = first ? path.join(first, 'resources', 'app.asar') : null
        fsProbe = first
          ? {
              path: first,
              fs: archiveFsName,
              exists: archiveFs.existsSync(first),
              exeExists: archiveFs.existsSync(path.join(first, 'DeepSeek Harness.exe')),
              asarExists: archiveFs.existsSync(asarPath),
              // The canary. Under Electron's asar-aware fs the archive is a directory of
              // size 0, so `asarExists` is true while a regular-file check is false: that
              // pair, on one path, is what "no installation found, next to an archive that
              // exists" looked like. Recorded so the question is answered by data.
              asarIsFile: (() => {
                try {
                  return archiveFs.statSync(asarPath).isFile()
                } catch (error) {
                  return `throws: ${error.code ?? error.message}`
                }
              })(),
              statOk: (() => {
                try {
                  archiveFs.statSync(first)
                  return true
                } catch (error) {
                  return `throws: ${error.code ?? error.message}`
                }
              })(),
            }
          : null
      } catch (error) {
        candidatesError = String(error?.message ?? error)
      }
      const atBoot = {
        installed: report.installed,
        verdictAtBoot: report.verdict,
        root: report.root,
        size: report.size,
        host,
        candidates,
        candidatesError,
        trace,
        fsProbe,
        // Recorded even on success: "it found nothing" is the one report a user cannot
        // debug from the outside, and this says whether discovery looked in the right places.
        detection: report.detection,
      }

      if (!report.installed) {
        log('warn', 'no DSH installation found; set the dshRoot config or run the CLI with --dsh-root')
        record({ ...atBoot, action: 'none', reason: report.note })
        return report
      }
      if (report.verdict === 'patched') {
        log('info', 'transparency patch already installed')
        record({ ...atBoot, action: 'none', reason: 'already patched' })
        return report
      }
      if (!settings.autoApply) {
        log('warn', 'the installation is unpatched and autoApply is disabled; run the CLI to patch it')
        record({ ...atBoot, action: 'none', reason: 'autoApply is disabled' })
        return report
      }

      // Deferred work cannot replace app.asar: the app that hosts this plugin is holding
      // it, and Windows refuses the rename (verified: EPERM on a real installation). So
      // this path reports what to do instead of pretending it recovered, and records the
      // refusal so `dsh-desktop-transparency boot` can explain it later.
      const result = await applyPatch(options())
      if (disposed) return result
      if (result.applied) {
        log('warn', 'transparency patch applied; RESTART DSH Desktop for it to take effect', {
          backup: result.backup?.file,
          size: result.after?.size,
          sha256: result.after?.sha256,
        })
        for (const warning of result.warnings ?? []) log('warn', warning)
        record({
          ...atBoot,
          action: 'applied',
          restartRequired: true,
          backup: result.backup?.file ?? null,
          sha256: result.after?.sha256 ?? null,
          warnings: result.warnings ?? [],
        })
      } else if (result.appRunning) {
        log(
          'warn',
          'this installation is unpatched, but app.asar cannot be replaced while DSH Desktop is ' +
          'running. Close DSH Desktop, then run: dsh-desktop-transparency apply',
        )
        record({
          ...atBoot,
          action: 'needs-manual-apply',
          reason:
            'DSH Desktop holds app.asar open, so the patch cannot be written from inside it; ' +
            'close DSH Desktop and run: dsh-desktop-transparency apply',
        })
      } else {
        log('error', 'the transparency patch was not applied', { reason: result.reason })
        if (result.diagnostics) log('error', 'edit diagnostics', result.diagnostics)
        record({
          ...atBoot,
          action: 'refused',
          reason: result.reason ?? null,
          diagnostics: result.diagnostics ?? null,
        })
      }
      return result
    }

    // Startup work is deferred so the host is not blocked while a 121 MB archive is
    // read and rewritten.
    const timer = setTimeout(() => {
      run().catch((error) => {
        log('error', 'startup check failed', { message: String(error?.message ?? error) })
        record({ action: 'error', reason: String(error?.message ?? error) })
      })
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, 'dsh-desktop-transparency/startup-check')

  /**
   * Programmatic surface, so a UI or another plugin can drive the same lifecycle
   * without shelling out to the CLI.
   */
  return {
    name,
    status: (overrides) => status({ ...options(), ...overrides }),
    apply: (overrides) => applyPatch({ ...options(), ...overrides }),
    verify: (overrides) => verifyPatch({ ...options(), ...overrides }),
  }
}

export default { name, apply }
