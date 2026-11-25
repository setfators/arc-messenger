// Проверка новых возможностей на живом сервере.
const B = 'https://rust-messenger.sg530507.workers.dev';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

(async () => {
  const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
  check('кнопка звонка в личке', page.includes('id="callBtn"') && page.includes('startDmCall'));
  check('окно звонка', page.includes('callBox') && page.includes('incomingCall'));
  check('обработчик входящего звонка', page.includes("case 'call_incoming'"));
  check('клиент знает лички для звонка', page.includes('dmPartnersOf') && page.includes('callPeerName'));
  check('правка сообщений', page.includes('edited') && page.includes("case 'msg_edit'"));
  check('подсказка об уведомлениях в APK', page.includes('фоновых уведомлений нет'));
  check('кнопка установки приложения', page.includes('appInstalled'));

  const apk = Buffer.from(await (await fetch(B + '/download/Arc.apk')).arrayBuffer());
  const sha = crypto.createHash('sha256').update(apk).digest('hex').toUpperCase();
  check('APK отдаётся', apk.length > 3_000_000, (apk.length / 1048576).toFixed(2) + ' МБ');
  let localSha = '';
  try { localSha = crypto.createHash('sha256').update(readFileSync('public/download/Arc.apk')).digest('hex').toUpperCase(); } catch (_) { localSha = ''; }
  check('APK совпадает с локальным', !!localSha && sha === localSha, sha.slice(0, 12));

  console.log('\nпроблем: ' + problems.length);
  if (problems.length) process.exitCode = 1;
})();
