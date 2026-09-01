import fs from 'node:fs';
import path from 'node:path';

/**
 * Text extraction by file type. Binary formats are lazy-loaded so a broken
 * optional dependency never blocks plain-text indexing; failures return null
 * and the file is skipped with a warning counted by the caller.
 */
export async function extractText(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (ext === '.pdf') {
      // Import the inner module directly: pdf-parse's package index runs a
      // debug block when loaded from ESM (module.parent is undefined).
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
      const result = await pdfParse(fs.readFileSync(absPath));
      return result.text || null;
    }
    if (ext === '.docx') {
      const mod = await import('mammoth');
      const mammoth = mod.default || mod;
      const result = await mammoth.extractRawText({ path: absPath });
      return result.value || null;
    }
    if (ext === '.html' || ext === '.htm') {
      const TurndownService = (await import('turndown')).default;
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      return td.turndown(fs.readFileSync(absPath, 'utf8'));
    }
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}
