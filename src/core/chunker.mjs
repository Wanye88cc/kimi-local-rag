/**
 * Boundary-aware chunker.
 *
 * pi-local-rag cuts every 50 lines regardless of structure, which splits
 * functions in half and dilutes both BM25 and embedding signals. Here we
 * prefer blank lines and top-level construct starts (function/class/header)
 * as break points, and overlap consecutive chunks so context that straddles
 * a boundary is still retrievable.
 */

const CONSTRUCT_START =
  /^(\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|enum|struct|impl|trait|def |fn |func |public |private |protected |static |package |func\()|#{1,6}\s|\s*\/\*\*|\s*"""|\s*''')/;

const MAX_CHUNK_CHARS = 6000;

/** Lines where a NEW chunk may start (indexes into lines). */
function breakPoints(lines) {
  const breaks = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].trim() === '') breaks.add(i); // start after a blank line
    else if (CONSTRUCT_START.test(lines[i]) && lines[i].trim() !== '') breaks.add(i);
  }
  return [...breaks].sort((a, b) => a - b);
}

/**
 * @param {string} text
 * @param {{targetLines?: number, minLines?: number, overlapLines?: number}} opts
 * @returns {Array<{text: string, startLine: number, endLine: number}>} 1-based, inclusive
 */
export function chunkText(text, opts = {}) {
  const target = opts.targetLines ?? 80;
  const min = opts.minLines ?? 25;
  const overlap = opts.overlapLines ?? 8;

  const lines = text.split('\n');
  // Drop trailing whitespace-only lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return [];

  const chunks = [];
  const breaks = breakPoints(lines);
  let start = 0;

  while (start < lines.length) {
    let end = Math.min(start + target, lines.length); // exclusive
    if (end < lines.length) {
      // Find the best break point in [start+min, start+target]
      let best = -1;
      for (const b of breaks) {
        if (b >= start + min && b <= start + target) best = b;
        if (b > start + target) break;
      }
      if (best > start) end = best;
    }

    let slice = lines.slice(start, end);
    let textOut = slice.join('\n');
    // Hard cap by characters (long minified lines etc.)
    while (textOut.length > MAX_CHUNK_CHARS && slice.length > 1) {
      slice = slice.slice(0, Math.max(1, Math.floor(slice.length / 2)));
      textOut = slice.join('\n');
      end = start + slice.length;
    }
    textOut = textOut.slice(0, MAX_CHUNK_CHARS);

    if (textOut.trim().length > 0) {
      chunks.push({ text: textOut, startLine: start + 1, endLine: end });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}
