// Проверка оверлея поверх игр в настоящей Electron-оболочке.
// Запускает `electron . --overlay-test` с отдельным профилем, читает JSON
// самопроверки и печатает результат. Если Electron не установлен — набор
// пропускается (это не ошибка).
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.join(here, 'desktop');
const candidates = [
  process.env.ELECTRON_BIN,
  path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron'),
].filter(Boolean);
const electronBin = candidates.find((one) => existsSync(one));
if (!electronBin) {
  console.log('Electron не установлен — набор пропущен (это не ошибка)');
  process.exit(0);
}

const profile = path.join(process.env.TEMP || '/tmp', 'arc-overlay-test-' + Date.now().toString(36));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ['.', '--overlay-test', '--user-data-dir=' + profile], {
  cwd: desktopDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const timer = setTimeout(() => {
  console.log('FAIL оверлей не ответил за 90 секунд');
  try { child.kill(); } catch (_) {}
  process.exitCode = 1;
}, 90000);

child.on('close', (code) => {
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find((one) => one.startsWith('OVERLAY_TEST '));
  let report = null;
  if (line) {
    try { report = JSON.parse(line.slice('OVERLAY_TEST '.length)); } catch (_) { report = null; }
  }
  if (!report) {
    console.log('FAIL самопроверка оверлея не отдала результат');
    const tail = (stdout + stderr).split(/\r?\n/).filter(Boolean).slice(-8);
    for (const one of tail) console.log('   ' + one.slice(0, 200));
    process.exitCode = 1;
  } else {
    for (const item of report.checks || []) {
      console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok || !item.extra ? '' : ' → ' + item.extra));
    }
    console.log('\nпроблем: ' + (report.problems || []).length);
    for (const one of report.problems || []) console.log(' - ' + one);
    if ((report.problems || []).length || !report.ok) process.exitCode = 1;
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});
