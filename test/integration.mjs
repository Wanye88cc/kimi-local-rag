/**
 * End-to-end integration test: indexes a fixture project and verifies that
 * relevant queries return results while IRRELEVANT queries return nothing
 * (the core promise vs pi-local-rag).
 *
 * By default uses a deterministic hash-based fake embedder so the full
 * SQLite + FTS5 + RRF + gate pipeline runs without a model download.
 * Pass --real to use the real ONNX model (one-time ~35 MB download):
 *
 *   node test/integration.mjs          # offline, fake embeddings
 *   node test/integration.mjs --real   # real bge-small-en-v1.5 embeddings
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { RagStore } from '../src/core/store.mjs';
import { indexPaths } from '../src/core/indexer.mjs';
import { search } from '../src/core/search.mjs';
import { tokenizeText } from '../src/core/tokenizer.mjs';

const DIM = 384;

/** Hashing-trick embeddings: token overlap produces cosine similarity. */
function fakeEmbedOne(text) {
  const v = new Float32Array(DIM);
  for (const tok of tokenizeText(text)) {
    const h = crypto.createHash('md5').update(tok).digest();
    v[h.readUInt32LE(0) % DIM] += h[4] & 1 ? 1 : -1;
  }
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

const USE_REAL = process.argv.includes('--real');
const embedFn = USE_REAL ? undefined : async (texts) => texts.map(fakeEmbedOne);

const FIXTURES = {
  'src/payments/webhooks.ts': `
import crypto from 'node:crypto';

// All inbound webhooks are verified against the shared secret stored in
// STRIPE_WEBHOOK_SECRET. Stripe signs each request with a t= timestamp and
// a v1= signature over "t.payload".
export async function verifyStripeWebhook(req) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) throw new Error('missing signature header');
  const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=')));
  const expected = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(parts.t + '.' + req.rawBody)
    .digest('hex');
  if (expected !== parts.v1) throw new Error('invalid webhook signature');
  return true;
}

export function parseWebhookEvent(req) {
  return JSON.parse(req.rawBody);
}
`,
  'src/auth/session.ts': `
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function issueSessionToken(sign, userId, secret) {
  return sign({ sub: userId }, secret, { expiresIn: SESSION_TTL_SECONDS });
}

export function requireSession(req, verify, secret) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) throw new Error('unauthenticated');
  return verify(token, secret);
}
`,
  'docs/deployment.md': `
# Deployment

The service is deployed to Fly.io with two machines in the fra region.
Run \`fly deploy --ha=false\` from the repo root. Database migrations run
automatically on boot via the release command. Roll back with
\`fly releases rollback\`. Secrets are managed with \`fly secrets set\`.
`,
  'docs/onboarding.md': `
# Onboarding

New hires receive a laptop on day one. IT sets up the VPN, email and SSO
accounts. Engineering onboarding includes cloning the monorepo, running the
bootstrap script, and shadowing an on-call rotation for one week.
`,
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-it-'));
  const projDir = path.join(tmp, 'proj');
  const ragDir = path.join(tmp, 'rag');
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(projDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const store = new RagStore(ragDir);
  console.log(`indexing fixtures (${USE_REAL ? 'real model — first run downloads ~35 MB' : 'fake hash embeddings'})…`);
  const stats = await indexPaths(store, [projDir], { embedFn });
  console.log('indexed:', stats);
  assert.ok(stats.indexed >= 4);

  const cases = [
    { q: 'how are stripe webhook signatures verified?', expectPath: 'webhooks.ts', shouldHit: true },
    { q: 'what does verifyStripeWebhook do with STRIPE_WEBHOOK_SECRET?', expectPath: 'webhooks.ts', shouldHit: true },
    { q: 'how long do session tokens last?', expectPath: 'session.ts', shouldHit: true },
    { q: 'how do I roll back a deployment?', expectPath: 'deployment.md', shouldHit: true },
    { q: 'what is the best recipe for sourdough bread?', shouldHit: false }, // irrelevant
    { q: 'quantum entanglement experiments in superconducting qubits', shouldHit: false }, // irrelevant
  ];

  let failures = 0;
  for (const c of cases) {
    const out = await search(store, c.q, { embedFn });
    const hit = out.results.some((r) => r.path.includes(c.expectPath || ''));
    const ok = c.shouldHit ? hit : out.results.length === 0;
    console.log(
      `${ok ? '  ok ' : 'FAIL '} "${c.q}" -> ${out.results.length} result(s) (reason: ${out.reason})` +
        (out.results[0] ? ` top=${out.results[0].path} score=${out.results[0].score.toFixed(2)}` : '')
    );
    if (!ok) failures++;
  }

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} case(s) failed`);
    process.exit(1);
  }
  console.log('\nintegration test passed — relevant queries hit, irrelevant queries inject nothing');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
