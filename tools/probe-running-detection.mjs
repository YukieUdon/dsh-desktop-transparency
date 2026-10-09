/**
 * probe-running-detection.mjs — drive `isDshRunning()` with the real command runner and
 * print the error its own try/catch hides.
 *
 * Usage: node tools/probe-running-detection.mjs
 */
import { spawnSync } from 'node:child_process'
import { isDshRunning } from '../lib/operations.mjs'

const EXE_NAME = 'DeepSeek Harness.exe'
const query = `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | ForEach-Object { $_.ProcessId }`

console.log('query:', query)

const direct = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true })
console.log('direct spawnSync  -> error:', direct.error?.message ?? 'none', '| status:', direct.status, '| out:', JSON.stringify((direct.stdout ?? '').trim().slice(0, 40)))

console.log('isDshRunning() default ->', await isDshRunning())

console.log('isDshRunning with an injected runner that prints ->', await isDshRunning({
  run: (command, args) => {
    console.log('  runner called with:', command, JSON.stringify(args))
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
    console.log('  runner got error:', result.error?.message ?? 'none', '| status:', result.status, '| out:', JSON.stringify((result.stdout ?? '').trim().slice(0, 40)))
    if (result.error) throw result.error
    return result.stdout ?? ''
  },
}))
