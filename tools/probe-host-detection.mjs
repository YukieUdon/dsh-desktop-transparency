/**
 * probe-host-detection.mjs — run `status()` with the exact inputs the desktop host
 * provides, and print what discovery concluded.
 *
 * The inputs below are a real host launch, recorded by YukieUdon on the machine the
 * patch was developed against: `<install root>` → `D:\Tools\DSH`, profile directory
 * `C:\Users\YukieUdon\.dsh\profiles\desktop`. Adjust both if your installation lives
 * elsewhere — the point of the probe is that the arguments look like DSH's own.
 *
 * Diagnostic only: it reads and prints, and never patches anything.
 *
 * Usage: node tools/probe-host-detection.mjs
 */
import { status } from '../lib/operations.mjs'
import { dshRootCandidates, findDshRoot, inspectDshRoot } from '../lib/detect.mjs'

const host = {
  argv: [
    'D:\\Tools\\DSH\\DeepSeek Harness.exe',
    '--expose-internals',
    'D:\\Tools\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'D:\\Tools\\DSH\\resources\\app.asar\\dsh',
    'C:\\Users\\YukieUdon\\.dsh\\profiles\\desktop',
  ],
  execPath: 'D:\\Tools\\DSH\\DeepSeek Harness.exe',
  resourcesPath: 'D:\\Tools\\DSH\\resources',
  run: () => '',
}

console.log('candidates         :', JSON.stringify(dshRootCandidates(host)))
console.log('inspect first      :', JSON.stringify(inspectDshRoot(dshRootCandidates(host)[0])))
console.log('findDshRoot        :', JSON.stringify(findDshRoot(host)))

const report = await status(host)
console.log('\nstatus.installed   :', report.installed)
console.log('status.verdict     :', report.verdict)
console.log('status.root        :', report.root)
console.log('status.note        :', report.note)
console.log('detection.candidates:', JSON.stringify(report.detection?.candidates))
