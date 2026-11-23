// Проверка живого/локального сервера 1.4.0: страница, sw, фид обновлений.
const B = process.env.BASE || 'http://127.0.0.1:8791';

const health = await fetch(B + '/health');
console.log('/health:', health.status, await health.text());

const page = await fetch(B + '/');
const html = await page.text();
console.log('страница:', page.status, 'байт', html.length);
for (const marker of ["APP_VERSION = '1.4.1'", 'msg_react', 'search_messages', 'push_subscribe', '/api/media', 'openUserCard', 'tabAccount']) {
  console.log('  маркер', marker, '=', html.includes(marker));
}

const sw = await fetch(B + '/sw.js');
const swText = await sw.text();
console.log('/sw.js:', sw.status, 'push =', swText.includes("addEventListener('push'"), 'notificationclick =', swText.includes("addEventListener('notificationclick'"));

const ymlRes = await fetch(B + '/updates/latest.yml');
const yml = await ymlRes.text();
console.log('latest.yml:', ymlRes.status, yml.split('\n')[0].trim());

const man = await (await fetch(B + '/updates/parts/manifest.json')).json();
console.log('manifest:', man.file, 'size', man.size, 'частей', man.parts.length);

const exeUrl = B + '/updates/' + man.file;
const head = await fetch(exeUrl, { method: 'HEAD' });
console.log('HEAD установщика:', head.status, 'content-length', head.headers.get('content-length'), head.headers.get('content-type'));

const tail = await fetch(exeUrl, { headers: { range: `bytes=${man.size - 100}-` } });
console.log('хвост:', tail.status, (await tail.arrayBuffer()).byteLength, 'байт');

const bad = await fetch(exeUrl, { headers: { range: 'bytes=999999999-' } });
console.log('неверный Range →', bad.status, '(ожидаем 416)');

const oldExe = await fetch(B + '/updates/Messenger-Setup-1.4.0.exe', { method: 'HEAD' });
console.log('старое имя установщика →', oldExe.status, '(ожидаем 404)');

const media = await fetch(B + '/media/nonexistent');
console.log('несуществующая картинка:', media.status, '(ожидаем 404)');

const getMedia = await fetch(B + '/api/media');
console.log('GET /api/media:', getMedia.status, 'allow =', getMedia.headers.get('allow'), '(ожидаем 405)');
