# LLM Wiki Investigation

A dedicated research section: an evidence-based report on **Andrej Karpathy's LLM Wiki** pattern
(April 2026) — a persistent, agent-maintained markdown knowledge base built from immutable raw
sources, an LLM-owned wiki, and a written schema. The report covers why the pattern exists, how the
loops work, how ordinary links become a graph, how to build one, and where the evidence stops.

The report is a set of standalone HTML pages with no build step. Open `index.html` in a browser, or
see the GitHub Pages site once the folder is published (`/llm-wiki/`).

**The distinction the report keeps making:** Karpathy popularized this maintenance pattern; he did
not invent linked markdown, wikilinks, graph views, or knowledge graphs. The wiki is a folder of
files, and "markdown as a graph" is a *derived* graph over those files — not a new file format or a
graph database. The files remain canonical.

## Pages

| # | File | What it covers |
|---|---|---|
| — | `index.html` | Verdicts up front, the full decision matrix, myth check, key numbers, scope and method, sources |
| 1 | `01_idea.html` | The RAG baseline, compile-once/query-many, what compounding really means, the maintenance bottleneck, Memex/Zettelkasten prior art, where the pattern fits, and a comparison/glossary |
| 2 | `02_architecture.html` | The three layers, a scalable folder layout, the `AGENTS.md` schema contract, page types and frontmatter, `index.md` and `log.md`, ingest/query/lint workflows, a worked example, search and graph indexes at scale, git concurrency, and the security model |
| 3 | `03_graph.html` | Why markdown is already a graph, link syntax and direction, backlinks and graph views, typed edges with provenance, graph indexes such as `ki` and Neo4j, when an index earns its keep, graph health, and the boundary between a folder and a graph database |
| 4 | `04_build.html` | The minimal stack, an eight-step setup, a starter vault, copyable templates for `AGENTS.md`/`index.md`/`log.md`, ingest and lint prompts, tooling, publishing, a 30-day plan, cost evaluation, and a launch checklist |
| 5 | `05_evidence.html` | What Karpathy claims and does not, the benchmarks and their caveats, the failure modes that kill wikis, production guardrails, the strict "when not to use" list, a decision tree, the ecosystem and OKF, and open questions |
| — | `graph.html` | An interactive canvas map of the report: 38 nodes, 75 edges, search, type filters, drag, pause, and a keyboard-accessible node list |

## Version pins and dated facts

- Karpathy's idea file, `llm-wiki.md`: GitHub Gist published **4 April 2026**. The ~100-source
  ceiling for `index.md` is his estimate, not a measured limit.
- Google Cloud **Open Knowledge Format**: v0.1 announced **12 June 2026**; v0.2 shipped
  **24 July 2026**, adding provenance, trust, lifecycle, and attested computations.
- `qmd`, `graphify`, `ki`, and `llm-wiki-ops`: checked **October 2026**. These are fast-moving
  projects; pin a commit before depending on their behavior.
- Research window: **October 2026**. Vendor and author benchmarks are labeled as such; re-measure
  on your own corpus before treating any number as a planning constant.

## Evidence caveats

The independent comparisons are small and conditional. A preregistered wiki-vs-RAG study found much
better cross-paper synthesis and claim-level citation for the wiki, but a ~21× query-token premium;
a 72-run migration benchmark found 54% fewer tokens than reading raw files; a 30-query comparison
found agentic RAG competitive with the wiki on quality and cheaper on tokens. The report treats
these as directional evidence, not universal constants. Part 5 explains what each test did and did
not control.

## Relation to the rest of the repository

- `../vector_databases/` — the retrieval layer: embeddings, pgvector, hybrid search, and when vector
  search is the wrong tool.
- `../graph_databases/` — the graph-engine layer: recursive CTEs, `ltree`, Apache AGE, and the honest
  boundary between a graph projection and a graph database.
- This report sits one level above both: how to maintain a durable knowledge artifact with an agent,
  and when that artifact is worth building at all. It meets the siblings at graph indexes (Part 3)
  and retrieval at scale (Part 2 §10).
- Styling is shared with the sibling reports via `assets/report.css`; `scripts/publish-report.mjs`
  copies all three investigation folders into the static export (`out/llm-wiki/`).
