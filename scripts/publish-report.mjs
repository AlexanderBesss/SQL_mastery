// Copies the standalone vector database investigation into the static export
// so it ships alongside the course app on GitHub Pages (out/vector-databases/).
// next.config.ts only produces out/ for static exports (GITHUB_ACTIONS builds),
// so skip outside that context instead of creating a half-populated out/.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, 'vector_databases');
const out = join(root, 'out');
const target = join(out, 'vector-databases');

if (!existsSync(source)) {
  console.warn('vector_databases/ not found — skipping report copy.');
} else if (!existsSync(out)) {
  console.warn('out/ not found (not a static export build) — skipping report copy.');
} else {
  cpSync(source, target, { recursive: true });
  console.log('Published vector_databases/ to out/vector-databases/.');
}
