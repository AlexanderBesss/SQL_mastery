// Copies the standalone vector + graph database investigations into the static
// export so they ship alongside the course app on GitHub Pages
// (out/vector-databases/, out/graph-databases/).
// next.config.ts only produces out/ for static exports (GITHUB_ACTIONS builds),
// so skip outside that context instead of creating a half-populated out/.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'out');
const reports = [
  ['vector_databases', 'vector-databases'],
  ['graph_databases', 'graph-databases'],
];

if (!existsSync(out)) {
  console.warn('out/ not found (not a static export build) — skipping report copy.');
} else {
  for (const [source, target] of reports) {
    const from = join(root, source);
    if (!existsSync(from)) {
      console.warn(`${source}/ not found — skipping report copy.`);
      continue;
    }
    cpSync(from, join(out, target), { recursive: true });
    console.log(`Published ${source}/ to out/${target}/.`);
  }
}

