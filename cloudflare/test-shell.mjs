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
  check(name + ': галерея экранов в звонке', html.includes('id="screenTiles"') && html.includes('store.screenFocus'), '');
  check(name + ': два экрана рядом (split)', html.includes('id="screenSplit"') && html.includes('function renderScreenArea') && html.includes('screen-cell'), '');
  check(name + ': возврат ко всем экранам', html.includes('id="callAllScreens"') && html.includes("'Все экраны'"), '');
  check(name + ': адаптив двух экранов', html.includes('grid-template-rows: 1fr 1fr'), '');
  check(name + ': система анимаций', html.includes('@keyframes msgIn') && html.includes('--ease-out') && html.includes('--t3'), '');
  check(name + ': анимация только новых сообщений', html.includes('msg-fresh') && html.includes('freshIds'), '');
  check(name + ': окна и тосты анимированы', html.includes('.modal-back > .dlg') && html.includes('toastIn'), '');
  check(name + ': уважение «меньше движения»', html.includes('prefers-reduced-motion'), '');
  check(name + ': настройка «Плавные анимации»', html.includes('no-anim') && html.includes('Плавные анимации') && html.includes('animations: true'), '');
  check(name + ': кнопка «вниз / новые сообщения»', html.includes('id="jumpDown"') && html.includes('function jumpToBottom') && html.includes('updateJumpDown'), '');
  check(name + ': вкладка «Бинды»', html.includes('data-tab="binds"') && html.includes('function tabBinds'), '');
  check(name + ': бинды на боковые кнопки мыши', html.includes('Mouse4') && html.includes('mouseBindMatches') && html.includes('mouseBindCombo'), '');
  check(name + ': запись бинда', html.includes('function captureBind') && html.includes('bind-btn'), '');
  check(name + ': блок оверлея в настройках', html.includes('Оверлей поверх игр') && html.includes('overlaySupported'), '');
  check(name + ': мини-превью экранов', html.includes('scr-tile') && html.includes('scr-tile-name'), '');
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
