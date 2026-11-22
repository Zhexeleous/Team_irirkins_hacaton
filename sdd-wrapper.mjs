#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const toolRootDir = path.dirname(fileURLToPath(import.meta.url));
const targetProjectDir = process.cwd();

const rawArgs = process.argv.slice(2);
const isBaseline = rawArgs.includes('--baseline');
const noIsolation = isBaseline || rawArgs.includes('--no-isolation');
const noReduction = isBaseline || rawArgs.includes('--no-reduction');
const noTestLogs = isBaseline || rawArgs.includes('--no-test-logs');

const wrapperOnlyFlags = new Set(['--no-isolation', '--no-reduction', '--no-test-logs']);
const runnerArgs = rawArgs.filter((arg) => !wrapperOnlyFlags.has(arg));

if (noIsolation && !runnerArgs.includes('--baseline')) {
  runnerArgs.push('--baseline');
}

const runnerScript = path.join(toolRootDir, 'plugin', 'isolation', 'sdd-runner.mjs');
const reductionPluginSrc = path.join(toolRootDir, 'plugin', 'reduction', 'reduction.js');
const testPluginSrc = path.join(toolRootDir, 'plugin', 'test-logs', 'index.js');

const opencodeDir = path.join(targetProjectDir, '.opencode');
const opencodePluginsDir = path.join(opencodeDir, 'plugins');
const tempReductionPluginDst = path.join(opencodePluginsDir, 'sdd-context-slicer.js');
const tempTestPluginDst = path.join(opencodePluginsDir, 'sdd-test-log-summary.js');

if (!fs.existsSync(runnerScript)) {
  console.error(`[ERROR] Не найден оркестратор по пути: ${runnerScript}`);
  process.exit(1);
}

const installedFiles = [];
const opencodeDirExisted = fs.existsSync(opencodeDir);
const pluginsDirExisted = fs.existsSync(opencodePluginsDir);

function cleanup() {
  for (const dst of installedFiles) {
    if (fs.existsSync(dst)) {
      try { fs.unlinkSync(dst); } catch {}
    }
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

const activeFeatures = [];
if (!noIsolation) activeFeatures.push('isolation');

if (!noReduction) {
  if (!fs.existsSync(reductionPluginSrc)) {
    console.error(`[ERROR] Не найден плагин reduction: ${reductionPluginSrc}`);
    process.exit(1);
  }
  fs.mkdirSync(opencodePluginsDir, { recursive: true });
  fs.copyFileSync(reductionPluginSrc, tempReductionPluginDst);
  installedFiles.push(tempReductionPluginDst);
  activeFeatures.push('reduction');
}

if (!noTestLogs) {
  if (!fs.existsSync(testPluginSrc)) {
    console.error(`[ERROR] Не найден плагин test-logs: ${testPluginSrc}`);
    process.exit(1);
  }
  fs.mkdirSync(opencodePluginsDir, { recursive: true });
  fs.copyFileSync(testPluginSrc, tempTestPluginDst);
  installedFiles.push(tempTestPluginDst);
  activeFeatures.push('test-logs');
}

console.log(
  activeFeatures.length > 0
    ? `[WRAPPER] Активные оптимизации: ${activeFeatures.join(' + ')}`
    : '[WRAPPER] Режим: BASELINE (все оптимизации отключены)'
);

const homeDir = process.env.HOME || '';
const extraPaths = [path.join(homeDir, '.opencode', 'bin'), path.join(homeDir, '.local', 'bin')];
const childEnv = {
  ...process.env,
  PATH: [...extraPaths, process.env.PATH].filter(Boolean).join(path.delimiter),
};

try {
  const result = spawnSync(process.execPath, [runnerScript, ...runnerArgs], {
    cwd: targetProjectDir,
    env: childEnv,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 0;
} finally {
  cleanup();
}