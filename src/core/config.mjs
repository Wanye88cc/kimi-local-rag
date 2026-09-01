import fs from 'node:fs';
import path from 'node:path';

/**
 * Tunable retrieval configuration. The defaults are deliberately strict:
 * pi-local-rag's linear blend + min-max normalization guarantees that SOME
 * chunk always scores ~1.0, so its 0.1 threshold passes junk. Here, a chunk
 * must present independent evidence (semantic floor OR lexical coverage OR
 * exact identifier hit) before it can be injected at all.
 */
export const DEFAULT_CONFIG = {
  // --- injection ---
  ragEnabled: true,
  topK: 5,                 // hard cap; fewer (or zero) chunks may pass the gate
  maxInjectTokens: 1800,   // total injection budget (~4 chars/token)
  maxChunkChars: 1600,     // per-chunk preview cap in injected output

  // --- relevance gating (the "no loose matches" core) ---
  cosineFloor: 0.32,       // absolute semantic similarity floor
  minTokenCoverage: 0.5,   // fraction of query content terms a chunk must contain (lexical evidence)
  minIdentifierHits: 1,    // exact identifier hits that alone admit a chunk
  relativeThreshold: 0.45, // drop anything scoring below topScore * this

  // --- ranking ---
  rrfK: 60,                // reciprocal-rank-fusion constant
  wIdentifier: 0.25,       // weight per exact identifier hit (capped at 3)
  wCoverage: 0.5,          // weight for lexical token coverage
  wCosine: 0.5,            // weight for cosine similarity
  fileNameBoost: 0.12,     // boost when a query term matches the file name
  maxPerFile: 2,           // diversity: max chunks from one file
  nearDupCosine: 0.92,     // diversity: skip near-duplicate chunks

  // --- indexing ---
  chunkTargetLines: 80,
  chunkMinLines: 25,
  chunkOverlapLines: 8,
  maxFileBytes: 2_000_000,
  staleAfterHours: 24,     // auto-refresh older than this on session start

  // --- embedding ---
  model: 'Xenova/bge-small-en-v1.5',
  dtype: 'q8',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  passagePrefix: '',
  semanticTimeoutMs: 8000, // fall back to lexical-only if the cold model load exceeds this
  // For Chinese-heavy content, try:
  //   model: 'Xenova/multilingual-e5-small', queryPrefix: 'query: ', passagePrefix: 'passage: '

  // --- paths ---
  extraExtensions: [],
  excludeExtensions: [],
  trackedPaths: [],
  excludePatterns: [],
};

export function loadConfig(ragDir) {
  const cfgPath = path.join(ragDir, 'config.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    /* missing or malformed — fall back to defaults */
  }
  return { ...DEFAULT_CONFIG, ...user };
}

export function saveConfig(ragDir, config) {
  fs.mkdirSync(ragDir, { recursive: true });
  fs.writeFileSync(path.join(ragDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

export function setConfigValue(ragDir, key, value) {
  if (!(key in DEFAULT_CONFIG)) {
    const known = Object.keys(DEFAULT_CONFIG).join(', ');
    throw new Error(`Unknown config key "${key}". Known keys: ${known}`);
  }
  const cfg = loadConfig(ragDir);
  // Coerce to the default's type
  const def = DEFAULT_CONFIG[key];
  if (typeof def === 'number') value = Number(value);
  else if (typeof def === 'boolean') value = value === true || value === 'true' || value === '1';
  else if (Array.isArray(def) && !Array.isArray(value)) value = [value];
  cfg[key] = value;
  saveConfig(ragDir, cfg);
  return cfg;
}
