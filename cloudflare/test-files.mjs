// Проверки отправки файлов: любой тип, имя, размер, скачивание, права.
const B = process.env.BASE || 'http://127.0.0.1:8851';
import WebSocket from 'ws';
const WSURL = B.replace('http', 'ws');
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

async function api(path, body) {
  const res = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
function open(token) {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(token));
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, got })); ws.on('error', () => resolve({ ws, got }));
    setTimeout(() => resolve({ ws, got }), 5000);
  });
}
async function waitFor(client, pred, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(25); }
  return null;
}

const owner = await api('/api/register', { name: 'fil' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const token = owner.data.token;
const ows = await open(token);
await waitFor(ows, (m) => m.t === 'hello');

// 1. Обычный текстовый файл.
const text = new TextEncoder().encode('привет, это файл\nвторая строка\n');
const up1 = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'x-token': token, 'content-type': 'text/plain', 'x-filename': encodeURIComponent('заметка.txt') },
  body: text,
});
const f1 = await up1.json().catch(() => null);
check('текстовый файл принимается', up1.status === 200 && !!f1 && !!f1.id, up1.status + ' ' + JSON.stringify(f1));
check('пришло имя файла', !!(f1 && f1.name === 'заметка.txt'), JSON.stringify(f1 && f1.name));
check('тип отмечен как файл', !!(f1 && f1.kind === 'file'), JSON.stringify(f1 && f1.kind));
check('размер совпадает', !!(f1 && f1.size === text.length), String(f1 && f1.size) + ' vs ' + text.length);

// 2. Скачивание: байты совпадают, есть имя в заголовке.
const dl = await fetch(B + f1.url);
const back = new Uint8Array(await dl.arrayBuffer());
check('файл скачивается', dl.status === 200 && back.length === text.length, String(dl.status));
check('содержимое не изменилось', Buffer.from(back).equals(Buffer.from(text)), '');
const disp = dl.headers.get('content-disposition') || '';
check('отдаётся как скачивание с именем', disp.includes('attachment') && disp.includes('filename*='), disp);
check('тип отдаётся верно', (dl.headers.get('content-type') || '').startsWith('text/plain'), dl.headers.get('content-type'));

// 3. Картинка по-прежнему картинка.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const up2 = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'x-token': token, 'content-type': 'image/png' },
  body: png,
});
const f2 = await up2.json().catch(() => null);
check('картинка по-прежнему принимается', up2.status === 200 && !!(f2 && f2.id), String(up2.status));
check('картинка остаётся картинкой', !!(f2 && f2.kind === 'image'), JSON.stringify(f2 && f2.kind));
const imgRes = await fetch(B + f2.url);
check('картинка отдаётся без attachment', !((imgRes.headers.get('content-disposition') || '').includes('attachment')), '');

// 4. Файл в сообщении доходит до собеседника с метаданными.
const memberName = 'flm' + stamp;
ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const member = await api('/api/register', { name: memberName, password: 'parol123', invite: inv.invite.code });
const mws = await open(member.data.token);
await waitFor(mws, (m) => m.t === 'hello');
ows.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: '', mediaId: f1.id }));
const got = await waitFor(mws, (m) => m.t === 'msg' && m.media && m.media.id === f1.id);
check('сообщение с файлом доходит', !!got, JSON.stringify(mws.got.filter((m) => m.t === 'msg').slice(-1)));
check('у вложения есть имя и размер', !!(got && got.media.name === 'заметка.txt' && got.media.size === text.length), JSON.stringify(got && got.media));
check('собеседник видит kind=file', !!(got && got.media.kind === 'file'), JSON.stringify(got && got.media.kind));

// 5. Защита.
const noToken = await fetch(B + '/api/media', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text });
check('без токена файл не принимается', noToken.status === 401, String(noToken.status));
const empty = await fetch(B + '/api/media', { method: 'POST', headers: { 'x-token': token, 'content-type': 'text/plain' }, body: new Uint8Array(0) });
check('пустой файл отклоняется', empty.status === 400, String(empty.status));
const fakeImage = await fetch(B + '/api/media', {
  method: 'POST', headers: { 'x-token': token, 'content-type': 'image/png' }, body: Buffer.from('это не картинка'),
});
check('поддельная картинка отклоняется', fakeImage.status === 400, String(fakeImage.status));
const noName = await fetch(B + '/api/media', {
  method: 'POST', headers: { 'x-token': token, 'content-type': 'application/zip' }, body: Buffer.from('PK\u0005\u0006'.padEnd(64, 'x')),
});
const f3 = await noName.json().catch(() => null);
check('файл без имени получает имя по умолчанию', noName.status === 200 && !!(f3 && f3.name), JSON.stringify(f3 && f3.name));

// 6. Опасное имя чистится.
const danger = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'x-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('../../etc/passwd') },
  body: Buffer.from('x'),
});
const f4 = await danger.json().catch(() => null);
check('путь из имени выбрасывается', !!(f4 && !String(f4.name).includes('/') && !String(f4.name).includes('..')), JSON.stringify(f4 && f4.name));

// 7. Лимит размера: 11 МБ не принимаем.
const huge = Buffer.alloc(11 * 1024 * 1024, 7);
const big = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'x-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('большой.bin') },
  body: huge,
});
check('файл больше 10 МБ отклоняется', big.status === 400, String(big.status));

// Уборка.
for (const t of [token, member.data.token]) {
  const c = await open(t);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
  await sleep(600);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
