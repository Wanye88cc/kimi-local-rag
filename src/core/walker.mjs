import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

export const DEFAULT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.lua', '.pl', '.pm', '.r', '.jl',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.hs', '.ml', '.fs', '.fsx', '.dart',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml', '.csv',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
  '.sql', '.graphql', '.gql', '.proto', '.tf', '.cmake', '.dockerfile',
  '.pdf', '.docx',
]);

const SPECIAL_FILENAMES = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', 'rakefile', 'gemfile', 'podfile',
  'justfile', 'taskfile', 'brewfile', '.gitignore', '.dockerignore', '.env.example',
]);

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.vercel', '.venv', 'venv', 'env',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'vendor', 'bin', 'obj',
  '.idea', '.vscode', '.DS_Store', 'tmp', 'temp', 'logs', '.kimi-code',
]);

function isBinary(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  }
}

function isExcluded(relPath, patterns) {
  const norm = relPath.split(path.sep).join('/');
  return patterns.some((p) => minimatch(norm, p, { dot: true, matchBase: !p.includes('/') }));
}

export function allowedExtensions(config) {
  const exts = new Set(DEFAULT_EXTENSIONS);
  for (const e of config.extraExtensions || []) exts.add(e.startsWith('.') ? e : `.${e}`);
  for (const e of config.excludeExtensions || []) exts.delete(e.startsWith('.') ? e : `.${e}`);
  return exts;
}

/**
 * Recursively collect indexable files under root.
 * @returns {Array<{abs: string, rel: string, size: number, mtime: number}>}
 */
export function walkFiles(root, config) {
  const exts = allowedExtensions(config);
  const patterns = config.excludePatterns || [];
  const out = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
        if (isExcluded(rel + '/', patterns) || isExcluded(rel, patterns)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (isExcluded(rel, patterns)) continue;
        const ext = path.extname(e.name).toLowerCase();
        const isSpecial = SPECIAL_FILENAMES.has(e.name.toLowerCase());
        if (!isSpecial && !exts.has(ext)) continue;
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size === 0 || st.size > config.maxFileBytes) continue;
        if (ext !== '.pdf' && ext !== '.docx' && isBinary(abs)) continue;
        out.push({ abs, rel: rel.split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
      }
    }
  };

  const st = fs.statSync(root, { withFileTypes: true });
  if (st.isFile()) {
    return [{
      abs: root,
      rel: path.basename(root),
      size: st.size,
      mtime: st.mtimeMs,
    }];
  }
  walk(root);
  return out;
}
