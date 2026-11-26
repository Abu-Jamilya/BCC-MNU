import { CATALOG_SCHEMA, ITEM_SCHEMA, SET_SCHEMA, InvalidModelOutput, validateShape } from './schema.mjs';

const SOURCE_ID = /^(?:[-*+]\s+)?(?:\*\*|__|`)?([\p{Lu}]{1,12}[-_–]\d+(?:[.\-]\d+)*)[.:\s*`_)]/u;

const EVIDENCE_RULES = `
Для каждого замечания назови конкретную проблему, опиши её последствие для разработки или проверки и предложи, что нужно уточнить. Не делай бизнес-выбор за автора. В line_ids перечисляй идентификаторы релевантных строк, переданных в запросе. Для пробела укажи ближайший пункт, который должен его закрывать, и точно опиши недостающее условие. Для противоречия приведи обе стороны. Одна проблема — одно замечание.
Критический (critical) — нельзя однозначно реализовать или принять важный сценарий. Существенный (major) — проблема влияет на важный сценарий или его проверку, но не создаёт прямой блокировки. Незначительный (minor) — локальная проблема формулировки с ограниченным влиянием. Не повышай серьёзность из-за стиля текста.`;

const CATALOG_PROMPT = `
Составь каталог требований к продукту из документа. Прочитай документ целиком, включая приложения, таблицы и интеграционные контракты. Включи функциональные и нефункциональные требования, обязательные правила для данных и интерфейсов, включая правила без номера. Каждое явно пронумерованное требование включи под одной записью, даже если оно содержит несколько предписаний. Для ненумерованных частей группируй строки, описывающие одно поведение: шаги одной операции, параметры одного запроса, формат одного ответа. Не выделяй отдельно каждый параметр, код ответа, строку JSON, техническую метку или повтор правила. Сохраняй исходные ссылки для всех самостоятельных заявленных ограничений. В summary используй одну фразу до 12 слов.
Сохраняй несовпадающие правила отдельно, даже если они относятся к одному сценарию. Заголовки, шаблоны ревью, описания контекста, иллюстративные примеры и критерии приёмки используй как контекст, если сами они не устанавливают самостоятельное правило. Не дописывай требования за автора.`;

const ITEMS_PROMPT = `
Проверь каждую запись переданной группы каталога. Верни ровно один объект reviews с соответствующим requirement_id на каждую запись; при отсутствии конкретного замечания верни пустой findings для этой записи. Используй исходные строки, а краткое описание — как указатель. Для каждого дефекта выбери главный критерий:
necessity — связь с заявленной потребностью; appropriateness — уместность для уровня спецификации и наличие обоснования для жёстких проектных решений; clarity — одна интерпретация терминов и условий; completeness — хватает условий, действия и результата; atomicity — одно самостоятельное обязательство; feasibility — реализуемость при заданных ограничениях; verifiability — можно задать наблюдаемый тест; correctness — соответствие сформулированной цели и достоверность формулировки; conformance — соблюдение принятого формата и терминологии.
Включай хотя бы одну исходную строку данного требования в каждое его замечание. В title достаточно короткой фразы, в explanation и recommendation — по одному или два коротких предложения. Межраздельные противоречия и полноту набора проверяет отдельный этап. Не считай нормальное ограничение из API-контракта лишней деталью только из-за его технического характера.
${EVIDENCE_RULES}`;

const SET_PROMPT = `
Проверь согласованность и достаточность всего набора. Сопоставь самостоятельные требования, цели, критерии приёмки, примеры и дочерние спецификации. Особое внимание удели общим сценариям, граничным условиям, правилам для данных и интерфейсам между частями документа.
Критерии: consistency — противоречия между правилами, исключениями или критериями приёмки; coverage — пропущенные поведения, зависимости и исходы для заявленных сценариев; set_feasibility — совместная осуществимость требований; comprehensibility — согласованность терминов и понятий в разных частях; validatability — можно подтвердить достижение целей и готовность по критериям приёмки.
Учитывай индивидуальные замечания из предыдущего этапа. Не повторяй их в findings, если сопоставление разделов не выявляет другую, самостоятельную проблему. Выдели прежде всего проблемы, меняющие поведение или проверку продукта. Для каждой проблемы достаточно короткого заголовка и по одному или два предложения с последствием и уточнением. Если на уровне набора проблем не выявлено, верни пустой findings.
${EVIDENCE_RULES}`;

function checkedLines(ids, document, minimum = 1) {
  const unique = [...new Set(ids)];
  if (unique.length < minimum || unique.some(id => !document.lines.has(id))) {
    throw new InvalidModelOutput(`Нужны как минимум ${minimum} различные существующие ссылки на исходные строки.`);
  }
  return unique;
}

function prepareCatalog(data, document) {
  if (!data.requirements.length) throw new InvalidModelOutput('Каталог требований пуст.');
  const sourceOrder = new Map([...document.lines.keys()].map((id, index) => [id, index]));
  const numberedLines = [...document.lines.values()].filter(line => SOURCE_ID.test(`${line.text} `));
  const attachedLineIds = new Set();
  const catalog = data.requirements.map(record => {
    const lineIds = checkedLines(record.line_ids, document)
      .sort((first, second) => sourceOrder.get(first) - sourceOrder.get(second));
    const sourceIds = lineIds.map(id => SOURCE_ID.exec(`${document.lines.get(id).text} `)?.[1]).filter(Boolean);
    if (sourceIds.length > 1) {
      throw new InvalidModelOutput('Разные пронумерованные требования должны быть отдельными записями каталога.');
    }
    lineIds.forEach(id => attachedLineIds.add(id));
    return { summary: record.summary.trim(), line_ids: lineIds, source_id: sourceIds[0] ?? null };
  });

  const missing = numberedLines.filter(line => !attachedLineIds.has(line.id));
  if (missing.length) {
    throw new InvalidModelOutput(`В каталоге пропущены явно пронумерованные пункты (${missing.map(line => line.id).join(', ')}).`);
  }
  const catalogKeys = catalog.map(item => item.source_id
    ? item.line_ids.find(id => SOURCE_ID.test(`${document.lines.get(id).text} `))
    : JSON.stringify([item.line_ids, item.summary]));
  if (new Set(catalogKeys).size !== catalog.length) {
    throw new InvalidModelOutput('В каталоге повторяются записи.');
  }
  return catalog
    .sort((first, second) => sourceOrder.get(first.line_ids[0]) - sourceOrder.get(second.line_ids[0]))
    .map((record, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, ...record }));
}

function prepareItemReviews(data, catalog, document) {
  const reviews = new Map(data.reviews.map(review => [review.requirement_id, review.findings]));
  if (reviews.size !== data.reviews.length || reviews.size !== catalog.length || catalog.some(item => !reviews.has(item.id))) {
    throw new InvalidModelOutput('Нужна одна запись reviews на каждый идентификатор из каталога.');
  }
  for (const item of catalog) {
    for (const finding of reviews.get(item.id)) {
      finding.line_ids = checkedLines(finding.line_ids, document);
      if (!finding.line_ids.some(id => item.line_ids.includes(id))) {
        throw new InvalidModelOutput(`Замечание по ${item.id} должно цитировать строку этого требования.`);
      }
    }
  }
  return reviews;
}

function prepareSetFindings(data, document) {
  return data.findings.map(finding => ({
    ...finding,
    line_ids: checkedLines(finding.line_ids, document, finding.criterion === 'consistency' ? 2 : 1),
  }));
}

async function runStage(model, stage, instruction, input, schema, prepare) {
  const prompt = `${instruction.trim()}\n\nДанные для проверки (JSON):\n${JSON.stringify(input)}`;
  let correction = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await model.generate(stage, `${prompt}${correction}`, schema);
      validateShape(data, schema);
      return prepare(data);
    } catch (error) {
      if (!(error instanceof InvalidModelOutput) || attempt === 1) {
        throw new Error(`${stage}: ${error.message}`, { cause: error });
      }
      correction = `\n\nПовтори этап. Предыдущий ответ отклонён. ${error.message}`;
    }
  }
}

export async function reviewDocument(document, model, onStage = () => {}) {
  const lines = [...document.lines.values()].map(({ id, text }) => [id, text]);
  onStage('Выделение требований');
  const catalog = await runStage(model, 'catalog', CATALOG_PROMPT, { lines }, CATALOG_SCHEMA,
    data => prepareCatalog(data, document));

  const reviews = new Map();
  const batchSize = 20;
  for (let start = 0; start < catalog.length; start += batchSize) {
    const batch = catalog.slice(start, start + batchSize);
    const sourceIds = new Set(batch.flatMap(item => item.line_ids));
    const nearby = lines.filter(([id], index) => sourceIds.has(id)
      || sourceIds.has(lines[index - 1]?.[0]) || sourceIds.has(lines[index + 1]?.[0]));
    onStage(`Проверка отдельных требований (${start + 1}–${start + batch.length} из ${catalog.length})`);
    const results = await runStage(model, 'item_review', ITEMS_PROMPT, { lines: nearby, catalog: batch }, ITEM_SCHEMA,
      data => prepareItemReviews(data, batch, document));
    for (const [id, findings] of results) reviews.set(id, findings);
  }

  onStage('Проверка набора требований');
  const previousFindings = [...reviews].flatMap(([requirement_id, findings]) =>
    findings.map(({ criterion, title, line_ids }) => ({ requirement_id, criterion, title, line_ids })));
  const setFindings = await runStage(model, 'set_review', SET_PROMPT, { lines, catalog, previousFindings }, SET_SCHEMA,
    data => prepareSetFindings(data, document));

  return { catalog, reviews, setFindings };
}
