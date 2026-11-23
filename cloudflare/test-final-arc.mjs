// Финальная проверка живого сайта после переименования в Arc.
const B = 'https://rust-messenger.sg530507.workers.dev';

const page = await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } });
const html = await page.text();
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const manifest = await (await fetch(B + '/manifest.webmanifest')).json();
const yml = await (await fetch(B + '/updates/latest.yml')).text();
const man = await (await fetch(B + '/updates/parts/manifest.json')).json();

console.log('title страницы:   ', title);
console.log('manifest name:    ', manifest.name, '/', manifest.short_name);
console.log('версия в клиенте: ', html.includes("APP_VERSION = '1.4.2'") ? '1.4.2 ✓' : 'НЕ 1.4.2');
console.log('экран входа:      ', html.includes('<h1>Arc</h1>') ? 'Arc ✓' : 'не Arc');
console.log('фид обновлений:   ', yml.split('\n')[0].trim());
console.log('файл установщика: ', man.file, '|', man.size, 'байт |', man.parts.length, 'частей');

const head = await fetch(B + '/updates/' + man.file, { method: 'HEAD' });
console.log('HEAD установщика: ', head.status, head.headers.get('content-length'), 'байт');

const oldName = await fetch(B + '/updates/Messenger-Setup-1.4.1.exe', { method: 'HEAD' });
console.log('старое имя:       ', oldName.status, '(ожидаем 404)');

const icons = ['/icon-192.png', '/favicon.ico', '/apple-touch-icon.png'];
for (const path of icons) {
  const res = await fetch(B + path);
  console.log('иконка', path.padEnd(22), res.status, (await res.arrayBuffer()).byteLength, 'байт');
}
