[View on GitHub Pages](https://alexanderbesss.github.io/SQL_mastery/)

# SQL Mastery

An interactive PostgreSQL learning path for moving from schema fundamentals to production architecture, query performance, concurrency, operations, and Node.js backend interviews.

## Vector databases investigation

A standalone research section lives in [`vector_databases/`](vector_databases/README.md): a four-part
HTML investigation of vector databases centered on PostgreSQL + pgvector — foundations, a full pgvector
engineering manual, the use cases that hold up, and a strict guide to when *not* to use them.
Open `vector_databases/index.html` in a browser.

## Graph databases investigation

A second standalone research section lives in [`graph_databases/`](graph_databases/README.md): a
four-part HTML investigation of graph databases centered on PostgreSQL's graph ladder — recursive CTEs,
`ltree`, pgRouting, and Apache AGE, plus the GQL/SQL/PGQ standards (including PostgreSQL 19's reverted
SQL/PGQ, as of October 2026) — foundations, a full AGE engineering manual, the use cases that hold up,
and a strict guide to when *not* to use a dedicated graph database.
Open `graph_databases/index.html` in a browser.

## LLM Wiki investigation

A third standalone research section lives in [`llm_wiki/`](llm_wiki/README.md): a five-part
HTML investigation of Andrej Karpathy's **LLM Wiki** pattern — why a persistent, LLM-maintained
markdown wiki can beat per-query RAG at synthesis, the raw/wiki/schema architecture and its
ingest/query/lint loops, how ordinary links and frontmatter become a graph without a graph
database, a build guide with copyable templates and prompts, and the benchmark evidence,
failure modes, and hard limits. Includes an interactive graph view.
Open `llm_wiki/index.html` in a browser.

## Learning experience

- 35 complete lessons generated from the repository's existing technical notes
- Search and filters across four connected learning tracks
- Rich tables, relationship diagrams, and copyable SQL examples
- Bookmarks, completion tracking, and a progress report stored locally in the browser
- Active-recall review cards and an interactive SQL logical-order reference
- Responsive static output with no backend or account required

## Local development

```bash
npm ci
npm run dev
```

Run the production checks with:

```bash
npm test
npm run lint
npm run build:pages
```

The content bundle is rebuilt from the numbered lesson files by `scripts/generate-content.mjs` before every Pages build.

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` tests, exports, and deploys the site whenever `main` is pushed.

Before the first deployment, initialize Pages once:

1. Open the GitHub repository.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Re-run the failed workflow or push another commit.

GitHub's `actions/configure-pages` action cannot perform this first-time initialization with the standard workflow token. Its automatic `enablement` option requires a separate personal access token or GitHub App token with repository administration permission, so manual initialization is the safer one-time setup.
