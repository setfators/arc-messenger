// Готовит обновление Windows для раздачи через Cloudflare: режет установщик
// на части по 24 МиБ (один файл статики столько не отдаёт) и пишет
// parts/manifest.json + latest.yml для electron-updater.
//
// Запуск: node scripts/pack-update.mjs [путь-к-exe]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const PARTS = path.join(PUBLIC, 'updates', 'parts');
const PART_SIZE = 24 * 1024 * 1024;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('в desktop/package.json нет корректной версии:', version);
  process.exit(1);
}
const file = path.resolve(process.argv[2] || path.join(ROOT, 'desktop', 'dist', 'Arc-Setup-' + version + '.exe'));
if (!fs.existsSync(file)) {
  console.error('нет установщика:', file);
  process.exit(1);
}
const name = path.basename(file);
const bytes = fs.readFileSync(file);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

fs.rmSync(PARTS, { recursive: true, force: true });
fs.mkdirSync(PARTS, { recursive: true });
const parts = [];
for (let offset = 0, index = 0; offset < bytes.length; offset += PART_SIZE, index += 1) {
  const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + PART_SIZE));
  const partName = 'part-' + String(index).padStart(3, '0');
  fs.writeFileSync(path.join(PARTS, partName), chunk);
  parts.push({ name: partName, len: chunk.length });
}
const manifest = { file: name, size: bytes.length, sha512, sha256, parts };
fs.writeFileSync(path.join(PARTS, 'manifest.json'), JSON.stringify(manifest));

// Проверяем, что склейка частей побайтово даёт исходный файл.
const assembled = Buffer.concat(parts.map((part) => fs.readFileSync(path.join(PARTS, part.name))));
if (!assembled.equals(bytes)) {
  console.error('склейка частей не совпала с установщиком');
  process.exit(1);
}

// latest.yml повторяет формат electron-updater. Версия в releaseDate — текущее UTC.
const yml = [
  'version: ' + version,
  'files:',
  '  - url: ' + name,
  '    sha512: ' + sha512,
  '    size: ' + bytes.length,
  'path: ' + name,
  'sha512: ' + sha512,
  'releaseDate: \'' + new Date().toISOString() + '\'',
  '',
].join('\n');
fs.writeFileSync(path.join(PUBLIC, 'updates', 'latest.yml'), yml);

console.log('версия:', version);
console.log('файл:', name, bytes.length, 'байт');
console.log('частей:', parts.length, '(' + parts.map((p) => p.len).join(' + ') + ')');
console.log('sha512:', sha512);
console.log('sha256:', sha256);
console.log('склейка проверена: совпадает с установщиком');
