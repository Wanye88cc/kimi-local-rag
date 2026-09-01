import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { depsInstalled, ensureDeps } from './core/bootstrap.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// The MCP SDK itself lives in node_modules, so without dependencies we cannot
// serve at all. Trigger the background bootstrap and exit cleanly — the hooks
// do the same, and the server becomes available after the install finishes
// (next session or /reload).
if (!depsInstalled(PLUGIN_ROOT)) {
  ensureDeps(PLUGIN_ROOT);
  process.exit(0);
}

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');
const { RagStore, resolveStoreDir } = await import('./core/store.mjs');
const { indexPaths, refresh } = await import('./core/indexer.mjs');
const { search } = await import('./core/search.mjs');
const { loadConfig, setConfigValue } = await import('./core/config.mjs');

const server = new McpServer({ name: 'kimi-local-rag', version: '0.1.1' });

const dirParam = z
  .string()
  .optional()
  .describe('Absolute project directory (or rag store dir). Defaults to auto-resolution: $KIMI_RAG_DIR, walk-up from cwd, then the most recently used project store, then the global store.');

function openStoreFor(dir, forWrite = false) {
  const storeDir = resolveStoreDir({ dir, forWrite });
  const store = new RagStore(storeDir);
  store.reloadConfig();
  return store;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));

server.registerTool(
  'rag_index',
  {
    description:
      'Index a local file or directory into the hybrid BM25+vector store (idempotent, content-hash based). The path is remembered for future refresh/rebuild. Runs fully offline after the one-time embedding model download.',
    inputSchema: { path: z.string().describe('File or directory to index'), dir: dirParam },
  },
  async ({ path: target, dir }) => {
    const store = openStoreFor(dir, true);
    try {
      const abs = path.resolve(dir || '.', target);
      if (!store.config.trackedPaths.includes(abs)) {
        store.config.trackedPaths.push(abs);
        setConfigValue(store.dir, 'trackedPaths', store.config.trackedPaths);
      }
      const stats = await indexPaths(store, [abs]);
      return json({ ...stats, store: store.dir });
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_query',
  {
    description:
      'Hybrid BM25 + vector search over the local index. Results are evidence-gated: an empty result means the index contains nothing sufficiently relevant — do not retry the same query with synonyms more than once.',
    inputSchema: {
      query: z.string(),
      topK: z.number().int().min(1).max(20).optional(),
      dir: dirParam,
    },
  },
  async ({ query, topK, dir }) => {
    const store = openStoreFor(dir);
    try {
      const out = await search(store, query, { topK });
      return json({
        reason: out.reason,
        results: out.results.map((r) => ({
          path: r.path,
          lines: `${r.startLine}-${r.endLine}`,
          score: Number(r.score.toFixed(3)),
          cosine: r.cosine == null ? null : Number(r.cosine.toFixed(3)),
          coverage: Number(r.coverage.toFixed(2)),
          identifierHits: r.identifierHits,
          preview: r.text.slice(0, 1200),
        })),
      });
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_status',
  {
    description: 'Show index stats, storage location/scope, tracked paths, excludes and the active relevance-gate configuration.',
    inputSchema: { dir: dirParam },
  },
  async ({ dir }) => {
    const store = openStoreFor(dir);
    try {
      const s = store.stats();
      const cfg = store.config;
      return json({
        store: store.dir,
        ...s,
        injection: {
          enabled: cfg.ragEnabled, topK: cfg.topK, maxInjectTokens: cfg.maxInjectTokens,
          cosineFloor: cfg.cosineFloor, minTokenCoverage: cfg.minTokenCoverage,
          relativeThreshold: cfg.relativeThreshold,
        },
        trackedPaths: cfg.trackedPaths,
        excludePatterns: cfg.excludePatterns,
      });
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_refresh',
  {
    description: 'Incrementally re-index all tracked paths: new/changed files are embedded, deleted files are dropped.',
    inputSchema: { dir: dirParam },
  },
  async ({ dir }) => {
    const store = openStoreFor(dir);
    try {
      return json(await refresh(store));
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_rebuild',
  {
    description: 'Re-embed every tracked path. Use force=true to wipe the index first (required after changing the embedding model).',
    inputSchema: { force: z.boolean().optional(), dir: dirParam },
  },
  async ({ force, dir }) => {
    const store = openStoreFor(dir, true);
    try {
      if (force) {
        store.clearAll();
        store.setMeta('vec_dim', '');
        store.setMeta('model', '');
      }
      return json(await indexPaths(store, store.config.trackedPaths, { force: true }));
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_clear',
  {
    description: 'Wipe the entire index. Tracked paths and config are preserved.',
    inputSchema: { dir: dirParam },
  },
  async ({ dir }) => {
    const store = openStoreFor(dir);
    try {
      store.clearAll();
      return text('Index cleared.');
    } finally {
      store.close();
    }
  }
);

server.registerTool(
  'rag_exclude',
  {
    description: 'Manage gitignore-style exclude patterns (e.g. "dist/", "*.log"). Pass no pattern to list, remove=true to delete one.',
    inputSchema: {
      pattern: z.string().optional(),
      remove: z.boolean().optional(),
      dir: dirParam,
    },
  },
  async ({ pattern, remove, dir }) => {
    const storeDir = resolveStoreDir({ dir, forWrite: true });
    const cfg = loadConfig(storeDir);
    if (!pattern) return json(cfg.excludePatterns);
    const set = new Set(cfg.excludePatterns);
    if (remove) set.delete(pattern);
    else set.add(pattern);
    setConfigValue(storeDir, 'excludePatterns', [...set]);
    return text(`${remove ? 'Removed' : 'Added'} exclude: ${pattern} (${set.size} total). Run rag_refresh to apply.`);
  }
);

server.registerTool(
  'rag_config',
  {
    description: 'Get or set retrieval configuration (topK, cosineFloor, minTokenCoverage, relativeThreshold, ragEnabled, model, ...). Pass only key to read, key+value to set.',
    inputSchema: {
      key: z.string().optional(),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
      dir: dirParam,
    },
  },
  async ({ key, value, dir }) => {
    const storeDir = resolveStoreDir({ dir, forWrite: true });
    if (!key) return json(loadConfig(storeDir));
    if (value === undefined) return json({ [key]: loadConfig(storeDir)[key] });
    const cfg = setConfigValue(storeDir, key, value);
    return json({ [key]: cfg[key] });
  }
);

await server.connect(new StdioServerTransport());
