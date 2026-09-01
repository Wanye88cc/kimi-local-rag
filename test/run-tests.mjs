/**
 * Unit tests for the pure ranking logic — no native deps required.
 * Run: node test/run-tests.mjs
 */
import assert from 'node:assert/strict';
import { tokenizeText, tokenizeQuery, tokenCoverage, identifierHits } from '../src/core/tokenizer.mjs';
import { rrfFuse, passesGate, scoreCandidate, relativeCutoff, diversify } from '../src/core/search.mjs';
import { chunkText } from '../src/core/chunker.mjs';

const CFG = {
  rrfK: 60, wIdentifier: 0.25, wCoverage: 0.5, wCosine: 0.5, fileNameBoost: 0.12,
  cosineFloor: 0.32, minTokenCoverage: 0.5, minIdentifierHits: 1,
  relativeThreshold: 0.45, maxPerFile: 2, nearDupCosine: 0.92,
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('tokenizer');
test('splits camelCase identifiers into parts', () => {
  const toks = tokenizeText('verifyStripeWebhook(req)');
  assert.ok(toks.includes('verifystripewebhook'));
  assert.ok(toks.includes('verify'));
  assert.ok(toks.includes('stripe'));
  assert.ok(toks.includes('webhook'));
});
test('splits snake_case and acronyms', () => {
  const toks = tokenizeText('STRIPE_WEBHOOK_SECRET and HTTPSConnection');
  assert.ok(toks.includes('secret'));
  assert.ok(toks.includes('https'));
  assert.ok(toks.includes('connection'));
});
test('query tokenization extracts identifiers and strips stopwords', () => {
  const q = tokenizeQuery('how does the verifyStripeWebhook function work?');
  assert.ok(q.identifiers.includes('verifyStripeWebhook'));
  assert.ok(!q.contentTerms.includes('the'));
  assert.ok(!q.contentTerms.includes('does'));
  assert.ok(q.contentTerms.includes('webhook'));
});
test('coverage and identifier hits', () => {
  const chunk = 'export async function verifyStripeWebhook(req) { const sig = req.headers.get("stripe-signature"); }';
  const cov = tokenCoverage(['stripe', 'webhook', 'signature'], new Set(tokenizeText(chunk)));
  assert.equal(cov, 1);
  assert.equal(identifierHits(['verifyStripeWebhook'], chunk), 1);
  assert.equal(identifierHits(['nonexistentFn'], chunk), 0);
});

console.log('rrf fusion');
test('rrf is scale-invariant: top of both lists wins', () => {
  const fused = rrfFuse([['a', 'b', 'c'], ['b', 'a', 'd']]);
  assert.ok(fused[0].id === 'a' || fused[0].id === 'b');
  const a = fused.find((f) => f.id === 'a');
  const c = fused.find((f) => f.id === 'c');
  assert.ok(a.rrf > c.rrf);
});
test('rrf does not let a single modality dominate with garbage', () => {
  // 'junk' is rank-1 in lexical only; 'good' is rank-2 in both
  const fused = rrfFuse([['junk', 'good', 'x'], ['y', 'good', 'z']]);
  const junk = fused.find((f) => f.id === 'junk');
  const good = fused.find((f) => f.id === 'good');
  assert.ok(good.rrf > junk.rrf, 'cross-modal agreement should beat single-modality top hit');
});

console.log('evidence gate');
test('weak everything fails the gate', () => {
  assert.equal(passesGate({ cosine: 0.2, coverage: 0.2, identifierHits: 0 }, CFG), false);
});
test('semantic floor alone passes', () => {
  assert.equal(passesGate({ cosine: 0.5, coverage: 0.1, identifierHits: 0 }, CFG), true);
});
test('lexical coverage alone passes', () => {
  assert.equal(passesGate({ cosine: 0.1, coverage: 0.8, identifierHits: 0 }, CFG), true);
});
test('exact identifier anchor alone passes', () => {
  assert.equal(passesGate({ cosine: 0.1, coverage: 0.1, identifierHits: 1 }, CFG), true);
});
test('no identifiers in query cannot fake an anchor hit', () => {
  assert.equal(passesGate({ cosine: 0.1, coverage: 0.1, identifierHits: 0 }, CFG), false);
});

console.log('relative cutoff');
test('drops the weak tail relative to top score', () => {
  const scored = [{ score: 2.0 }, { score: 1.5 }, { score: 0.4 }];
  const cut = relativeCutoff(scored, 0.45);
  assert.equal(cut.length, 2);
});
test('single result is kept', () => {
  assert.equal(relativeCutoff([{ score: 1 }], 0.45).length, 1);
});

console.log('scoring');
test('strong candidate outranks gated-but-weak candidate', () => {
  const strong = { rrf: 2 / (CFG.rrfK + 1), cosine: 0.7, coverage: 0.9, identifierHits: 2, fileBoost: CFG.fileNameBoost };
  const weak = { rrf: 1 / (CFG.rrfK + 30), cosine: 0.33, coverage: 0, identifierHits: 0, fileBoost: 0 };
  assert.ok(scoreCandidate(strong, CFG) > 2 * scoreCandidate(weak, CFG));
});

console.log('diversify');
test('caps chunks per file', () => {
  const ranked = [
    { id: 1, path: 'a.ts' }, { id: 2, path: 'a.ts' }, { id: 3, path: 'a.ts' }, { id: 4, path: 'b.ts' },
  ];
  const sel = diversify(ranked, { maxPerFile: 2, nearDupCosine: 0.92 });
  assert.deepEqual(sel.map((s) => s.id), [1, 2, 4]);
});
test('drops near-duplicates by vector', () => {
  const v1 = new Float32Array([1, 0]);
  const v2 = new Float32Array([0.999, 0.01]);
  const v3 = new Float32Array([0, 1]);
  const vecs = { 1: v1, 2: v2, 3: v3 };
  const ranked = [
    { id: 1, path: 'a.ts' }, { id: 2, path: 'b.ts' }, { id: 3, path: 'c.ts' },
  ];
  const sel = diversify(ranked, { maxPerFile: 5, nearDupCosine: 0.92, vecOf: (id) => vecs[id] });
  assert.deepEqual(sel.map((s) => s.id), [1, 3]);
});

console.log('chunker');
test('prefers blank-line / construct boundaries and keeps line numbers', () => {
  const code = Array.from({ length: 200 }, (_, i) =>
    i % 40 === 0 ? `function fn${i}() {` : i % 40 === 39 ? '}' : `  // line ${i}`
  ).join('\n');
  const chunks = chunkText(code, { targetLines: 80, minLines: 25, overlapLines: 8 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].startLine, 1);
  for (const c of chunks) assert.ok(c.endLine >= c.startLine);
  const lines = code.split('\n');
  for (const c of chunks.slice(1)) {
    const first = lines[c.startLine - 1];
    assert.ok(first.trim() !== '', 'chunk should not start on a blank line');
  }
});
test('overlapping chunks share lines', () => {
  const code = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
  const chunks = chunkText(code, { targetLines: 80, minLines: 25, overlapLines: 8 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[1].startLine <= chunks[0].endLine, 'chunks should overlap');
});
test('empty input yields no chunks', () => {
  assert.equal(chunkText('   \n  \n').length, 0);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
