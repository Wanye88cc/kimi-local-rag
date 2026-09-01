/**
 * Local embedding via Transformers.js (ONNX). The model is downloaded once
 * into a shared model cache, then runs fully offline. The pipeline is lazily
 * created and reused for the lifetime of the process (the MCP server and the
 * daemon are long-lived, so embedding stays warm).
 */
let extractorPromise = null;
let loadedModel = null;
let loadError = null; // cached failure: don't pay a network timeout per query

export async function getEmbedder(config, modelsDir) {
  if (loadError) throw loadError;
  if (extractorPromise && loadedModel === config.model) return extractorPromise;
  loadedModel = config.model;
  extractorPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = modelsDir;
    if (process.env.HF_ENDPOINT) env.remoteHost = process.env.HF_ENDPOINT;
    return pipeline('feature-extraction', config.model, { dtype: config.dtype || 'q8' });
  })();
  try {
    return await extractorPromise;
  } catch (err) {
    loadError = err; // fail fast for the rest of this process's lifetime
    extractorPromise = null;
    throw err;
  }
}

/**
 * @param {string[]} texts
 * @param {object} config
 * @param {string} modelsDir
 * @param {{isQuery?: boolean}} opts
 * @returns {Promise<Float32Array[]>}
 */
export async function embed(texts, config, modelsDir, { isQuery = false } = {}) {
  const ex = await getEmbedder(config, modelsDir);
  const prefix = (isQuery ? config.queryPrefix : config.passagePrefix) || '';
  const input = prefix ? texts.map((t) => prefix + t) : texts;
  const out = await ex(input, { pooling: 'mean', normalize: true });
  const [n, dim] = out.dims;
  const data = out.data;
  const vecs = [];
  for (let i = 0; i < n; i++) vecs.push(new Float32Array(data.buffer, data.byteOffset + i * dim * 4, dim));
  return vecs;
}
