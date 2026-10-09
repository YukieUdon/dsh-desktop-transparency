/**
 * probe-process-query.mjs — find which command actually reports running DSH processes.
 *
 * Written because `isDshRunning()` returned false on a machine where the app was
 * plainly running: the failure was swallowed by its own try/catch, which is exactly the
 * kind of silence this project tries to avoid. This probe prints what each candidate
 * command does, including the error it throws.
 *
 * Usage: node tools/probe-process-query.mjs
 */
import { spawnSync } from 'node:child_process'

const QUERY = "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | ForEach-Object { $_.ProcessId }"

for (const command of ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'tasklist']) {
  const args = command.startsWith('tasklist')
    ? ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH', '/FO', 'CSV']
    : ['-NoProfile', '-NonInteractive', '-Command', QUERY]
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  const stdout = (result.stdout ?? '').trim()
  console.log(`\n=== ${command} ===`)
  console.log('  error :', result.error ? `${result.error.code}: ${result.error.message}` : 'none')
  console.log('  status:', result.status)
  console.log('  stdout:', JSON.stringify(stdout.slice(0, 120)))
  console.log('  stderr:', JSON.stringify((result.stderr ?? '').trim().slice(0, 160)))
  console.log('  verdict:', stdout.length > 0 ? 'RUNNING' : 'no output')
}
