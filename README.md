# SQL Mastery

An interactive PostgreSQL learning path for moving from schema fundamentals to production architecture, query performance, concurrency, operations, and Node.js backend interviews.

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

The workflow in `.github/workflows/deploy-pages.yml` tests, exports, and deploys the site whenever `main` is pushed. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
