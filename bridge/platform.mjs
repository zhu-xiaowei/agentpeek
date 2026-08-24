import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

export const IS_WINDOWS = process.platform === 'win32';

function executableVariants(candidate) {
  if (!candidate || !IS_WINDOWS || path.extname(candidate)) return candidate ? [candidate] : [];
  return [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`, candidate];
}

export function findExecutable(name, candidates = []) {
  for (const candidate of candidates.flatMap(executableVariants)) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  try {
    const locator = IS_WINDOWS ? ['where.exe', [name]] : ['/bin/sh', ['-lc', `command -v ${name}`]];
    const found = execFileSync(locator[0], locator[1], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).find(Boolean);
    return found?.trim() || null;
  } catch {
    return null;
  }
}

export function executableOptions(binary, options = {}, runtime = {}) {
  const platform = runtime.platform || process.platform;
  const nodeExecutable = runtime.nodeExecutable || process.execPath;
  const env = { ...process.env, ...(options.env || {}) };
  const pathKey = platform === 'win32'
    ? Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path'
    : 'PATH';
  const nodeDirectory = platform === 'win32'
    ? path.win32.dirname(nodeExecutable)
    : path.dirname(nodeExecutable);
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathEntries = (env[pathKey] || '').split(delimiter).filter(Boolean);
  if (nodeDirectory && !pathEntries.includes(nodeDirectory)) {
    env[pathKey] = [nodeDirectory, ...pathEntries].join(delimiter);
  }

  return {
    ...options,
    env,
    shell: options.shell ?? (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)),
  };
}

export function runExecutable(binary, args, options = {}) {
  return execFileSync(binary, args, executableOptions(binary, options));
}

export function spawnExecutable(binary, args, options = {}, spawnFn = spawn, runtime = {}) {
  const platform = runtime.platform || process.platform;
  const spawnOptions = executableOptions(binary, options, runtime);
  const command = platform === 'win32'
    && spawnOptions.shell
    && /\.(?:cmd|bat)$/i.test(binary)
    && /\s/.test(binary)
    ? `"${binary}"`
    : binary;
  return spawnFn(command, args, spawnOptions);
}

export function validateProductionDependencies(cwd) {
  return runExecutable(
    process.execPath,
    [path.join(cwd, 'verify-dependencies.mjs')],
    {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, NODE_PATH: '' },
    },
  );
}

export function installProductionDependencies(cwd) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [
    'ci',
    '--omit=dev',
    '--include=optional',
    '--silent',
    '--no-audit',
    '--no-fund',
  ];
  const npm = fs.existsSync(npmCli)
    ? [process.execPath, [npmCli, ...args]]
    : [findExecutable('npm', [path.join(path.dirname(process.execPath), 'npm')]), args];
  if (!npm[0]) throw new Error('npm not found');
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      runExecutable(npm[0], npm[1], { cwd, stdio: 'ignore' });
      return validateProductionDependencies(cwd);
    } catch (cause) {
      error = cause;
    }
  }
  throw error;
}

export function extractTar(archive, cwd) {
  const windowsTar = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar')
    : '';
  const tar = findExecutable('tar', [windowsTar]);
  if (!tar) throw new Error('tar not found');
  return runExecutable(tar, ['xzf', archive, '-C', cwd], { stdio: 'ignore' });
}
