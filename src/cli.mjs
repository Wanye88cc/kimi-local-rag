import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { depsInstalled, ensureDeps } from './core/bootstrap.mjs';

/**
 * CLI — usable by humans (`node src/cli.mjs ...`) and by hooks.
 * Every command accepts `--dir <projectOrRagDir>`.
 */

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!depsInstalled(PLUGIN_ROOT)) {
  const started = ensureDeps(PLUGIN_ROOT);
  console.error(started
    ? 'Dependencies are installing in the background (first run) — retry in a minute.'
    : 'Dependencies are not installed and npm could not be started — run `npm install` in the plugin directory.');
  process.exit(1);
}

// Dynamic imports: a static import of better-sqlite3 would crash before the
// friendly message above ever prints.
const { RagStore, resolveStoreDir } = await import('./core/store.mjs');
const { indexPaths, refresh } = await import('./core/indexer.mjs');
const { search } = await import('./core/search.mjs');
const { loadConfig, setConfigValue, DEFAULT_CONFIG } = await import('./core/config.mjs');

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--topK') opts.topK = Number(argv[++i]);
    else if (a === '--remove') opts.remove = true;
    else args.push(a);
  }
  return { args, opts };
}

function open(opts) {
  const dir = resolveStoreDir({ dir: opts.dir });
  return new RagStore(dir);
}

const fmt = (n) => n.toLocaleString('en-US');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { args, opts } = parseArgs(rest);

  switch (cmd) {
    case 'index': {
      const target = args[0] || '.';
      const store = open(opts);
      store.reloadConfig();
      const abs = path.resolve(opts.dir || '.', target);
      if (!store.config.trackedPaths.includes(abs)) {
        store.config.trackedPaths.push(abs);
        setConfigValue(store.dir, 'trackedPaths', store.config.trackedPaths);
      }
      console.error(`Indexing ${abs} ...`);
      const stats = await indexPaths(store, [abs], {
        onProgress: (p) => {
          if (p.done % 25 === 0 || p.done === p.total) {
            console.error(`  ${p.done}/${p.total} ${p.file}`);
          }
        },
      });
      console.log(
        `Indexed ${fmt(stats.indexed)} files (${fmt(stats.chunks)} chunks), ` +
        `${stats.unchanged} unchanged, ${stats.skipped} skipped. Store: ${store.dir}`
      );
      store.close();
      break;
    }

    case 'search': {
      const query = args.join(' ');
      const store = open(opts);
      store.reloadConfig();
      const out = await search(store, query, { topK: opts.topK });
      if (opts.json) {
        console.log(JSON.stringify(out.results.map((r) => ({ ...r, text: undefined, preview: r.text.slice(0, 300) })), null, 2));
      } else if (!out.results.length) {
        console.log(`No results passed the relevance gate (${out.reason}).`);
      } else {
        for (const r of out.results) {
          console.log(`${r.path}:${r.startLine}-${r.endLine}  score=${r.score.toFixed(3)} cos=${r.cosine?.toFixed(3) ?? '-'} cov=${r.coverage.toFixed(2)} ids=${r.identifierHits}`);
          console.log('  ' + r.text.slice(0, 200).replace(/\n/g, '\n  ') + '\n');
        }
      }
      store.close();
      break;
    }

    case 'status': {
      const store = open(opts);
      store.reloadConfig();
      const s = store.stats();
      const cfg = store.config;
      console.log(`kimi-local-rag
  Store:          ${store.dir}
  Files:          ${fmt(s.files)}
  Chunks:         ${fmt(s.chunks)} (${fmt(s.vectors)} vectors)
  Approx tokens:  ${fmt(s.approxTokens)}
  Model:          ${s.model || cfg.model} (dim ${s.vecDim || 'n/a'})
  Last build:     ${s.lastBuild || 'never'}
  Injection:      ${cfg.ragEnabled ? 'enabled' : 'disabled'}  topK=${cfg.topK}  cosineFloor=${cfg.cosineFloor}  minCoverage=${cfg.minTokenCoverage}  relThreshold=${cfg.relativeThreshold}
  Tracked paths:  ${cfg.trackedPaths.length ? cfg.trackedPaths.join(', ') : '(none)'}
  Excludes:       ${cfg.excludePatterns.length ? cfg.excludePatterns.join(', ') : '(none)'}`);
      store.close();
      break;
    }

    case 'refresh': {
      const store = open(opts);
      store.reloadConfig();
      const stats = await refresh(store);
      console.log(`Refreshed: ${stats.indexed} indexed, ${stats.unchanged} unchanged, ${stats.removed} removed.`);
      store.close();
      break;
    }

    case 'rebuild': {
      const store = open(opts);
      store.reloadConfig();
      if (opts.force) {
        store.clearAll();
        store.setMeta('vec_dim', '');
        store.setMeta('model', '');
      }
      const stats = await indexPaths(store, store.config.trackedPaths, { force: true });
      console.log(`Rebuilt: ${stats.indexed} files, ${stats.chunks} chunks.`);
      store.close();
      break;
    }

    case 'clear': {
      const store = open(opts);
      store.clearAll();
      console.log('Index cleared (tracked paths preserved).');
      store.close();
      break;
    }

    case 'exclude': {
      const dir = resolveStoreDir({ dir: opts.dir });
      const cfg = loadConfig(dir);
      const pattern = args[0];
      if (!pattern) {
        console.log(cfg.excludePatterns.length ? cfg.excludePatterns.join('\n') : '(no exclude patterns)');
        break;
      }
      const p = opts.remove ? pattern.replace(/^-/, '') : pattern;
      const set = new Set(cfg.excludePatterns);
      if (opts.remove) set.delete(p);
      else set.add(p);
      setConfigValue(dir, 'excludePatterns', [...set]);
      console.log(`${opts.remove ? 'Removed' : 'Added'} exclude: ${p} (${set.size} total). Run refresh/rebuild to apply.`);
      break;
    }

    case 'config': {
      const dir = resolveStoreDir({ dir: opts.dir });
      const [key, ...val] = args;
      if (!key) {
        console.log(JSON.stringify(loadConfig(dir), null, 2));
        break;
      }
      if (val.length === 0) {
        const cfg = loadConfig(dir);
        console.log(`${key} = ${JSON.stringify(cfg[key])}`);
        break;
      }
      let value = val.join(' ');
      try { value = JSON.parse(value); } catch { /* keep as string */ }
      const cfg = setConfigValue(dir, key, value);
      console.log(`${key} = ${JSON.stringify(cfg[key])}`);
      break;
    }

    default:
      console.log(`kimi-local-rag — local hybrid RAG for Kimi Code

Commands:
  index [path]        Index a file/directory (default: cwd) and track it
  search <query>      Hybrid search [--topK N] [--json]
  status              Index stats, config summary, storage location
  refresh             Incremental re-index of tracked paths
  rebuild [--force]   Re-index everything (--force wipes first)
  clear               Wipe the index (keeps tracked paths)
  exclude [pattern]   Add/list exclude patterns [--remove]
  config [key] [val]  Show or set configuration

Global options: --dir <projectOrRagDir>

Config keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
  }
}

main().catch((err) => {
  console.error(`error: ${err?.message || err}`);
  process.exit(1);
});
