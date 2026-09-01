import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Dependency bootstrap — makes the plugin zero-touch after `/plugins install`.
 *
 * Kimi Code's plugin manager only clones the repo; it never runs npm install.
 * So the first time a hook notices node_modules is missing, we kick off
 * `npm install` ourselves, detached, in the plugin root. A pid lock file
 * prevents concurrent installs; a stale lock (dead pid or >15 min old) is
 * simply replaced on the next attempt.
 */

const LOCK_NAME = '.npm-install-lock';
const STALE_MS = 15 * 60 * 1000;

export function depsInstalled(pluginRoot) {
  return fs.existsSync(path.join(pluginRoot, 'node_modules', 'better-sqlite3'));
}

function lockAlive(lockFile) {
  try {
    const { pid, startedAt } = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!pid || Date.now() - startedAt > STALE_MS) return false;
    try {
      process.kill(pid, 0); // throws if the process is gone
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Returns true if a new install was started, false if already installed or already running. */
export function ensureDeps(pluginRoot) {
  if (depsInstalled(pluginRoot)) return false;
  const lockFile = path.join(pluginRoot, LOCK_NAME);
  if (lockAlive(lockFile)) return false;

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let child;
  try {
    child = spawn(npmCmd, ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: pluginRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    return false; // npm not on PATH — user must install manually
  }
  child.on('error', () => {});
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  } catch { /* ignore */ }
  child.unref();
  return true;
}
