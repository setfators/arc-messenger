// Проверка APK-раздачи и привязки домена на живом сервере.
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

// APK
for (const path of ['/download/Arc.apk', '/download/Arc-1.4.2.apk']) {
  const res = await fetch(B + path);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || '';
  check(`${path} отдаётся (${(buf.byteLength / 1048576).toFixed(2)} МБ)`, res.status === 200 && buf.byteLength > 1_000_000, String(res.status));
  check(`  тип ${path}`, ct.includes('android.package') || ct.includes('octet-stream') || ct.includes('zip'), ct);
  // APK — это zip: проверяем сигнатуру
  const head = new Uint8Array(buf.slice(0, 4));
  check(`  ${path} — настоящий APK (zip)`, head[0] === 0x50 && head[1] === 0x4b, Array.from(head).join(','));
}

// assetlinks
const al = await fetch(B + '/.well-known/assetlinks.json');
const alText = await al.text();
check('assetlinks.json отдаётся', al.status === 200, String(al.status));
check('  тип application/json', (al.headers.get('content-type') || '').includes('json'), al.headers.get('content-type'));
let parsed = null;
try { parsed = JSON.parse(alText); } catch (_) {}
check('  указывает на ru.arc.messenger', !!(parsed && parsed[0] && parsed[0].target && parsed[0].target.package_name === 'ru.arc.messenger'), alText.slice(0, 120));
check('  содержит отпечаток подписи', /A3:8C:D8:B3/.test(alText), '');

// Ссылка в интерфейсе
const page = await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } });
const html = await page.text();
check('в настройках есть ссылка на APK', html.includes('/download/Arc.apk'), '');
check('версия клиента 1.4.2', html.includes("APP_VERSION = '1.4.2'"), '');
check('заголовок Arc', html.includes('<title>Arc</title>'), '');

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
