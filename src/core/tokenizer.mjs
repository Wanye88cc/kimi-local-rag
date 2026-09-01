/**
 * Code-aware tokenizer.
 *
 * BM25 quality on source code depends heavily on tokenization: a plain
 * unicode tokenizer treats `verifyStripeWebhook` as ONE term, so a query for
 * "stripe webhook" never matches it lexically. We index both the original
 * identifier AND its camelCase/snake_case parts, so both "verifyStripeWebhook"
 * and "stripe webhook" hit the same chunk.
 */

const STOPWORDS = new Set(
  ('a,an,the,and,or,but,if,then,else,when,while,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,' +
    'do,does,did,doing,have,has,had,having,i,you,he,she,it,we,they,me,him,her,us,them,this,that,these,those,there,here,' +
    'what,which,who,whom,how,why,where,can,could,should,would,will,shall,may,might,must,not,no,yes,so,such,than,too,very,' +
    'just,also,into,over,under,again,further,once,any,all,each,few,more,most,other,some,own,same,only,between,both,during,' +
    'before,after,above,below,up,down,out,off,about,against,through,am,its,itself,my,your,his,their,our,yourself,themselves,' +
    'ourselves,myself,get,got,make,made,take,use,used,using,way,thing,things,something,anything,nothing,everything,' +
    'someone,anyone,everyone,somewhere,anywhere,everywhere,really,actually,basically,please,want,need,like,know,think')
    .split(',')
);

/** Split one identifier into its camelCase / snake_case / ACRONYM parts. */
export function splitIdentifierParts(token) {
  const parts = [];
  for (const seg of token.split(/_+/)) {
    if (!seg) continue;
    // "HTTPSConnection" -> ["HTTPS", "Connection"], "verifyStripeWebhook" -> ["verify", "Stripe", "Webhook"]
    const subs = seg.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    for (const s of subs) if (s) parts.push(s);
  }
  return parts;
}

/**
 * Lightweight suffix stemmer — not Porter, just enough to align inflections
 * that commonly break lexical matches: tokens/token, verified/verify,
 * connections/connection, bodies/body.
 */
export function stem(t) {
  if (t.length <= 4) return t;
  if (t.endsWith('ies') && t.length > 5) return t.slice(0, -3) + 'y';
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('es') && !t.endsWith('ses') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) return t.slice(0, -1);
  return t;
}

/**
 * Token stream for indexing (keeps duplicates so BM25 term frequency works).
 * Includes lowercased full identifiers, their split parts, and stemmed forms
 * so "tokens" in a query matches "token" in code.
 */
export function tokenizeText(text) {
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!raw) return [];
  const out = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (lower.length >= 2 && !/^[0-9]+$/.test(lower)) out.push(lower);
    for (const p of splitIdentifierParts(t)) {
      const lp = p.toLowerCase();
      if (lp.length >= 2 && lp !== lower && !/^[0-9]+$/.test(lp)) out.push(lp);
    }
  }
  // Add stemmed variants
  const stemmed = [];
  for (const t of out) {
    const s = stem(t);
    if (s !== t) stemmed.push(s);
  }
  return out.concat(stemmed);
}

/**
 * Extract "rare identifiers" — tokens that look like code identifiers or
 * filenames (verifyStripeWebhook, STRIPE_WEBHOOK_SECRET, config.json).
 * These are extremely precise anchors: if a chunk contains the exact
 * identifier from the query, it is almost always relevant.
 */
export function extractIdentifiers(text) {
  const ids = new Set();
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  for (const t of raw) {
    const hasSepOrDigit = /_|\d/.test(t);
    const hasMixedCase = /[a-z]/.test(t) && /[A-Z]/.test(t);
    if ((hasSepOrDigit || hasMixedCase || t.length >= 12) && !STOPWORDS.has(t.toLowerCase())) {
      ids.add(t);
    }
  }
  // dotted names: config.json, payments.ts, package-lock.json (but not 1.5)
  for (const m of text.matchAll(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)+/g)) {
    if (m[0].length >= 4 && !/^\d+(\.\d+)+$/.test(m[0])) ids.add(m[0]);
  }
  return [...ids];
}

/**
 * Tokenize a user query.
 * @returns {{terms: string[], contentTerms: string[], identifiers: string[]}}
 *   terms          — unique lowercased tokens (incl. identifier parts)
 *   contentTerms   — terms minus stopwords (used for BM25 + coverage)
 *   identifiers    — original-case rare identifiers (used for exact-hit boost)
 */
export function tokenizeQuery(query) {
  // tokenizeText already includes stemmed variants; normalize to stems and dedupe
  const terms = [...new Set(tokenizeText(query).map(stem))];
  const contentTerms = terms.filter((t) => !STOPWORDS.has(t));
  const identifiers = extractIdentifiers(query);
  return { terms, contentTerms, identifiers };
}

/** Fraction of query content terms present in a chunk's token set. */
export function tokenCoverage(contentTerms, chunkTokenSet) {
  if (contentTerms.length === 0) return 0;
  let hit = 0;
  for (const t of contentTerms) if (chunkTokenSet.has(t)) hit++;
  return hit / contentTerms.length;
}

/** How many of the query's rare identifiers appear verbatim in the chunk text. */
export function identifierHits(identifiers, chunkText) {
  let hits = 0;
  for (const id of identifiers) if (chunkText.includes(id)) hits++;
  return hits;
}
