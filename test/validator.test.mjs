import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run } from '../validator.mjs';
import { readDocument, indexDocument } from '../src/document.mjs';
import { createModel } from '../src/model.mjs';
import { reviewDocument } from '../src/review.mjs';

const source = [
  '# Ограничения уведомлений',
  '',
  '* **Ф-1.** Только одно уведомление в месяц.',
  '* **Ф-2.** После смены порога уведомление отправляется снова.',
  '',
  'Сумма хранится в тиынах.',
].join('\n');

const catalog = {
  requirements: [
    { summary: 'Повторное уведомление', line_ids: ['L4'] },
    { summary: 'Лимит уведомлений', line_ids: ['L3'] },
    { summary: 'Единица хранения суммы', line_ids: ['L6'] },
  ],
};
const individual = {
  reviews: ['R001', 'R002', 'R003'].map(requirement_id => ({ requirement_id, findings: [] })),
};
const conflict = {
  criterion: 'consistency',
  severity: 'critical',
  title: 'Повторная отправка после смены порога',
  explanation: 'Правила дают два разных результата в одном месяце.',
  recommendation: 'Определить приоритет правила однократной отправки.',
  line_ids: ['L3', 'L4'],
};

function tempDirectory(context) {
  const path = mkdtempSync(join(tmpdir(), 'bcc-validator-'));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function replaceEnvironment(context, values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  context.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('реальная точка входа обрабатывает --help без ключа', () => {
  const cli = fileURLToPath(new URL('../validator.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--input.*--output/u);
});

test('CLI сохраняет отчёт после трёх ответов Gemini, цитаты берутся из файла', async context => {
  const directory = tempDirectory(context);
  const input = join(directory, 'input.md');
  const output = join(directory, 'output', 'report.md');
  writeFileSync(input, source);
  replaceEnvironment(context, { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only-key', GEMINI_MODEL: 'test-model' });

  const responses = [catalog, individual, { findings: [conflict] }];
  const mockFetch = context.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    assert.equal(request.headers['x-goog-api-key'], 'test-only-key');
    const payload = JSON.parse(request.body);
    assert.equal(payload.generationConfig.responseMimeType, 'application/json');
    assert.match(payload.contents[0].parts[0].text, /Только одно уведомление/u);
    return { ok: true, json: async () => ({ candidates: [{
      content: { parts: [{ text: JSON.stringify(responses.shift()) }] }, finishReason: 'STOP',
    }] }) };
  });

  await run(['--input', input, '--output', output], () => {});
  assert.equal(mockFetch.mock.callCount(), 3);
  const report = readFileSync(output, 'utf8');
  assert.match(report, /R001 \| Ф-1/u);
  assert.match(report, /Сумма хранится в тиынах\./u);
  assert.ok(report.includes('Нарушений — **1**'));
  assert.match(report, /\*\*строка 3\*\*.*Только одно уведомление/u);
  assert.match(report, /\*\*строка 4\*\*.*уведомление отправляется снова/u);
  assert.match(report, /SHA-256 файла \| `[a-f0-9]{64}`/u);
  assert.doesNotMatch(report, /test-only-key/u);
});

test('источник нельзя перезаписать отчётом', async context => {
  const file = join(tempDirectory(context), 'input.md');
  writeFileSync(file, source);
  await assert.rejects(run(['-i', file, '-o', file], () => {}), /должны различаться/u);
  assert.equal(readFileSync(file, 'utf8'), source);
});

test('ответ без обзора одного из требований или с выдуманной строкой отклоняется', async () => {
  const document = indexDocument('input.md', [source], false);
  let itemCalls = 0;
  const incomplete = {
    async generate(stage) {
      if (stage === 'catalog') return catalog;
      itemCalls += 1;
      return { reviews: individual.reviews.slice(0, 2) };
    },
  };
  await assert.rejects(reviewDocument(document, incomplete), /одна запись reviews/u);
  assert.equal(itemCalls, 2);

  const invented = {
    async generate(stage) {
      if (stage === 'catalog') return catalog;
      if (stage === 'item_review') return individual;
      return { findings: [{ ...conflict, line_ids: ['L3', 'L99'] }] };
    },
  };
  await assert.rejects(reviewDocument(document, invented), /существующие ссылки/u);
});

test('OpenAI получает строгую схему и возвращает разобранный JSON', async context => {
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    const body = JSON.parse(request.body);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'catalog');
    assert.equal(body.store, false);
    return { ok: true, json: async () => ({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(catalog) }] }],
    }) };
  });

  const model = createModel({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-only-key' });
  assert.deepEqual(await model.generate('catalog', 'prompt', { type: 'object' }), catalog);
});

function makePdf() {
  const page = contents => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>`;
  const stream = text => {
    const body = `BT /F1 12 Tf 30 250 Td (${text}) Tj ET`;
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page(6),
    page(7),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('First policy'),
    stream('Second policy'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${pdf}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('из двухстраничного PDF извлекается текст с правильным номером страницы', context => {
  if (process.platform !== 'darwin' && spawnSync('pdftotext', ['-v']).error?.code === 'ENOENT') {
    return context.skip('Для этого теста нужен pdftotext.');
  }
  const path = join(tempDirectory(context), 'sample.pdf');
  writeFileSync(path, makePdf(), 'ascii');
  const document = readDocument(path);
  const lines = [...document.lines.values()];
  assert.equal(lines[0].text, 'First policy');
  assert.match(lines[0].id, /^P1L\d+$/u);
  assert.equal(lines[1].text, 'Second policy');
  assert.match(lines[1].id, /^P2L\d+$/u);
});
