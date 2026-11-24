// Проверка новых возможностей на живом сервере.
const B = 'https://rust-messenger.sg530507.workers.dev';
import crypto from 'node:crypto';
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
  check('правка сообщений', page.includes('edited-mark') && page.includes("case 'msg_edit'"));
  check('подсказка об уведомлениях в APK', page.includes('фоновых уведомлений нет'));
  check('кнопка установки приложения', page.includes('appInstalled'));

  const apk = Buffer.from(await (await fetch(B + '/download/Arc.apk')).arrayBuffer());
  const sha = crypto.createHash('sha256').update(apk).digest('hex').toUpperCase();
  check('APK отдаётся', apk.length > 3_000_000, (apk.length / 1048576).toFixed(2) + ' МБ');
  check('APK совпадает с локальным', sha === '1AF295B112236305E353817E73C2FDB56E937164562CE9388E191A3814584FFB', sha.slice(0, 12));

  console.log('\nпроблем: ' + problems.length);
  if (problems.length) process.exitCode = 1;
})();
