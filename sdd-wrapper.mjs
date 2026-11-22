#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const toolRootDir = path.dirname(fileURLToPath(import.meta.url));
const targetProjectDir = process.cwd();

const rawArgs = process.argv.slice(2);
const isBaseline = rawArgs.includes('--baseline');

const runnerScript = path.join(toolRootDir, 'plugin', 'isolation', 'sdd-runner.mjs');
const testPluginSrc = path.join(toolRootDir, 'plugin', 'test-logs', 'index.js');

const opencodeDir = path.join(targetProjectDir, '.opencode');
const opencodePluginsDir = path.join(opencodeDir, 'plugins');
const tempPluginDst = path.join(opencodePluginsDir, 'sdd-test-log-summary.js');

if (!fs.existsSync(runnerScript)) {
  console.error(`[ERROR] Не найден оркестратор по пути: ${runnerScript}`);
  process.exit(1);
}

let pluginInstalled = false;
const opencodeDirExisted = fs.existsSync(opencodeDir);
const pluginsDirExisted = fs.existsSync(opencodePluginsDir);

function cleanup() {
  if (pluginInstalled && fs.existsSync(tempPluginDst)) {
    fs.unlinkSync(tempPluginDst);
  }
  if (!pluginsDirExisted && fs.existsSync(opencodePluginsDir)) {
    try { fs.rmdirSync(opencodePluginsDir); } catch {}
  }
  if (!opencodeDirExisted && fs.existsSync(opencodeDir)) {
    try { fs.rmdirSync(opencodeDir); } catch {}
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

if (!isBaseline) {
  if (!fs.existsSync(testPluginSrc)) {
    console.error(`[ERROR] Не найден плагин тестов по пути: ${testPluginSrc}`);
    process.exit(1);
  }
  fs.mkdirSync(opencodePluginsDir, { recursive: true });
  fs.copyFileSync(testPluginSrc, tempPluginDst);
  pluginInstalled = true;
  console.log('[WRAPPER] Режим: OPTIMIZED (plugin/isolation + plugin/test-logs)');
} else {
  console.log('[WRAPPER] Режим: BASELINE (Без оптимизаций)');
}

try {
  const result = spawnSync(process.execPath, [runnerScript, ...rawArgs], {
    cwd: targetProjectDir,
    env: process.env,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 0;
} finally {
  cleanup();
}