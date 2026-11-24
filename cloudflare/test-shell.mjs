// Проверка различий между сайтом и мобильной сборкой: внутри APK должна быть
// подсказка об уведомлениях, на сайте — кнопка установки.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const web = readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');
const mobilePath = path.join(HERE, 'mobile', 'www', 'index.html');
let mobile = '';
try { mobile = readFileSync(mobilePath, 'utf8'); } catch (_) { mobile = ''; }

// Общее: в обеих сборках есть обработка правки и карточка файла.
for (const [name, html] of [['сайт', web], ['APK', mobile]]) {
  check(name + ': кнопка правки сообщения', html.includes("edit-msg"), '');
  check(name + ': пометка «изменено»', html.includes('edited-mark'), '');
  check(name + ': обработка msg_edit', html.includes("case 'msg_edit'"), '');
  check(name + ': карточка файла', html.includes('file-card'), '');
  check(name + ': определение APK-оболочки', html.includes('function insideNativeShell'), '');
  check(name + ': кнопка установки приложения', html.includes('beforeinstallprompt'), '');
  check(name + ': смена экрана на лету', html.includes('function switchScreen') && html.includes('replaceTrack'), '');
  check(name + ': кнопки «Сменить экран»', html.includes("id=\"switchScreen\"") && html.includes("id=\"callSwitch\""), '');
  check(name + ': адаптивная вёрстка', html.includes('100dvh') && html.includes('safe-area-inset') && html.includes('@media (max-width: 480px)'), '');
  check(name + ': пересчёт размеров окна', html.includes('function syncViewport') && html.includes("addEventListener('orientationchange'"), '');
  check(name + ': мета вьюпорта для клавиатуры', html.includes('interactive-widget=resizes-content'), '');
}

// Различия: в APK подсказка про уведомления, на сайте — про установку.
check('в APK есть предупреждение об уведомлениях', mobile.includes('фоновых уведомлений нет'), '');
check('в APK нет кнопки установки PWA в настройках', mobile.includes('insideNativeShell() && !appInstalled()'), '');
check('в APK адрес сервера внедрён', mobile.includes('window.__ARC_SERVER__'), '');
check('на сайте адрес сервера не внедрён', !web.includes('window.__ARC_SERVER__ ='), '');

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
