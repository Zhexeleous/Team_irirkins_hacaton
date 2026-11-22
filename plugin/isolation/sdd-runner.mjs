#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ============================================================================
// 1. ПАРСИНГ АРГУМЕНТОВ И БАЗОВЫЕ ПУТИ
// ============================================================================

const rawArgs = process.argv.slice(2);
const isDryRun = rawArgs.includes('--dry-run');
const isBaseline = rawArgs.includes('--baseline');

const maxTasksIdx = rawArgs.indexOf('--max-tasks');
const maxTasks = maxTasksIdx !== -1 ? Number(rawArgs[maxTasksIdx + 1]) : Infinity;

const modelIdx = rawArgs.indexOf('--model');
const modelName = modelIdx !== -1 ? rawArgs[modelIdx + 1] : null;

const changeIdx = rawArgs.indexOf('--change');
const explicitChangeName = changeIdx !== -1 ? rawArgs[changeIdx + 1] : null;

const booleanFlags = new Set(['--dry-run', '--baseline']);
const valueFlagIndices = new Set();
for (const idx of [maxTasksIdx, modelIdx, changeIdx]) {
  if (idx !== -1) {
    valueFlagIndices.add(idx);
    if (idx + 1 < rawArgs.length) valueFlagIndices.add(idx + 1);
  }
}

// Исходный промпт пользователя сохраняется без изменений
const originalPrompt = rawArgs
  .filter((arg, idx) => !booleanFlags.has(arg) && !valueFlagIndices.has(idx))
  .join(' ')
  .trim();

if (!originalPrompt) {
  console.error('[ERROR] Не передан стартовый промпт.');
  console.error('Использование: node sdd-runner.mjs "<промпт>" [--baseline] [--dry-run] [--max-tasks <N>] [--model <имя>] [--change <id>]');
  process.exit(1);
}

const rootDir = process.cwd();
const changesRootDir = path.join(rootDir, 'openspec', 'changes');
const stateDir = path.join(rootDir, '.sdd-opt');
const logsDir = path.join(stateDir, 'logs');

// Системный протокол изоляции (передаётся в оперативную память через os.tmpdir(), не изменяя файлы проекта)
const RUNTIME_SYSTEM_INSTRUCTIONS = `
# SDD Isolated Execution Protocol
При выполнении задач по спецификации OpenSpec (apply / реализация задач из tasks.md) строго соблюдай следующие правила:
1. СТРОГО ОДНА ЗАДАЧА ЗА СЕССИЮ: Найди в tasks.md самую первую невыполненную задачу (- [ ]) и реализуй ТОЛЬКО её. Категорически запрещено переходить ко второй и последующим задачам в этой сессии.
2. ВНЕШНИЙ КОНТЕКСТ: Если существует файл .sdd-opt/handoff.md, прочитай его перед поиском по репозиторию, чтобы знать, какие файлы уже созданы в прошлых задачах.
3. НЕМЕДЛЕННАЯ ОСТАНОВКА: После проверки и стандартной отметки [x] в tasks.md (не добавляй в tasks.md никаких посторонних комментариев) НЕМЕДЛЕННО ЗАВЕРШИ ОТВЕТ И ВЫЙДИ.
`.trim();

// ============================================================================
// 2. РАБОТА С ЗАДАЧАМИ OPENSPEC И СНИМКАМИ ФАЙЛОВОЙ СИСТЕМЫ
// ============================================================================

/**
 * Разбирает tasks.md и возвращает все задачи, счётчики и первую невыполненную задачу.
 */
function parseTasksState(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tasks = [];
  let nextTask = null;
  let totalTasks = 0;
  let doneTasks = 0;

  const taskRegex = /^(\s*(?:[-*]|\d+(?:\.\d+)*\.)\s*\[)([ xX])(\]\s+)(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(taskRegex);
    if (!match) continue;

    totalTasks++;
    const isDone = match[2].toLowerCase() === 'x';
    const title = match[4].trim();
    const item = { index: totalTasks, isDone, title };
    tasks.push(item);

    if (isDone) {
      doneTasks++;
    } else if (!nextTask) {
      nextTask = item;
    }
  }

  return { tasks, nextTask, totalTasks, doneTasks };
}

/**
 * Находит целевой файл tasks.md в директории openspec/changes/.
 */
function findTargetTasksFile() {
  if (!fs.existsSync(changesRootDir)) return null;

  if (explicitChangeName) {
    const p = path.join(changesRootDir, explicitChangeName, 'tasks.md');
    return fs.existsSync(p) ? { changeName: explicitChangeName, tasksPath: p } : null;
  }

  const entries = fs.readdirSync(changesRootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'archive');

  const candidates = [];
  for (const dir of entries) {
    const p = path.join(changesRootDir, dir.name, 'tasks.md');
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      const state = parseTasksState(content);
      candidates.push({
        changeName: dir.name,
        tasksPath: p,
        hasOpenTasks: Boolean(state.nextTask),
        mtimeMs: fs.statSync(p).mtimeMs,
      });
    }
  }

  if (candidates.length === 0) return null;

  const active = candidates.filter((c) => c.hasOpenTasks);
  if (active.length > 0) {
    active.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return active[0];
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

/**
 * Снимает снимок метаданных файлов рабочей директории (размер и mtime) для отслеживания изменений.
 */
function takeWorkspaceSnapshot(dir, baseDir = dir, map = new Map()) {
  if (!fs.existsSync(dir)) return map;

  const ignoredDirs = new Set([
    '.git', '.sdd-opt', 'node_modules', '.venv', '__pycache__', '.pytest_cache', 'openspec',
  ]);
  const ignoredFiles = new Set(['sdd-runner.mjs', 'sdd-orchestrator.mjs', 'sdd-baseline.mjs']);

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      takeWorkspaceSnapshot(fullPath, baseDir, map);
    } else if (entry.isFile() && !ignoredFiles.has(entry.name)) {
      const stat = fs.statSync(fullPath);
      map.set(relPath, `${stat.size}:${stat.mtimeMs}`);
    }
  }

  return map;
}

/**
 * Вычисляет список изменённых или добавленных файлов между двумя снимками.
 */
function diffSnapshots(beforeMap, afterMap) {
  const changed = [];
  for (const [file, sig] of afterMap.entries()) {
    if (!beforeMap.has(file) || beforeMap.get(file) !== sig) {
      changed.push(file);
    }
  }
  return changed;
}

/**
 * Дописывает строку со списком изменённых файлов во внешний журнал .sdd-opt/handoff.md.
 */
function appendExternalHandoff(handoffPath, taskNumber, taskTitle, changedFiles) {
  const filesList = changedFiles.length > 0 ? changedFiles.join(', ') : 'без изменений в коде';
  const entry = `- Задача #${taskNumber} (${taskTitle}): изменены/созданы файлы -> ${filesList}\n`;
  fs.appendFileSync(handoffPath, entry, 'utf-8');
}

// ============================================================================
// 3. ПОДСЧЁТ ТОКЕНОВ И ПОТОКОВЫЙ ЗАПУСК OPENCODE
// ============================================================================

/**
 * Извлекает общую статистику токенов и пошаговую нагрузку на контекстное окно из JSON-событий.
 */
function extractUsageFromOutput(stdout) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const steps = [];
  let stepIdx = 0;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const usage =
        event.usage ||
        event.tokens ||
        event.part?.tokens ||
        event.info?.tokens ||
        event.data?.usage;

      if (usage && typeof usage === 'object') {
        stepIdx++;
        const inp = Number(usage.input || usage.input_tokens || usage.promptTokens || 0);
        const out = Number(usage.output || usage.output_tokens || usage.completionTokens || 0);
        const cRead = Number(usage.cache_read || usage.cache_read_input_tokens || usage.cache?.read || 0);
        const cWrite = Number(usage.cache_write || usage.cache_creation_input_tokens || usage.cache?.write || 0);

        inputTokens += inp;
        outputTokens += out;
        cacheReadTokens += cRead;
        cacheWriteTokens += cWrite;

        steps.push({
          step: stepIdx,
          inputTokens: inp,
          outputTokens: out,
          cacheReadTokens: cRead,
          cacheWriteTokens: cWrite,
          contextSizeOnStep: inp + cRead + cWrite,
        });
      }
    } catch {
      // Пропускаем не-JSON строки
    }
  }

  return {
    summary: {
      totalSteps: steps.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalAllTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    },
    steps,
  };
}

/**
 * Запускает opencode в потоковом режиме с живым выводом шагов в консоль,
 * закрытым stdin и опциональным контролем закрытия одной задачи (watchTask).
 */
function runOpencodeStreaming(opencodeArgs, childEnv, rawLogStream, labelPrefix, watchTask = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', opencodeArgs, {
      cwd: rootDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'], // Закрываем stdin, чтобы CLI не ждал интерактивного ввода
    });

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let stepCount = 0;
    let forceStopped = false;

    // Таймер пульса каждые 15 секунд для контроля активности процесса
    const heartbeat = setInterval(() => {
      process.stdout.write(`   [${labelPrefix}] ожидание ответа LLM... (шагов выполнено: ${stepCount})\n`);
    }, 15000);

    // Проверка отметки [x] для принудительного сброса сессии после выполнения текущей задачи
    const checkTaskClosedAndStop = () => {
      if (!watchTask || forceStopped) return;
      try {
        const md = fs.readFileSync(watchTask.tasksPath, 'utf-8');
        const st = parseTasksState(md);
        const closed = !st.nextTask || st.nextTask.title !== watchTask.title;
        if (closed) {
          forceStopped = true;
          process.stdout.write(`   [${labelPrefix}] задача отмечена [x], закрываем сессию для сброса контекста.\n`);
          child.kill('SIGTERM');
        }
      } catch {
        // Игнорируем ошибку чтения в момент записи файла
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      rawLogStream.write(text);
      lineBuffer += text;

      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const toolName = ev.part?.tool || ev.tool;
          const filePath =
            ev.part?.state?.input?.filePath ||
            ev.part?.state?.input?.path ||
            ev.part?.state?.input?.command;

          if (toolName) {
            stepCount++;
            const detail = filePath ? ` (${String(filePath).replace(/\s+/g, ' ').slice(0, 65)})` : '';
            process.stdout.write(`   [Шаг ${stepCount}: ${toolName}]${detail}\n`);
          }

          if (ev.type === 'step_finish' || ev.part?.type === 'step-finish') {
            checkTaskClosedAndStop();
          }
        } catch {
          // Игнорируем не-JSON строки
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      rawLogStream.write(text);
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(heartbeat);
      resolve({ status: code, stdout, stderr, stepCount });
    });
  });
}

// ============================================================================
// 4. РЕЖИМ BASELINE (--baseline): ОДНО СПЛОШНОЕ КОНТЕКСТНОЕ ОКНО
// ============================================================================

/**
 * Выполняет весь промпт в одной непрерывной сессии OpenCode без сброса окна и правил изоляции.
 */
async function runBaselineMode(target) {
  const changeName = target ? target.changeName : 'unknown-change';
  const tasksPath = target ? target.tasksPath : null;

  const metricsPath = path.join(stateDir, `baseline-metrics-${changeName}.json`);
  const rawLogFile = path.join(logsDir, `${changeName}-baseline-full.jsonl`);

  if (isDryRun) {
    console.log('==================================================');
    console.log(`[DRY-RUN | BASELINE] Проверка запуска без оптимизаций (0 токенов)`);
    console.log(`Изменение: ${changeName}`);
    if (tasksPath) {
      const { totalTasks, doneTasks } = parseTasksState(fs.readFileSync(tasksPath, 'utf-8'));
      console.log(`Задач в списке: ${doneTasks}/${totalTasks} выполнено`);
    }
    console.log(`Промпт (одна сплошная сессия): "${originalPrompt}"`);
    console.log('==================================================');
    return;
  }

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Только авто-разрешение инструментов, без правил изоляции и сброса сессии
  const childEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { '*': 'allow' },
    }),
  };

  console.log('==================================================');
  console.log(`[BASELINE] Запуск стандартного прогона (1 сплошное окно на все задачи)`);
  console.log(`Изменение: ${changeName}`);
  if (modelName) console.log(`Модель: ${modelName}`);
  console.log('==================================================');

  const snapshotBefore = takeWorkspaceSnapshot(rootDir);
  const startTime = Date.now();

  const opencodeArgs = ['run', '--format', 'json'];
  if (modelName) {
    opencodeArgs.push('--model', modelName);
  }
  opencodeArgs.push(originalPrompt);

  const rawLogStream = fs.createWriteStream(rawLogFile, { flags: 'w' });

  let result;
  try {
    result = await runOpencodeStreaming(opencodeArgs, childEnv, rawLogStream, 'BASELINE');
  } catch (err) {
    rawLogStream.end();
    console.error('[ERROR] Ошибка запуска opencode:', err.message);
    process.exit(1);
  }
  rawLogStream.end();

  const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(1));
  const snapshotAfter = takeWorkspaceSnapshot(rootDir);
  const changedFiles = diffSnapshots(snapshotBefore, snapshotAfter);

  let tasksAfter = null;
  if (tasksPath && fs.existsSync(tasksPath)) {
    const st = parseTasksState(fs.readFileSync(tasksPath, 'utf-8'));
    tasksAfter = { doneTasks: st.doneTasks, totalTasks: st.totalTasks };
  }

  const usageData = extractUsageFromOutput(result.stdout || '');

  const report = {
    mode: 'baseline (single continuous context window)',
    changeName,
    model: modelName || 'default',
    originalPrompt,
    durationSec,
    tasksCompleted: tasksAfter,
    changedFiles,
    usage: usageData.summary,
    stepsBreakdown: usageData.steps,
  };

  fs.writeFileSync(metricsPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n==================================================');
  console.log(`[BASELINE] Завершено за ${durationSec}с | Шагов LLM: ${usageData.summary.totalSteps}`);
  console.log(
    `Токены -> in: ${usageData.summary.inputTokens}, out: ${usageData.summary.outputTokens}, cache_read: ${usageData.summary.cacheReadTokens}, cache_write: ${usageData.summary.cacheWriteTokens}`
  );
  console.log(`Полный лог: ${rawLogFile}`);
  console.log(`Метрики (включая рост контекста по шагам): ${metricsPath}`);
  console.log('==================================================');
}

// ============================================================================
// 5. РЕЖИМ OPTIMIZED (ПО УМОЛЧАНИЮ): 1 ЗАДАЧА = 1 ЧИСТОЕ КОНТЕКСТНОЕ ОКНО
// ============================================================================

/**
 * Выполняет задачи последовательно: каждая открытая задача (- [ ]) запускается
 * в изолированной сессии OpenCode с передачей состояния через .sdd-opt/handoff.md.
 */
async function runOptimizedMode(target) {
  if (!target) {
    console.error('[ERROR] Не найден файл openspec/changes/*/tasks.md');
    process.exit(1);
  }

  const { changeName, tasksPath } = target;
  const metricsPath = path.join(stateDir, `metrics-${changeName}.json`);
  const handoffPath = path.join(stateDir, 'handoff.md');

  if (isDryRun) {
    const md = fs.readFileSync(tasksPath, 'utf-8');
    const { tasks, nextTask, totalTasks, doneTasks } = parseTasksState(md);

    console.log('==================================================');
    console.log(`[DRY-RUN | OPTIMIZED] Проверка разбиения задач (0 токенов)`);
    console.log(`Изменение: ${changeName} (${path.relative(rootDir, tasksPath)})`);
    console.log(`Прогресс: ${doneTasks}/${totalTasks} выполнено`);
    console.log('==================================================\n');

    for (const t of tasks) {
      const icon = t.isDone ? '[x]' : (nextTask && t.index === nextTask.index ? '[>] (СЛЕДУЮЩАЯ)' : '[ ]');
      console.log(`${icon} Задача #${t.index}: ${t.title}`);
    }

    console.log('\n--------------------------------------------------');
    console.log('Исходный промпт (передаётся БЕЗ ИЗМЕНЕНИЙ):');
    console.log(`"${originalPrompt}"`);
    console.log('--------------------------------------------------');
    return;
  }

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const tmpGuardPath = path.join(os.tmpdir(), `sdd-guard-${process.pid}.md`);
  fs.writeFileSync(tmpGuardPath, RUNTIME_SYSTEM_INSTRUCTIONS, 'utf-8');

  const cleanupTmp = () => {
    if (fs.existsSync(tmpGuardPath)) fs.unlinkSync(tmpGuardPath);
  };
  process.on('exit', cleanupTmp);
  process.on('SIGINT', () => {
    cleanupTmp();
    process.exit(130);
  });

  // Передаём системный протокол изоляции через временный файл и разрешаем инструменты без вопросов
  const childEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      instructions: [tmpGuardPath],
      permission: { '*': 'allow' },
    }),
  };

  const runLog = {
    mode: 'optimized (isolated context window per task)',
    changeName,
    model: modelName || 'default',
    originalPrompt,
    startedAt: new Date().toISOString(),
    totals: {
      durationSec: 0,
      totalSteps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalAllTokens: 0,
    },
    tasks: [],
  };

  let executedInThisRun = 0;

  while (executedInThisRun < maxTasks) {
    const currentMarkdown = fs.readFileSync(tasksPath, 'utf-8');
    const { nextTask, totalTasks, doneTasks } = parseTasksState(currentMarkdown);

    if (!nextTask) {
      console.log(`\n[COMPLETE] Все задачи выполнены (${doneTasks}/${totalTasks})!`);
      break;
    }

    executedInThisRun++;
    const currentTaskNum = doneTasks + 1;

    console.log(`\n==================================================`);
    console.log(`[Сессия #${executedInThisRun} | Задача ${currentTaskNum}/${totalTasks}] Чистое контекстное окно:`);
    console.log(`   "${nextTask.title}"`);
    if (modelName) console.log(`   Модель: ${modelName}`);
    console.log(`==================================================`);

    const snapshotBefore = takeWorkspaceSnapshot(rootDir);
    const startTime = Date.now();

    const opencodeArgs = ['run', '--format', 'json'];
    if (modelName) {
      opencodeArgs.push('--model', modelName);
    }
    opencodeArgs.push(originalPrompt);

    const rawLogFile = path.join(logsDir, `${changeName}-task-${currentTaskNum}.jsonl`);
    const rawLogStream = fs.createWriteStream(rawLogFile, { flags: 'w' });

    let result;
    try {
      result = await runOpencodeStreaming(
        opencodeArgs,
        childEnv,
        rawLogStream,
        `Задача ${currentTaskNum}/${totalTasks}`,
        { tasksPath, title: nextTask.title }
      );
    } catch (err) {
      rawLogStream.end();
      console.error('[ERROR] Ошибка запуска opencode:', err.message);
      process.exit(1);
    }
    rawLogStream.end();

    const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(1));
    const updatedMarkdown = fs.readFileSync(tasksPath, 'utf-8');
    const afterState = parseTasksState(updatedMarkdown);
    const taskWasClosed = !afterState.nextTask || afterState.nextTask.title !== nextTask.title;

    if (!taskWasClosed) {
      console.error(`\n[WARNING] Агент завершил сессию, но не отметил [x] для задачи: "${nextTask.title}"`);
      console.error(`Подробный лог сессии: ${rawLogFile}`);
      process.exit(1);
    }

    const snapshotAfter = takeWorkspaceSnapshot(rootDir);
    const changedFiles = diffSnapshots(snapshotBefore, snapshotAfter);
    appendExternalHandoff(handoffPath, currentTaskNum, nextTask.title, changedFiles);

    const usageData = extractUsageFromOutput(result.stdout || '');
    const u = usageData.summary;

    runLog.totals.durationSec = Number((runLog.totals.durationSec + durationSec).toFixed(1));
    runLog.totals.totalSteps += u.totalSteps;
    runLog.totals.inputTokens += u.inputTokens;
    runLog.totals.outputTokens += u.outputTokens;
    runLog.totals.cacheReadTokens += u.cacheReadTokens;
    runLog.totals.cacheWriteTokens += u.cacheWriteTokens;
    runLog.totals.totalAllTokens += u.totalAllTokens;

    console.log(
      `[DONE] Готово за ${durationSec}с | Токены -> in: ${u.inputTokens}, out: ${u.outputTokens}, cache_read: ${u.cacheReadTokens}`
    );

    runLog.tasks.push({
      taskNumber: currentTaskNum,
      task: nextTask.title,
      durationSec,
      changedFiles,
      usage: u,
    });

    fs.writeFileSync(metricsPath, JSON.stringify(runLog, null, 2), 'utf-8');
  }

  runLog.finishedAt = new Date().toISOString();
  fs.writeFileSync(metricsPath, JSON.stringify(runLog, null, 2), 'utf-8');

  console.log('\n==================================================');
  console.log(
    `[SUMMARY] Всего времени: ${runLog.totals.durationSec}с | Шагов LLM: ${runLog.totals.totalSteps} | ` +
    `Токены -> in: ${runLog.totals.inputTokens}, out: ${runLog.totals.outputTokens}, cache_read: ${runLog.totals.cacheReadTokens}`
  );
  console.log(`Итоговые метрики сохранены в: ${metricsPath}`);
  console.log('==================================================');
}

// ============================================================================
// 6. ТОЧКА ВХОДА
// ============================================================================

async function main() {
  const target = findTargetTasksFile();
  if (isBaseline) {
    await runBaselineMode(target);
  } else {
    await runOptimizedMode(target);
  }
}

main();