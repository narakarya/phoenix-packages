import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'index.html'), 'utf8');

const START = '// ── Parsers';
const END = '// ── Security audit';

// The parsers block is pure function declarations, so evaluating it has no
// side effects and needs no DOM. Keep it that way or this harness breaks.
export function loadPureFns(names) {
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error('parser block markers not found in index.html');
  }
  const src = html.slice(s, e);
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
