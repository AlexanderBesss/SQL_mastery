# Vector Databases Investigation

A dedicated research section: an evidence-based report on **vector databases**, centered on
**PostgreSQL + pgvector** — what they are, every case where they are the right tool, and the strict
list of cases where they are not.

The report is a set of standalone HTML pages (no build step). Open `index.html` in a browser, or see
the GitHub Pages site if the folder is published.

## Pages

| # | File | What it covers |
|---|---|---|
| — | `index.html` | Executive verdicts, the full decision matrix, key versioned numbers, scope & sources |
| 1 | `01_foundations.html` | Embeddings, distance metrics, exact vs approximate search, HNSW / IVFFlat / DiskANN, quantization, recall & evaluation |
| 2 | `02_postgresql_pgvector.html` | pgvector deep dive: types & limits, indexed query shapes, HNSW/IVFFlat tuning, filtered search + iterative scans, multi-tenancy, hybrid search with FTS, scaling ladder, operations, worked schema |
| 3 | `03_use_cases.html` | Eight use cases that hold up (semantic search, RAG, recommendations, dedup, matching, multimodal, anomaly/drift, k-NN triage) — each with a Postgres recipe and a bail-out condition |
| 4 | `04_when_not_to_use.html` | Ten hard "don't" rules, anti-pattern catalog, embedding-privacy/inversion risks, when a dedicated vector DB is genuinely correct, dual-store pattern, decision tree, checklists |

## Version pins used throughout

- pgvector **0.8.7** (2026-10-01); iterative index scans since 0.8.0 (Oct 2024)
- PostgreSQL **13–18**
- Research window: **October 2026** — vendor benchmarks are labeled as vendor claims; re-measure on your own data.

## Relation to the rest of the repository

- `../advanced_patterns/09_fulltext_search_geospatial.md` — the lexical (FTS) half of the hybrid-search
  story argued in Part 2 §7.
- `../advanced_patterns/01_indexing_strategies.md` — B-tree/GIN/partial index background used by the
  filtering decision ladder.
- Styling shares the palette of the course app (`app/globals.css`); the report itself is independent
  of the Next.js build (`scripts/generate-content.mjs` only ingests numbered `.md` files from the four
  track directories).
