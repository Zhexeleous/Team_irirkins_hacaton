import fs from 'node:fs';
import path from 'node:path';

/**
 * Находит активный файл tasks.md с невыполненными задачами (- [ ]).
 */
function findActiveChange(rootDir) {
  const changesDir = path.join(rootDir, 'openspec', 'changes');
  if (!fs.existsSync(changesDir)) return null;

  const entries = fs.readdirSync(changesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;
    const changeDir = path.join(changesDir, entry.name);
    const tasksPath = path.join(changeDir, 'tasks.md');
    if (!fs.existsSync(tasksPath)) continue;

    const content = fs.readFileSync(tasksPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const openTaskLine = lines.find((l) => /^\s*-\s*\[\s\]\s+/.test(l));
    if (openTaskLine) {
      return {
        changeName: entry.name,
        changeDir,
        tasksPath,
        currentTask: openTaskLine.replace(/^\s*-\s*\[\s\]\s+/, '').trim(),
        tasksContent: content,
      };
    }
  }
  return null;
}

/**
 * Извлекает ключевые слова и пути файлов из текста текущей задачи.
 */
function extractKeywordsAndPaths(taskText) {
  const filePaths = [];
  const pathRegex = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+/g;
  let m;
  while ((m = pathRegex.exec(taskText)) !== null) {
    filePaths.push(m[0]);
  }

  const stopWords = new Set([
    'add', 'create', 'update', 'fix', 'implement', 'write', 'test', 'tests',
    'file', 'files', 'for', 'the', 'and', 'with', 'from', 'into', 'that',
    'добавить', 'создать', 'обновить', 'реализовать', 'написать', 'тесты', 'файл'
  ]);

  const tokens = taskText
    .toLowerCase()
    .replace(/[`'"()[\]{}:;,]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w));

  return {
    filePaths: [...new Set(filePaths)],
    keywords: [...new Set(tokens)],
  };
}

/**
 * Нарезает Markdown-документ (design.md или specs) по заголовкам,
 * оставляя якорные секции и разделы, совпадающие по словам/путям с задачей.
 */
function sliceMarkdownByRelevance(mdContent, keywords, filePaths, minLengthFallback = 350) {
  if (!mdContent || !mdContent.trim()) return '';

  const sections = [];
  const lines = mdContent.split(/\r?\n/);
  let currentHeader = '# Overview';
  let buffer = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (buffer.length > 0) {
        sections.push({ header: currentHeader, body: buffer.join('\n').trim() });
      }
      currentHeader = line;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) {
    sections.push({ header: currentHeader, body: buffer.join('\n').trim() });
  }

  const anchorPattern = /(overview|architecture|data\s*model|schema|types|contract|обзор|архитектура|модел)/i;

  const selected = sections.filter((sec) => {
    const fullText = `${sec.header}\n${sec.body}`.toLowerCase();
    if (anchorPattern.test(sec.header)) return true;
    if (filePaths.some((p) => fullText.includes(p.toLowerCase()))) return true;
    return keywords.some((kw) => fullText.includes(kw));
  });

  const slicedText = selected
    .map((s) => `${s.header}\n${s.body}`)
    .join('\n\n')
    .trim();

  // ЗАЩИТА (Fallback): если совпадений слишком мало, отдаём полный документ, чтобы не потерять контекст
  if (slicedText.length < minLengthFallback) {
    return mdContent.trim();
  }
  return slicedText;
}

/**
 * Извлекает публичные сигнатуры (классы, функции, экспорты) из файлов,
 * созданных в предыдущих задачах.
 */
function extractCodeSignatures(rootDir, relFilePaths) {
  const blocks = [];
  const sigRegex = /^\s*(export\s+)?(async\s+)?(def|class|function|interface|type|const\s+\w+\s*=\s*(?:async\s*)?\()/;

  for (const relPath of relFilePaths) {
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
    // Пропускаем файлы внутри openspec и бинарники
    if (relPath.startsWith('openspec/') || relPath.endsWith('.json')) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const sigLines = content
        .split(/\r?\n/)
        .filter((line) => sigRegex.test(line))
        .slice(0, 40);

      if (sigLines.length > 0) {
        blocks.push(`### ${relPath}\n\`\`\`\n${sigLines.join('\n')}\n\`\`\``);
      }
    } catch {
      // Игнорируем нечитаемые файлы
    }
  }
  return blocks.join('\n\n');
}

/**
 * Собирает компактный срез контекста в .sdd-opt/current-slice.md.
 */
function buildContextSlice(rootDir) {
  const active = findActiveChange(rootDir);
  if (!active) return null;

  const { changeName, changeDir, currentTask, tasksContent } = active;
  const { filePaths, keywords } = extractKeywordsAndPaths(currentTask);

  // 1. Сжатый контракт из proposal.md (первые ~25 строк сути)
  const proposalPath = path.join(changeDir, 'proposal.md');
  let proposalSummary = '';
  if (fs.existsSync(proposalPath)) {
    proposalSummary = fs
      .readFileSync(proposalPath, 'utf-8')
      .split(/\r?\n/)
      .slice(0, 25)
      .join('\n')
      .trim();
  }

  // 2. Релевантный срез design.md
  const designPath = path.join(changeDir, 'design.md');
  let designSlice = '';
  if (fs.existsSync(designPath)) {
    designSlice = sliceMarkdownByRelevance(
      fs.readFileSync(designPath, 'utf-8'),
      keywords,
      filePaths
    );
  }

  // 3. Релевантный срез specs/
  const specsDir = path.join(changeDir, 'specs');
  const specSlices = [];
  if (fs.existsSync(specsDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) {
          const sliced = sliceMarkdownByRelevance(
            fs.readFileSync(full, 'utf-8'),
            keywords,
            filePaths,
            200
          );
          if (sliced) specSlices.push(sliced);
        }
      }
    };
    walk(specsDir);
  }

  // 4. Handoff от прошлых задач + сигнатуры созданных файлов
  const handoffPath = path.join(rootDir, '.sdd-opt', 'handoff.md');
  let handoffText = '';
  let signaturesText = '';
  if (fs.existsSync(handoffPath)) {
    handoffText = fs.readFileSync(handoffPath, 'utf-8').trim();
    const { filePaths: prevFiles } = extractKeywordsAndPaths(handoffText);
    signaturesText = extractCodeSignatures(rootDir, prevFiles);
  }

  // 5. Только 1 текущая строка из tasks.md (вместо всего списка задач)
  const sliceSections = [
    `# SDD Context Slice: ${changeName}`,
    `## Текущая задача (выполнить ТОЛЬКО её)\n- [ ] ${currentTask}`,
  ];

  if (proposalSummary) {
    sliceSections.push(`## Краткий контекст фичи (proposal)\n${proposalSummary}`);
  }
  if (handoffText) {
    sliceSections.push(`## Итоги предыдущих задач (Handoff)\n${handoffText}`);
  }
  if (signaturesText) {
    sliceSections.push(`## Сигнатуры модулей из прошлых задач\n${signaturesText}`);
  }
  if (designSlice) {
    sliceSections.push(`## Релевантная архитектура (design slice)\n${designSlice}`);
  }
  if (specSlices.length > 0) {
    sliceSections.push(`## Релевантные требования (specs slice)\n${specSlices.join('\n\n')}`);
  }

  sliceSections.push(
    `> Примечание: это оптимизированный срез. Если для выполнения задачи не хватает деталей из другого файла проекта или полного раздела спеки — точечно прочитай нужный файл через read.`
  );

  const stateDir = path.join(rootDir, '.sdd-opt');
  fs.mkdirSync(stateDir, { recursive: true });
  const slicePath = path.join(stateDir, 'current-slice.md');
  fs.writeFileSync(slicePath, sliceSections.join('\n\n---\n\n'), 'utf-8');

  return {
    slicePath,
    relSlicePath: '.sdd-opt/current-slice.md',
    designSlice,
    currentTask,
    tasksContent,
  };
}

export const SddContextSlicerPlugin = async ({ directory }) => {
  const rootDir = directory || process.cwd();
  let cachedSlice = null;

  const ensureSlice = () => {
    if (!cachedSlice) {
      cachedSlice = buildContextSlice(rootDir);
    }
    return cachedSlice;
  };

  return {
    // 1. Генерируем срез при старте сессии
    'session.created': async () => {
      cachedSlice = buildContextSlice(rootDir);
    },

    // 2. Направляем агента сразу в готовый срез .sdd-opt/current-slice.md
    'experimental.chat.system.transform': async (_input, output) => {
      const slice = ensureSlice();
      if (!slice) return;

      const rule = [
        `[SDD CONTEXT SLICER]`,
        `Для текущей задачи подготовлен компактный срез спецификации, сигнатур и handoff в файле: ${slice.relSlicePath}.`,
        `1. Сначала прочитай ${slice.relSlicePath} вместо чтения полных файлов proposal.md, design.md, specs/ и tasks.md.`,
        `2. Не сканируй весь репозиторий без необходимости — опирайся на пути из среза и handoff.`,
        `3. Если в срезе не хватает конкретной детали реализации, точечно дочитай только нужный файл.`,
      ].join('\n');

      if (Array.isArray(output?.system)) {
        output.system.push(rule);
      }
    },

    // 3. Перехватываем попытки прочитать целиком большие design.md или tasks.md и отдаём срез
    'tool.execute.after': async (input, output) => {
      if (input?.tool !== 'read' || typeof output?.output !== 'string') return;

      const targetPath = String(input?.args?.filePath || input?.args?.path || '');
      const slice = ensureSlice();
      if (!slice) return;

      // Если агент читает огромный design.md (> 4000 символов), подменяем на релевантный срез
      if (targetPath.endsWith('design.md') && output.output.length > 4000 && slice.designSlice) {
        output.output =
          `[SDD Context Slicer: показаны только разделы design.md, релевантные текущей задаче]\n\n` +
          slice.designSlice +
          `\n\n[Если нужен полный файл, укажи конкретный диапазон строк offset/limit]`;
      }

      // Если агент читает длинный tasks.md, оставляем только закрытые итоги и текущую задачу
      if (targetPath.endsWith('tasks.md') && output.output.length > 2000) {
        const compactTasks = output.output
          .split(/\r?\n/)
          .filter((line) => /^\s*-\s*\[x\]/i.test(line) || line.includes(slice.currentTask))
          .join('\n');

        if (compactTasks.trim()) {
          output.output =
            `[SDD Context Slicer: показаны только выполненные задачи и текущая задача]\n\n` +
            compactTasks;
        }
      }
    },
  };
};