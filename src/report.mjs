import { ITEM_CRITERIA, SET_CRITERIA, SEVERITIES } from './schema.mjs';

function plain(value) {
  return String(value)
    .replace(/\r?\n/gu, ' ')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\|/gu, '&#124;')
    .replace(/[\\`*_[\]~]/gu, '\\$&');
}

function references(document, ids) {
  return ids.map(id => document.lines.get(id).location).join('; ');
}

function renderFinding(output, document, finding, criteria) {
  output.push(
    `<a id="${finding.id}"></a>`,
    '',
    `**${finding.id} · ${plain(finding.title)}**`,
    '',
    `${SEVERITIES[finding.severity]} · ${criteria[finding.criterion]}`,
    '',
    plain(finding.explanation),
    '',
    `**Что уточнить** · ${plain(finding.recommendation)}`,
    '',
    `**Проверка после ответа** · ${plain(finding.acceptance_check)}`,
    '',
    '**Свидетельства в документе**',
    '',
  );
  for (const id of finding.line_ids) {
    const line = document.lines.get(id);
    output.push(`> **${line.location}** · ${plain(line.text)}`, '');
  }
}

export function renderReport(document, model, review, { version, timestamp, fingerprint }) {
  let nextFinding = 1;
  function numberFinding(finding) {
    return { ...finding, id: `D${String(nextFinding++).padStart(3, '0')}` };
  }
  const itemFindings = new Map(review.catalog.map(item => [item.id, review.reviews.get(item.id).map(numberFinding)]));
  const setFindings = review.setFindings.map(numberFinding);
  const findings = [...setFindings, ...[...itemFindings.values()].flat()];
  const prioritized = Object.keys(SEVERITIES).flatMap(severity => findings.filter(finding => finding.severity === severity));
  const critical = prioritized.filter(finding => finding.severity === 'critical');
  const affected = [...itemFindings.values()].filter(items => items.length).length;

  const output = [
    '# Отчёт о проверке требований',
    '',
    '## Паспорт прогона',
    '',
    '| Параметр | Значение |',
    '| --- | --- |',
    `| Документ | ${plain(document.title)} |`,
    `| Файл | ${plain(document.filename)} |`,
    `| SHA-256 файла | \`${fingerprint}\` |`,
    `| Дата и время (UTC) | ${plain(timestamp)} |`,
    `| Провайдер и модель | ${plain(model.provider)} · ${plain(model.name)} |`,
    `| Версия агента | \`${plain(version)}\` |`,
    '',
  ];
  if (document.blankPages.length) {
    output.push(`Из PDF не извлечён текст на страницах ${document.blankPages.join(', ')}. Полнота прогона зависит от того, есть ли на этих страницах требования.`, '');
  }

  if (prioritized.length) {
    output.push('## Первые вопросы владельцу продукта', '',
      'До планирования затронутых сценариев команда может начать с этих вопросов.', '');
    for (const finding of prioritized.slice(0, 3)) {
      output.push(`- [${finding.id}](#${finding.id}) · ${plain(finding.recommendation)} (${references(document, finding.line_ids)}).`);
    }
    output.push('');
  }

  output.push(
    '## Каталог требований',
    '',
    '`R…` — идентификаторы агента. Для ненумерованных требований приведены исходные цитаты. В PDF номера строк относятся к извлечённому тексту в пределах страницы.',
    '',
    '| ID отчёта | ID в документе | Краткая формулировка | Источник | Цитата для пункта без ID |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const item of review.catalog) {
    const quote = item.source_id ? '—' : item.line_ids.map(id => plain(document.lines.get(id).text)).join(' / ');
    output.push(`| ${item.id} | ${plain(item.source_id ?? '—')} | ${plain(item.summary)} | ${references(document, item.line_ids)} | ${quote} |`);
  }
  output.push('', '## Проверка отдельных требований', '');
  for (const item of review.catalog) {
    const items = itemFindings.get(item.id);
    output.push(`### ${item.id} · ${plain(item.summary)}`, '', `Источник · ${references(document, item.line_ids)}`, '');
    if (!items.length) output.push('В ходе прогона замечаний не выявлено.', '');
    for (const finding of items) renderFinding(output, document, finding, ITEM_CRITERIA);
  }

  output.push('## Проверка набора требований', '');
  if (!setFindings.length) output.push('В ходе прогона замечаний к набору не выявлено.', '');
  for (const finding of setFindings) renderFinding(output, document, finding, SET_CRITERIA);

  output.push(
    '## Сводка',
    '',
    `- Требований в каталоге — **${review.catalog.length}**.`,
    `- Требований с индивидуальными замечаниями — **${affected}**.`,
    `- Нарушений — **${findings.length}** (${findings.length - setFindings.length} в отдельных требованиях, ${setFindings.length} на уровне набора).`,
    ...Object.entries(SEVERITIES).map(([severity, label]) =>
      `- ${label} уровень — **${findings.filter(finding => finding.severity === severity).length}**.`),
    '',
    '### Критические дефекты',
    '',
  );
  if (!critical.length) output.push('В ходе прогона критические дефекты не выявлены.', '');
  for (const finding of critical) {
    output.push(`- **${finding.id}** · ${plain(finding.title)} (${references(document, finding.line_ids)}).`);
  }

  output.push('', '## Итог и приоритет исправлений', '');
  if (critical.length) {
    output.push(
      '**Разработка** · полную реализацию затронутых сценариев следует отложить до устранения критических дефектов.',
      '',
      '**Тестирование** · тест-дизайн по однозначным сценариям можно начать. Приёмка затронутых сценариев требует уточнения ожидаемого поведения.',
      '',
    );
  } else if (document.blankPages.length) {
    output.push('**Разработка и тестирование** · готовность всего документа можно оценить после проверки страниц без извлечённого текста.', '');
  } else if (findings.some(finding => finding.severity === 'major')) {
    output.push('**Разработка и тестирование** · можно начать по однозначным сценариям. Существенные замечания по затронутым сценариям следует уточнить до их реализации и приёмки.', '');
  } else {
    output.push('**Разработка и тестирование** · по результатам прогона можно начинать работу по этому документу.', '');
  }

  if (!prioritized.length) output.push('Обязательных исправлений по результатам прогона не выявлено.', '');
  for (const [index, finding] of prioritized.slice(0, Math.max(5, critical.length)).entries()) {
    output.push(`${index + 1}. **${finding.id}** · ${plain(finding.recommendation)} (${references(document, finding.line_ids)}).`);
  }
  return `${output.join('\n').trimEnd()}\n`;
}
