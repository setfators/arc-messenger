// Собирает www/index.html для мобильного приложения: берёт тот же клиент,
// что и на сайте, и подставляет адрес сервера (интерфейс лежит внутри APK).
//
// Запуск: node scripts/build-mobile-www.mjs
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = path.join(ROOT, 'public', 'index.html');
const outDir = path.join(ROOT, 'mobile', 'www');
const SERVER = process.env.ARC_SERVER || 'https://rust-messenger.sg530507.workers.dev';

mkdirSync(outDir, { recursive: true });

let html = readFileSync(src, 'utf8');

// Единственный <script> с логикой приложения: перед ним ставим адрес сервера.
// Переводы строк могут быть CRLF, поэтому ищем регуляркой.
const marker = /<script>\r?\nconst \$ = \(id\) => document\.getElementById\(id\);/;
if (!marker.test(html)) {
  console.error('не нашёл точку вставки — разметка изменилась');
  process.exit(1);
}
html = html.replace(
  marker,
  (hit) => '<script>window.__ARC_SERVER__ = ' + JSON.stringify(SERVER) + ';</script>\n' + hit
);

// В приложении service worker не нужен: интерфейс и так лежит внутри APK.
html = html.replace(
  "navigator.serviceWorker.register('/sw.js').catch(() => {});",
  '/* service worker внутри приложения не регистрируем */'
);

writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

// Копируем иконки: они нужны и внутри APK.
for (const name of readdirSync(path.join(ROOT, 'public'))) {
  if (!/\.(png|ico|webmanifest)$/i.test(name)) continue;
  const from = path.join(ROOT, 'public', name);
  if (statSync(from).isFile()) copyFileSync(from, path.join(outDir, name));
}

console.log('www/index.html:', statSync(path.join(outDir, 'index.html')).size, 'байт');
console.log('адрес сервера внутри:', SERVER);
console.log('файлов в www:', readdirSync(outDir).length);
