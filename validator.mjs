import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDocument } from './src/document.mjs';
import { createModel } from './src/model.mjs';
import { renderReport } from './src/report.mjs';
import { reviewDocument } from './src/review.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const usage = 'Использование: node validator.mjs --input <документ.pdf|.md|.txt> --output <отчёт.md>';

function getVersion() {
  const archived = '$Format:%H$';
  if (/^[a-f0-9]{40}$/u.test(archived)) return archived;
  if (existsSync(join(projectRoot, '.git'))) {
    try {
      return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--verify', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
      }).trim();
    } catch {
      // A copied checkout may have no accessible Git executable or history.
    }
  }
  const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  return `пакет ${version} (коммит неизвестен)`;
}

function fileFingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeReport(path, content) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function run(argv, log = message => console.error(message)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    log(usage);
    return;
  }
  if (!values.input?.trim() || !values.output?.trim()) throw new Error(usage);

  const input = resolve(values.input);
  const output = resolve(values.output);
  const source = statSync(input);
  if (!source.isFile()) throw new Error('Входной путь должен вести к файлу.');
  const target = statSync(output, { throwIfNoEntry: false });
  if (input === output || (target && target.ino === source.ino && target.dev === source.dev)) {
    throw new Error('Пути входного файла и отчёта должны различаться.');
  }
  if (target && !target.isFile()) throw new Error('Путь отчёта должен вести к файлу.');
  if (!output.toLowerCase().endsWith('.md')) throw new Error('Для отчёта укажите файл с расширением .md.');

  const fingerprint = fileFingerprint(input);
  const document = readDocument(input);
  if (fileFingerprint(input) !== fingerprint) throw new Error('Входной файл изменился во время чтения. Повторите команду.');

  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const model = createModel();
  const timestamp = new Date().toISOString();
  const version = getVersion();
  log(`Модель — ${model.provider} / ${model.name}`);
  const review = await reviewDocument(document, model, log);
  const report = renderReport(document, model, review, { version, timestamp, fingerprint });
  writeReport(output, report);
  log(`Отчёт сохранён в ${output}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(`Ошибка. ${error.message}`);
    process.exitCode = 1;
  }
}
