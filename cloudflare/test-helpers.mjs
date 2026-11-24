// Общие пути и загрузчики для тестов.
// Всё считается от расположения этого файла, поэтому наборы работают
// и на другой машине, и в CI.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const CLIENT_HTML = path.join(HERE, 'public', 'index.html');
export const MOBILE_HTML = path.join(HERE, 'mobile', 'www', 'index.html');
export const PROJECT_HTML = path.join(ROOT, 'web', 'index.html');
export const require = createRequire(import.meta.url);

// ws — зависимость проекта, лежит в node_modules рядом.
export function loadWs() {
  return require('ws');
}

// jsdom: сначала из node_modules проекта, потом из JSDOM_DIR, затем глобально.
export function loadJsdom() {
  const candidates = [
    'jsdom',
    process.env.JSDOM_DIR,
  ].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('jsdom не установлен: npm i -D jsdom (или задайте JSDOM_DIR) — ' + (lastError ? lastError.message : ''));
}
