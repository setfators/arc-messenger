// Проверка на живом сервере: общий канал стал обычным, состояние «каналов нет».
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('есть пустое состояние каналов', page.includes('function showNoChannels'));
check('есть экран знакомства', page.includes('Добро пожаловать в Arc') && page.includes('Открыть демо-канал'));
check('демо-канал и статистика на месте', page.includes('demo_open') && page.includes('stats_get'));
check('ссылка-приглашение в канале', page.includes('channelJoin') === false && page.includes('channel_join') && page.includes('channelInviteLink'));
check('демонстрация экрана до 60 кадров', page.includes('screenFpsValue') && page.includes('60 кадров · плавно'));
check('смена экрана на лету', page.includes('function switchScreen') && page.includes('replaceTrack'));
check('адаптивная вёрстка', page.includes('100dvh') && page.includes('safe-area-inset') && page.includes('function syncViewport'));
check('галерея экранов в звонке', page.includes('screenTiles') && page.includes('function renderScreenArea') && page.includes('store.screenFocus'));
check('два экрана рядом и возврат', page.includes('id="screenSplit"') && page.includes('id="callAllScreens"') && page.includes('screen-cell'));
check('версия клиента', /APP_VERSION = '\d+\.\d+\.\d+'/.test(page));
check('каналы приватные: замок и число участников', page.includes("'lock', '🔒'") && page.includes("'cnt'"));
check('удаление общего канала не блокируется', !page.includes('Общий канал удалить нельзя'));
check('звонки в личке на месте', page.includes('startDmCall') && page.includes('callBox'));
check('правка сообщений на месте', page.includes('edited-mark'));
check('файлы на месте', page.includes('file-card'));

const health = await fetch(B + '/health');
check('сервер отвечает', health.status === 200, String(health.status));

// Протокол: гость не может удалять каналы.
const opt = await fetch(B + '/api/media', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
check('CORS жив', opt.status === 204, String(opt.status));

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
