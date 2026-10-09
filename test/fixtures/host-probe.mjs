/**
 * Runs *inside* a real DSH desktop host process and reports what that process can see of
 * its own installation.
 *
 * Usage (the way DSH itself starts its host):
 *
 *   ELECTRON_RUN_AS_NODE=1 "<root>\DeepSeek Harness.exe" host-probe.mjs <pluginRoot>
 *
 * The point of starting a real host instead of simulating one is that the thing which
 * broke is a property of the process, not of this package: `DeepSeek Harness.exe` running
 * as node inherits Electron's asar-aware `fs`, and under it `resources\app.asar` is the
 * virtual root of the archive — `statSync().isFile()` false, `readFileSync` ENOENT. A test
 * in a plain node process cannot see that, which is how the suite passed 60/60 while the
 * plugin reported "no installation" from inside a running installation.
 *
 * The report is one JSON line so the caller can parse it out of Electron's own noise.
 * `HOST-PROBE ` marks it.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [pluginRoot] = process.argv.slice(2)
const { status } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'operations.mjs')).href)
const fsIo = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'fs-io.mjs')).href)
const nodeFs = (await import('node:fs')).default

const resourcesPath = process.resourcesPath ?? path.join(path.dirname(process.execPath), 'resources')
const appAsar = path.join(resourcesPath, 'app.asar')

// The host's own arguments name the very archive it is meant to patch: DSH starts it as
// `<root>\DeepSeek Harness.exe <...>\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js <dsh> <profile>`.
// Reproduced here so this probe exercises the real discovery route (the process's own
// arguments) rather than a shell's idea of where DSH is installed.
const argv = [
  process.execPath,
  path.join(appAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  path.join(appAsar, 'dsh'),
  process.cwd(),
]

function see(impl) {
  try {
    const stat = impl.statSync(appAsar)
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size }
  } catch (error) {
    return { error: error?.code ?? String(error?.message ?? error) }
  }
}

const report = {
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  archiveFs: fsIo.archiveFsName,
  nodeFsSeesArchive: see(nodeFs),
  archiveFsSeesArchive: see(fsIo.archiveFs),
  status: await status({ argv, execPath: process.execPath, resourcesPath }),
}

console.log(`HOST-PROBE ${JSON.stringify(report)}`)
