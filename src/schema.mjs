export const ITEM_CRITERIA = {
  necessity: 'Необходимость',
  appropriateness: 'Уместность и свобода реализации',
  clarity: 'Однозначность',
  completeness: 'Полнота формулировки',
  atomicity: 'Атомарность',
  feasibility: 'Осуществимость',
  verifiability: 'Проверяемость',
  correctness: 'Корректность и связь с целью',
  conformance: 'Соответствие формату и терминологии',
};

export const SET_CRITERIA = {
  consistency: 'Непротиворечивость',
  coverage: 'Полнота набора',
  set_feasibility: 'Совместная осуществимость',
  comprehensibility: 'Понятность и согласованность терминологии',
  validatability: 'Согласованность с целями и критериями приёмки',
};

export const SEVERITIES = { critical: 'Критический', major: 'Существенный', minor: 'Незначительный' };
const string = { type: 'string' };
const enumeration = values => ({ type: 'string', enum: values });
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

function issue(criteria) {
  return object({
    criterion: enumeration(Object.keys(criteria)),
    severity: enumeration(Object.keys(SEVERITIES)),
    title: string,
    explanation: string,
    recommendation: string,
    line_ids: array(string),
  });
}

export const CATALOG_SCHEMA = object({ requirements: array(object({ summary: string, line_ids: array(string) })) });
export const ITEM_SCHEMA = object({ reviews: array(object({ requirement_id: string, findings: array(issue(ITEM_CRITERIA)) })) });
export const SET_SCHEMA = object({ findings: array(issue(SET_CRITERIA)) });

export class InvalidModelOutput extends Error {}

export function validateShape(value, schema, path = 'ответ') {
  if (schema.type === 'array' && Array.isArray(value)) {
    value.forEach((item, index) => validateShape(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === schema.required.length && schema.required.every(key => Object.hasOwn(value, key))) {
      for (const key of keys) validateShape(value[key], schema.properties[key], `${path}.${key}`);
      return;
    }
  }
  if (schema.type === 'string' && typeof value === 'string' && value.trim() && (!schema.enum || schema.enum.includes(value))) {
    return;
  }
  throw new InvalidModelOutput(`Несоответствие схеме в поле ${path}.`);
}
