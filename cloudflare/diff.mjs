// Сравнение двух версий файла без git: печатает компактный diff.
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('нужно: node diff.mjs <старый> <новый>');
  process.exit(2);
}
const A = readFileSync(a, 'utf8').split('\n');
const B = readFileSync(b, 'utf8').split('\n');

// LCS через динамику (файлы до ~2000 строк).
const n = A.length;
const m = B.length;
const w = m + 1;
const dp = new Int32Array((n + 1) * w);
for (let i = n - 1; i >= 0; i -= 1) {
  for (let j = m - 1; j >= 0; j -= 1) {
    dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
}
let i = 0;
let j = 0;
let added = 0;
let removed = 0;
const out = [];
while (i < n && j < m) {
  if (A[i] === B[j]) { i += 1; j += 1; continue; }
  if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
    out.push('-' + (i + 1) + ' | ' + A[i]);
    removed += 1;
    i += 1;
  } else {
    out.push('+' + (j + 1) + ' | ' + B[j]);
    added += 1;
    j += 1;
  }
}
while (i < n) { out.push('-' + (i + 1) + ' | ' + A[i]); removed += 1; i += 1; }
while (j < m) { out.push('+' + (j + 1) + ' | ' + B[j]); added += 1; j += 1; }

console.log(`строк было ${n}, стало ${m}; добавлено ${added}, удалено ${removed}`);
for (const line of out.slice(0, Number(process.env.LIMIT || 400))) console.log(line);
if (out.length > Number(process.env.LIMIT || 400)) console.log('... ещё ' + (out.length - Number(process.env.LIMIT || 400)) + ' строк');
