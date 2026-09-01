import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RagStore, resolveStoreDir, rememberProjectStore } from '../src/core/store.mjs';
import { search, formatInjection } from '../src/core/search.mjs';
import { queryDaemon, ensureDaemon } from '../src/core/daemon-client.mjs';

/**
 * UserPromptSubmit hook — auto-injection.
 *
 * Reads { prompt, cwd, ... } from stdin, searches the local index and prints
 * a <rag-context> block to stdout, which Kimi Code appends to the context.
 *
 * Relevance philosophy (vs pi-local-rag): if nothing passes the evidence
 * gate, NOTHING is printed. Injecting weak context is worse than injecting
 * none — it wastes tokens and drags the model off-topic.
 *
 * Latency: the warm daemon answers semantically in <100 ms. If the daemon is
 * not running yet, we spawn it and serve a lexical-only (BM25) pass so this
 * turn still completes in ~300 ms.
 */

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function hintOnce(msg) {
  try {
    const marker = path.join(os.tmpdir(), 'kimi-local-rag-hint-shown');
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, String(Date.now()));
    process.stdout.write(msg);
  } catch { /* ignore */ }
}

async function main() {
  // Fail silently & fast when dependencies are missing (hook must never block)
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules', 'better-sqlite3'))) {
    hintOnce('[kimi-local-rag] dependencies missing — run `npm install` in the plugin directory to enable local RAG.\n');
    return;
  }

  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const prompt = payload.prompt || payload.user_prompt || '';
  const cwd = payload.cwd || process.cwd();
  if (!prompt || prompt.trim().length < 8) return;
  if (prompt.trim().startsWith('/')) return; // slash commands are not queries

  const storeDir = resolveStoreDir({ startDir: cwd });
  if (!fs.existsSync(path.join(storeDir, 'rag.db'))) return; // nothing indexed
  rememberProjectStore(cwd, storeDir);

  const store = new RagStore(storeDir);
  store.reloadConfig();
  if (!store.config.ragEnabled) {
    store.close();
    return;
  }

  // Fast path: warm daemon (semantic)
  const viaDaemon = await queryDaemon(storeDir, '/inject', { prompt }, 2500);
  if (viaDaemon) {
    store.close();
    if (viaDaemon.text) process.stdout.write(viaDaemon.text + '\n');
    return;
  }

  // Daemon not running: start it for next time, serve lexical-only now
  ensureDaemon(storeDir);
  const out = await search(store, prompt, { semantic: false });
  const cfg = store.config;
  store.close();
  const textBlock = formatInjection(out.results, cfg);
  if (textBlock) process.stdout.write(textBlock + '\n');
}

main().catch(() => process.exit(0)); // hooks must fail open
