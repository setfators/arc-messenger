// Генератор обложек для кворков Kwork: 1320×880 PNG.
// Запуск: node scripts/make-kwork-covers.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT = path.resolve('docs/freelance/kwork');
mkdirSync(OUT, { recursive: true });

const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!chrome) { console.error('Chrome не найден'); process.exit(1); }

const baseCss = `
  * { box-sizing: border-box; }
  html, body { width: 1320px; height: 880px; margin: 0; overflow: hidden; }
  body {
    background:
      radial-gradient(720px 420px at 12% 0%, rgba(91,140,255,.28), transparent 65%),
      radial-gradient(620px 360px at 92% 4%, rgba(139,91,255,.22), transparent 65%),
      #0b0d12;
    color: #eef2f9;
    font-family: "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif;
    padding: 64px 68px;
    display: flex; flex-direction: column;
  }
  .badge {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 10px;
    padding: 9px 16px; border: 1px solid rgba(255,255,255,.16); border-radius: 999px;
    font-size: 19px; color: #aab5c9; letter-spacing: .04em;
  }
  .badge i { width: 9px; height: 9px; border-radius: 50%; background: #3ddc97; box-shadow: 0 0 0 5px rgba(61,220,151,.12); }
  h1 { margin: 34px 0 18px; font-size: 72px; line-height: .98; letter-spacing: -.03em; max-width: 900px; font-weight: 800; }
  h1 span { background: linear-gradient(100deg, #7ea6ff, #b58cff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { color: #9aa6bb; font-size: 26px; line-height: 1.35; max-width: 640px; }
  .chips { display: flex; gap: 10px; margin-top: auto; position: relative; z-index: 2; }
  .chip { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); border-radius: 999px; padding: 10px 17px; font-size: 18px; color: #b9c3d6; }
  .mock { position: absolute; right: 64px; bottom: 74px; width: 470px; border-radius: 22px; overflow: hidden; border: 1px solid rgba(255,255,255,.16); background: #141821; box-shadow: 0 34px 80px rgba(0,0,0,.55); }
  .bar { display: flex; gap: 7px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .bar i { width: 9px; height: 9px; border-radius: 50%; background: #394154; }
  .body { padding: 20px; display: grid; gap: 12px; }
  .hero { height: 132px; border-radius: 14px; background: linear-gradient(135deg, #23335c, #4c2f7a 55%, #8b5bff); position: relative; }
  .hero b { position: absolute; left: 18px; bottom: 16px; font-size: 21px; color: #fff; }
  .line { height: 10px; border-radius: 5px; background: rgba(255,255,255,.13); }
  .line.s { width: 62%; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tile { height: 72px; border-radius: 12px; background: #1d2432; border: 1px solid rgba(255,255,255,.08); }
  .cta { height: 46px; width: 52%; border-radius: 12px; background: linear-gradient(135deg, #5b8cff, #8b5bff); }
`;

const covers = [
  {
    file: 'cover-landing.png',
    badge: 'Веб-разработка · сайты под ключ',
    title: 'Лендинг для малого<br>бизнеса <span>за 4 дня</span>',
    sub: 'Структура, дизайн, адаптив и форма заявки. Без конструкторов — код передаю вам.',
    chips: ['Адаптив под телефон', 'Форма в Telegram', 'Подключение домена'],
    mock: `
      <div class="mock"><div class="bar"><i></i><i></i><i></i></div>
        <div class="body">
          <div class="hero"><b>Кофейня «Тёплый угол»</b></div>
          <div class="line"></div><div class="line s"></div>
          <div class="row"><div class="tile"></div><div class="tile"></div></div>
          <div class="cta"></div>
        </div>
      </div>`,
  },
  {
    file: 'cover-booking.png',
    badge: 'Telegram Mini App · запись клиентов',
    title: 'Telegram-запись,<br>в которой клиент <span>выбирает сам</span>',
    sub: 'Услуга, дата и время вместо звонков. Заявка сразу приходит администратору в Telegram.',
    chips: ['Свободные слоты', 'Уведомления', 'Работает на телефоне'],
    mock: `
      <div class="mock" style="width: 390px; right: 96px; bottom: 66px; border-radius: 34px;">
        <div class="body" style="padding: 26px 22px; gap: 14px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(140deg,#d8b26a,#b98c45);display:grid;place-items:center;color:#17120a;font-weight:800;font-size:20px;">✂</div>
            <div><div style="font-weight:700;font-size:17px;">Тихий срез</div><div style="color:#93a0b6;font-size:12px;">Иркутск · запись</div></div>
          </div>
          <div style="height:9px;width:100%;background:rgba(216,178,106,.25);border-radius:9px;overflow:hidden;"><div style="width:66%;height:100%;background:#d8b26a;"></div></div>
          <div style="background:#1d2432;border:1px solid rgba(255,255,255,.1);border-radius:13px;padding:13px 15px;font-size:15px;display:flex;justify-content:space-between;"><span>Стрижка + борода</span><b style="color:#d8b26a;">2 700 ₽</b></div>
          <div style="display:flex;gap:8px;">
            <div style="flex:1;text-align:center;border:1px solid #d8b26a;border-radius:12px;padding:10px 0;color:#d8b26a;font-weight:700;">28<br><small style="font-weight:400;font-size:10px;">пт</small></div>
            <div style="flex:1;text-align:center;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 0;">29<br><small style="color:#93a0b6;font-size:10px;">сб</small></div>
            <div style="flex:1;text-align:center;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 0;">30<br><small style="color:#93a0b6;font-size:10px;">вс</small></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;">
            <div style="background:#d8b26a;color:#17120a;border-radius:9px;padding:9px 0;text-align:center;font-weight:700;font-size:13px;">10:00</div>
            <div style="border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:9px 0;text-align:center;font-size:13px;">11:30</div>
            <div style="border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:9px 0;text-align:center;font-size:13px;opacity:.35;">13:00</div>
            <div style="border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:9px 0;text-align:center;font-size:13px;">14:30</div>
          </div>
          <div style="height:46px;border-radius:12px;background:linear-gradient(135deg,#d8b26a,#b98c45);color:#17120a;display:grid;place-items:center;font-weight:800;font-size:15px;">Подтвердить запись</div>
        </div>
      </div>`,
  },
  {
    file: 'cover-fix.png',
    badge: 'Веб-разработка · правки и адаптив',
    title: 'Исправлю вёрстку<br>и ошибки <span>за 1 день</span>',
    sub: 'Съезжает мобильная версия, не работает форма или кнопка? Найду причину и починю.',
    chips: ['Адаптив', 'Формы и JS', 'Проверка на телефоне'],
    mock: `
      <div class="mock"><div class="bar"><i></i><i></i><i></i></div>
        <div class="body">
          <div style="position:relative;height:150px;border-radius:12px;background:linear-gradient(140deg,#3a1f28,#5c2a37);border:1px solid rgba(255,86,110,.35);">
            <div style="position:absolute;left:22px;top:26px;width:130px;height:26px;background:rgba(255,255,255,.18);border-radius:6px;transform:rotate(-3deg);"></div>
            <div style="position:absolute;right:-16px;top:58px;width:170px;height:74px;background:#1d2432;border:1px dashed rgba(255,86,110,.6);border-radius:10px;"></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;color:#3ddc97;font-size:16px;font-weight:700;">✓ Проверено на телефоне</div>
          <div class="line"></div><div class="line s"></div>
          <div class="row"><div class="tile"></div><div class="tile"></div></div>
        </div>
      </div>`,
  },
];

for (const cover of covers) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head><body>
    <div class="badge"><i></i>${cover.badge}</div>
    <h1>${cover.title}</h1>
    <div class="sub">${cover.sub}</div>
    ${cover.mock}
    <div class="chips">${cover.chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>
  </body></html>`;
  const file = path.join(process.env.TEMP, 'kwork-' + cover.file.replace('.png', '.html'));
  writeFileSync(file, html, 'utf8');
  const png = path.join(OUT, cover.file);
  const res = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--window-size=1320,880', '--force-device-scale-factor=1',
    '--screenshot=' + png, 'file:///' + file.replace(/\\/g, '/'),
  ], { stdio: 'inherit' });
  if (res.status !== 0) { console.error('не удалось снять', cover.file); process.exit(1); }
  console.log('готово:', cover.file);
}
console.log('папка:', OUT);
