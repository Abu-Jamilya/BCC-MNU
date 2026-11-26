import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_LENGTH = 100_000;
const PDFKIT_SCRIPT = fileURLToPath(new URL('./pdfkit.js', import.meta.url));

function extractPdfPages(path) {
  const options = {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const text = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], options);
    const pages = text.split('\f');
    if (pages.at(-1) === '') pages.pop();
    return pages;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не удалось извлечь текст из PDF. Проверьте файл и его доступность.');
    if (process.platform !== 'darwin') throw new Error('Для PDF установите pdftotext (Poppler) и добавьте его в PATH.');
    try {
      return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', PDFKIT_SCRIPT, path], options));
    } catch {
      throw new Error('Не удалось прочитать PDF через PDFKit. Проверьте файл или установите Poppler.');
    }
  }
}

export function indexDocument(filename, pages, isPdf) {
  if (!pages.some(page => page.trim())) {
    throw new Error(isPdf
      ? 'Не найден извлекаемый текст. Для сканированного PDF сначала выполните OCR.'
      : 'Входной документ пуст.');
  }
  if (pages.reduce((length, page) => length + page.length, 0) > MAX_TEXT_LENGTH) {
    throw new Error(`Документ превышает лимит ${MAX_TEXT_LENGTH.toLocaleString('ru-RU')} символов извлечённого текста.`);
  }

  const lines = new Map();
  const blankPages = [];
  for (const [pageIndex, page] of pages.entries()) {
    const pageNumber = pageIndex + 1;
    if (isPdf && !page.trim()) blankPages.push(pageNumber);
    for (const [lineIndex, raw] of page.split(/\r?\n/u).entries()) {
      const text = raw.trim();
      if (!text) continue;
      const number = lineIndex + 1;
      const id = isPdf ? `P${pageNumber}L${number}` : `L${number}`;
      const location = isPdf ? `с. ${pageNumber}, строка ${number}` : `строка ${number}`;
      lines.set(id, { id, text, location });
    }
  }

  const firstLine = lines.values().next().value.text;
  const title = /^#\s+(.+)$/u.exec(firstLine)?.[1] ?? (isPdf ? firstLine : filename);
  return { title, filename, lines, blankPages };
}

export function readDocument(path) {
  const extension = extname(path).toLowerCase();
  const isPdf = extension === '.pdf';
  if (!isPdf && !['.md', '.markdown', '.txt'].includes(extension)) {
    throw new Error('Поддерживаемые форматы — PDF, Markdown (.md, .markdown) и TXT.');
  }
  const pages = isPdf ? extractPdfPages(path) : [readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')];
  return indexDocument(basename(path), pages, isPdf);
}
