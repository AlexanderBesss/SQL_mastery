# Graph Databases Investigation

A dedicated research section: an evidence-based report on **graph databases**, centered on
**PostgreSQL's graph ladder** (recursive CTEs, `ltree`, pgRouting, Apache AGE, and the SQL/PGQ
standard) — what graph databases are, every case where they are the right tool, and the strict list
of cases where they are not.

The report is a set of standalone HTML pages (no build step). Open `index.html` in a browser, or see
the GitHub Pages site once the folder is published (`/graph-databases/`).

## Pages

| # | File | What it covers |
|---|---|---|
| — | `index.html` | Executive verdicts, the full decision matrix, key versioned numbers, scope & sources |
| 1 | `01_foundations.html` | Property graphs vs RDF, index-free adjacency, OLTP traversal vs OLAP analytics, Cypher/GQL/Gremlin/SPARQL/SQL/PGQ, native-vs-non-native, LDBC benchmarks |
| 2 | `02_postgresql_graph.html` | The Postgres ladder deep dive: recursive CTEs, `ltree`, pgRouting, Apache AGE engineering (label tables, `agtype`, indexes, VLE cost model, hybrid SQL+Cypher), the PostgreSQL 19 SQL/PGQ revert, operations, worked schema |
| 3 | `03_use_cases.html` | Eight use cases that hold up (fraud rings, GraphRAG, recommendations, access control, IT impact, entity resolution, lineage, routing) — each with a recipe and a bail-out condition |
| 4 | `04_when_not_to_use.html` | Ten hard "don't" rules, anti-pattern catalog, graph privacy/deletion ledger, the Kuzu consolidation lesson, when a dedicated graph DB is genuinely correct, dual-store pattern, decision tree, checklists |

## Version pins used throughout

- Apache AGE **1.8.0** (ASF release catalog 2026-08-06); supports PostgreSQL 11–18
- PostgreSQL **13–18** GA; **19** GA planned 2026-11-19 **without SQL/PGQ** (reverted from beta 2026-09-07)
- Standards: GQL **ISO/IEC 39075:2024** (+ Cor. 1 2026; Ed. 2 CD in progress) · SQL/PGQ **ISO/IEC 9075-16:2023**
- pgRouting **4.0** (manual 2026-09); Neo4j **2026.x** CalVer line, Cypher 25 default
- Research window: **October 2026** — vendor benchmarks are labeled as vendor claims; re-measure on your own data.

## Relation to the rest of the repository

- `../vector_databases/` — the sibling investigation; same structure and argument ("use Postgres
  first"), meeting at GraphRAG (Part 3 §3), where graph and vector retrieval are two ends of one
  retrieval pipeline.
- `../advanced_patterns/09_fulltext_search_geospatial.md` — PostGIS + pgRouting share the routing/network
  territory argued in Part 2 §3.
- `../advanced_patterns/01_indexing_strategies.md` — the B-tree/GIN background the AGE indexing
  discussion (Part 2 §5) builds on.
- Styling shares the palette of the course app (`app/globals.css`); the report itself is independent
  of the Next.js build (`scripts/generate-content.mjs` only ingests numbered `.md` files from the four
  track directories). `scripts/publish-report.mjs` copies both reports into the static export.
