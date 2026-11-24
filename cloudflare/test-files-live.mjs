// Проверка файлов на живом сервере.
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('карточка файла в клиенте', page.includes('file-card'), '');
check('значок по типу файла', page.includes('function fileGlyph'), '');
check('человекочитаемый размер', page.includes('function humanSize'), '');
check('лимит файла 10 МБ', page.includes('MAX_FILE_BYTES'), '');
check('выбор файла без ограничения по типам', !page.includes('id="mediaFile" accept='), '');
check('файл отдаётся как скачивание', page.includes('file-dl'), '');

const noToken = await fetch(B + '/api/media', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
check('без токена файл не принимается', noToken.status === 401, String(noToken.status));

const opt = await fetch(B + '/api/media', { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-headers': 'x-token,content-type,x-filename' } });
check('CORS пропускает заголовок имени файла', opt.status === 204 && String(opt.headers.get('access-control-allow-headers') || '').toLowerCase().includes('x-filename'), String(opt.status) + ' ' + opt.headers.get('access-control-allow-headers'));

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
