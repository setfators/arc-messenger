// Тест встроенного модуля разметки сообщений из public/index.html (ArcRich).
// Запуск: cd cloudflare; node test-markdown-113.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsdom } from './test-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { JSDOM } = loadJsdom();
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://arc.test/',
  runScripts: 'outside-only'
});
const window = dom.window;
const document = window.document;

const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');
const block = html.match(/<script id="arc-rich">([\s\S]*?)<\/script>/);
if (!block) {
  console.log('FAIL в public/index.html нет блока arc-rich');
  process.exit(1);
}
window.eval(block[1]);

const Arc = window.ArcRich;
const problems = [];
let checks = 0;

function check(name, condition, extra) {
  checks++;
  if (condition) {
    console.log('ok   ' + name);
    return;
  }
  console.log('FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  problems.push(name);
}

if (!Arc || typeof Arc.render !== 'function' || typeof Arc.embeds !== 'function') {
  console.log('FAIL модуль ArcRich не загрузился (window.ArcRich.render/embeds)');
  process.exit(1);
}

function frag(text, opts) {
  return Arc.render(text, opts);
}
function q(text, selector, opts) {
  return frag(text, opts).querySelector(selector);
}
function qa(text, selector, opts) {
  return frag(text, opts).querySelectorAll(selector);
}
function textOf(text, opts) {
  return frag(text, opts).textContent;
}
function nodeText(node) {
  return node ? node.textContent : null;
}
function nodeAttr(node, name) {
  return node ? node.getAttribute(name) : null;
}
function htmlOf(text, opts) {
  const holder = document.createElement('div');
  holder.appendChild(frag(text, opts).cloneNode(true));
  return holder.innerHTML;
}

// --- базовое -------------------------------------------------------------

const basic = frag('просто текст');
check('render возвращает DocumentFragment', basic instanceof window.DocumentFragment);
check('простой текст сохраняется', basic.textContent === 'просто текст', basic.textContent);

// --- инлайн-разметка -----------------------------------------------------

const bold = q('**жирный**', 'strong');
check('**жирный** → <strong>', !!bold && bold.textContent === 'жирный', nodeText(bold));
const italic = q('*курсив*', 'em');
check('*курсив* → <em>', !!italic && italic.textContent === 'курсив', nodeText(italic));
const underline = q('__подчёркнутый__', 'u');
check('__подчёркнутый__ → <u>', !!underline && underline.textContent === 'подчёркнутый', nodeText(underline));
const strike = q('~~зачёркнутый~~', 's');
check('~~зачёркнутый~~ → <s>', !!strike && strike.textContent === 'зачёркнутый', nodeText(strike));

const spoilerFrag = frag('||секрет||');
const spoiler = spoilerFrag.querySelector('.md-spoiler');
check('спойлер: span.md-spoiler с текстом',
  !!spoiler && spoiler.textContent === 'секрет', nodeText(spoiler));
check('спойлер: класса open ещё нет',
  !!spoiler && !spoiler.classList.contains('open'));
if (spoiler) spoiler.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('спойлер: после клика добавляется класс open',
  !!spoiler && spoiler.classList.contains('open'));

const inlineCode = q('`**не жирный**`', 'code.md-code');
check('`код` → code.md-code, разметка внутри не работает',
  !!inlineCode && inlineCode.textContent === '**не жирный**'
  && !inlineCode.querySelector('strong'),
  nodeText(inlineCode));

// --- блоки ---------------------------------------------------------------

const codeBlock = q('```js\nconst a = **b**;\n```', 'pre.md-pre');
const codeBlockCode = codeBlock && codeBlock.querySelector('code');
check('```блок``` → pre.md-pre > code, текст как есть',
  !!codeBlock && !!codeBlockCode
  && codeBlockCode.textContent === 'const a = **b**;'
  && !codeBlock.querySelector('strong'),
  nodeText(codeBlock));

const quote = q('> раз\n> два', 'blockquote.md-quote');
check('цитата: одна blockquote.md-quote на две строки',
  !!quote && qa('> раз\n> два', 'blockquote').length === 1
  && !!quote.querySelector('br')
  && quote.textContent.includes('раз') && quote.textContent.includes('два'),
  nodeText(quote));

const ul = q('- один\n- два', 'ul.md-list');
check('список - → ul.md-list с двумя li',
  !!ul && ul.querySelectorAll('li').length === 2
  && ul.textContent.includes('один') && ul.textContent.includes('два'),
  nodeText(ul));

const ulStar = q('* один\n* два', 'ul.md-list');
check('список * → ul.md-list',
  !!ulStar && ulStar.querySelectorAll('li').length === 2);

const ol = q('1. раз\n2. два', 'ol.md-list');
check('список 1. → ol.md-list с двумя li',
  !!ol && ol.querySelectorAll('li').length === 2);

const h1 = q('# Заголовок', 'div.md-h1');
check('заголовок # → div.md-h1',
  !!h1 && h1.textContent === 'Заголовок', nodeText(h1));
const h2 = q('## Ещё', 'div.md-h2');
check('заголовок ## → div.md-h2', !!h2 && h2.textContent === 'Ещё', nodeText(h2));
const h3 = q('### Мелкий', 'div.md-h3');
check('заголовок ### → div.md-h3', !!h3 && h3.textContent === 'Мелкий', nodeText(h3));

const twoParagraphs = frag('абзац один\n\nабзац два');
check('пустая строка → отдельные абзацы',
  twoParagraphs.querySelectorAll('div.md-p').length === 2
  && twoParagraphs.textContent.includes('абзац один')
  && twoParagraphs.textContent.includes('абзац два'),
  twoParagraphs.textContent);

const brFrag = frag('строка один\nстрока два');
check('перенос строки → <br>',
  brFrag.querySelectorAll('br').length === 1
  && brFrag.textContent === 'строка одинстрока два',
  brFrag.textContent);

// --- ссылки --------------------------------------------------------------

const link = q('смотри https://example.com/page', 'a.md-link');
check('автоссылка https:// → a.md-link с href',
  !!link && link.getAttribute('href') === 'https://example.com/page', nodeAttr(link, 'href'));
check('ссылка: target=_blank и rel=noopener noreferrer',
  !!link && link.getAttribute('target') === '_blank'
  && link.getAttribute('rel') === 'noopener noreferrer',
  nodeAttr(link, 'rel'));
check('http:// тоже становится ссылкой', !!q('http://example.com/x', 'a.md-link'));

const punctFrag = frag('см. https://example.com/page.');
const punctLink = punctFrag.querySelector('a.md-link');
check('хвостовая пунктуация не входит в ссылку',
  !!punctLink && punctLink.getAttribute('href') === 'https://example.com/page'
  && punctLink.textContent === 'https://example.com/page'
  && punctFrag.textContent.endsWith('.'),
  nodeAttr(punctLink, 'href'));

const jsFrag = frag('javascript:alert(1)');
check('javascript: не становится ссылкой',
  jsFrag.querySelectorAll('a').length === 0
  && jsFrag.textContent === 'javascript:alert(1)',
  jsFrag.textContent);

const codeNoLink = frag('`https://example.com`');
check('ссылка внутри `кода` не автолинкуется',
  codeNoLink.querySelectorAll('a').length === 0
  && nodeText(codeNoLink.querySelector('code')) === 'https://example.com');

// --- упоминания и эмодзи -------------------------------------------------

const mentionFrag = frag('@Имя привет', { mentionable: new Set(['имя']) });
const mention = mentionFrag.querySelector('span.md-mention');
check('известное @Имя → span.md-mention[data-name]',
  !!mention && mention.getAttribute('data-name') === 'Имя'
  && mention.textContent === '@Имя',
  nodeAttr(mention, 'data-name'));

let mentionSeen = null;
frag('@Имя привет', { mentionable: new Set(['имя']), onMention: (name) => { mentionSeen = name; } });
check('onMention вызывается с именем', mentionSeen === 'Имя', mentionSeen);

const unknownMention = frag('@Неизвестный', { mentionable: new Set(['имя']) });
check('неизвестное @Имя остаётся текстом',
  unknownMention.querySelectorAll('span.md-mention').length === 0
  && unknownMention.textContent === '@Неизвестный',
  unknownMention.textContent);

const mentionCase = frag('@ИМЯ', { mentionable: new Set(['имя']) });
check('упоминание ищется без учёта регистра',
  !!mentionCase.querySelector('span.md-mention')
  && mentionCase.querySelector('span.md-mention').textContent === '@ИМЯ');

const emojiFrag = frag(':party:', { emojis: new Map([['party', 'https://cdn.example.com/party.png']]) });
const emoji = emojiFrag.querySelector('img.md-emoji');
check('известное :emoji: → img.md-emoji',
  !!emoji && emoji.getAttribute('src') === 'https://cdn.example.com/party.png'
  && emoji.getAttribute('alt') === ':party:' && emoji.getAttribute('draggable') === 'false',
  nodeAttr(emoji, 'src'));

const unknownEmoji = frag(':nope:', { emojis: new Map([['party', 'https://cdn.example.com/party.png']]) });
check('неизвестное :emoji: остаётся текстом',
  unknownEmoji.querySelectorAll('img').length === 0
  && unknownEmoji.textContent === ':nope:',
  unknownEmoji.textContent);

let channelSeen = null;
const channelFrag = frag('#общий', { onChannel: (name) => { channelSeen = name; } });
const channel = channelFrag.querySelector('span.md-channel');
check('опциональный onChannel создаёт span.md-channel',
  !!channel && channel.getAttribute('data-name') === 'общий' && channelSeen === 'общий',
  nodeAttr(channel, 'data-name'));

// --- XSS ----------------------------------------------------------------

const xssImg = frag('<img src=x onerror=alert(1)>');
check('XSS <img onerror> остаётся текстом',
  xssImg.querySelectorAll('img').length === 0
  && xssImg.textContent === '<img src=x onerror=alert(1)>',
  xssImg.textContent);

const xssScript = frag('<script>alert(1)</script>');
check('XSS <script> остаётся текстом',
  xssScript.querySelectorAll('script').length === 0
  && xssScript.textContent === '<script>alert(1)</script>',
  xssScript.textContent);

const xssBold = frag('**<img src=x onerror=alert(1)>**');
const xssStrong = xssBold.querySelector('strong');
check('XSS внутри **жирного** не создаёт элементы',
  xssBold.querySelectorAll('img').length === 0
  && !!xssStrong && xssStrong.textContent === '<img src=x onerror=alert(1)>',
  nodeText(xssStrong));

// --- вложенность, код, незакрытые маркеры --------------------------------

const nested = frag('**жирный *курсив***');
const nestedEm = nested.querySelector('strong em');
check('вложенность: жирный + курсив',
  !!nestedEm && nestedEm.textContent === 'курсив'
  && nested.querySelector('strong').textContent === 'жирный курсив',
  htmlOf('**жирный *курсив***'));

const codeInBold = frag('**текст `a * b` конец**');
const codeInBoldNode = codeInBold.querySelector('strong code.md-code');
check('код внутри жирного не форматируется',
  !!codeInBoldNode && codeInBoldNode.textContent === 'a * b'
  && codeInBoldNode.querySelectorAll('em').length === 0
  && codeInBoldNode.querySelectorAll('strong').length === 0,
  nodeText(codeInBoldNode));

const linkInSpoiler = frag('||https://example.com||');
check('ссылка внутри спойлера работает',
  !!linkInSpoiler.querySelector('span.md-spoiler a.md-link')
  && nodeAttr(linkInSpoiler.querySelector('span.md-spoiler a.md-link'), 'href') === 'https://example.com');

const unclosedBold = frag('**жирный');
check('незакрытый ** остаётся текстом',
  unclosedBold.querySelectorAll('strong').length === 0
  && unclosedBold.textContent === '**жирный',
  unclosedBold.textContent);

const unclosedItalic = frag('*курсив');
check('незакрытый * остаётся текстом',
  unclosedItalic.querySelectorAll('em').length === 0
  && unclosedItalic.textContent === '*курсив',
  unclosedItalic.textContent);

const escaped = frag('\\*не курсив\\*');
check('\\* экранирование даёт сам символ',
  escaped.querySelectorAll('em').length === 0
  && escaped.textContent === '*не курсив*',
  escaped.textContent);

// --- обрезка ------------------------------------------------------------

const longFrag = frag('a'.repeat(4500));
check('длинный текст обрезается до maxLength=4000',
  longFrag.textContent.length === 4000, longFrag.textContent.length);
check('обрезанный текст помечен md-clip', !!longFrag.querySelector('.md-clip'));

const shortClip = frag('abcdefgh', { maxLength: 5 });
check('opts.maxLength обрезает текст',
  shortClip.textContent === 'abcde' && !!shortClip.querySelector('.md-clip'),
  shortClip.textContent);

const emojiClip = frag('😀'.repeat(10), { maxLength: 3 });
check('обрезка идёт по кодовым точкам (не рвёт суррогаты)',
  Array.from(emojiClip.textContent).length === 3
  && emojiClip.textContent === '😀😀😀',
  emojiClip.textContent);

// --- embeds --------------------------------------------------------------

const ytWatch = Arc.embeds('смотри https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90');
check('embeds: youtube watch + t=',
  ytWatch.length === 1 && ytWatch[0].type === 'youtube'
  && ytWatch[0].id === 'dQw4w9WgXcQ' && ytWatch[0].start === 90
  && typeof ytWatch[0].url === 'string',
  ytWatch);

const ytShort = Arc.embeds('https://youtu.be/abc12345');
check('embeds: youtu.be',
  ytShort.length === 1 && ytShort[0].type === 'youtube'
  && ytShort[0].id === 'abc12345' && ytShort[0].start === 0,
  ytShort);

const ytShorts = Arc.embeds('https://youtube.com/shorts/xyz987?t=30s');
check('embeds: shorts + t=30s',
  ytShorts.length === 1 && ytShorts[0].type === 'youtube'
  && ytShorts[0].id === 'xyz987' && ytShorts[0].start === 30,
  ytShorts);

const ytStart = Arc.embeds('https://youtube.com/watch?start=42&v=idididid');
check('embeds: start= из query',
  ytStart.length === 1 && ytStart[0].type === 'youtube'
  && ytStart[0].id === 'idididid' && ytStart[0].start === 42,
  ytStart);

const image = Arc.embeds('https://cdn.example.com/pic.png');
check('embeds: прямая картинка .png',
  image.length === 1 && image[0].type === 'image'
  && image[0].url === 'https://cdn.example.com/pic.png',
  image);

const imageUpper = Arc.embeds('https://cdn.example.com/pic.WEBP');
check('embeds: картинка с расширением в верхнем регистре',
  imageUpper.length === 1 && imageUpper[0].type === 'image',
  imageUpper);

const site = Arc.embeds('https://www.example.com/page?a=1');
check('embeds: обычный сайт, host без www',
  site.length === 1 && site[0].type === 'site'
  && site[0].host === 'example.com'
  && site[0].url === 'https://www.example.com/page?a=1',
  site);

const dupes = Arc.embeds('https://youtu.be/abc12345 и снова https://youtu.be/abc12345');
check('embeds: дубликаты убираются', dupes.length === 1 && dupes[0].id === 'abc12345', dupes);

const none = Arc.embeds('просто текст без ссылок');
check('embeds: текст без ссылок → пустой массив',
  Array.isArray(none) && none.length === 0, none);

const codeEmbed = Arc.embeds('`https://youtu.be/abc12345`');
check('embeds: ссылка в инлайн-коде не считается', codeEmbed.length === 0, codeEmbed);

const fenceEmbed = Arc.embeds('```\nhttps://youtu.be/abc12345\n```');
check('embeds: ссылка в ```блоке``` не считается', fenceEmbed.length === 0, fenceEmbed);

const indentedFence = q('  ```\nhttps://youtu.be/abc12345\n  ```', 'pre.md-pre');
check('блок кода с отступом тоже распознаётся',
  !!indentedFence && indentedFence.querySelector('code').textContent === 'https://youtu.be/abc12345');
check('embeds: ссылка в блоке кода с отступом не считается',
  Arc.embeds('  ```\nhttps://youtu.be/abc12345\n  ```').length === 0,
  Arc.embeds('  ```\nhttps://youtu.be/abc12345\n  ```'));

const limitTwo = Arc.embeds('https://a.example/1 https://b.example/2 https://c.example/3');
check('embeds: не больше двух, порядок как в тексте',
  limitTwo.length === 2
  && limitTwo[0].host === 'a.example'
  && limitTwo[1].host === 'b.example',
  limitTwo);

const imageQuery = Arc.embeds('https://cdn.example.com/pic.png?v=2');
check('embeds: картинка с query → site',
  imageQuery.length === 1 && imageQuery[0].type === 'site', imageQuery);

const wordBoundary = Arc.embeds('foohttps://youtu.be/abc12345');
check('embeds: ссылка не «выдёргивается» из слова',
  wordBoundary.length === 0, wordBoundary);

const embedPunct = Arc.embeds('см. https://example.com/page.');
check('embeds: хвостовая пунктуация не входит в url',
  embedPunct.length === 1 && embedPunct[0].url === 'https://example.com/page',
  embedPunct);

// --- итог ----------------------------------------------------------------

console.log('\nпроверок: ' + checks + ', провалено: ' + problems.length);
if (problems.length) {
  console.log('провалы: ' + problems.join('; '));
  process.exitCode = 1;
}
dom.window.close();
setTimeout(() => process.exit(process.exitCode || 0), 100);
