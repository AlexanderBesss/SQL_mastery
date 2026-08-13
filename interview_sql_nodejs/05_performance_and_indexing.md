# Performance and Indexing

## Q1: What types of indexes exist in PostgreSQL and when do you use each?

**Answer:**

| Index Type | Best For | Example |
|---|---|---|
| **B-tree** (default) | Equality, range, sorting | WHERE, ORDER BY, BETWEEN |
| **Hash** | Equality only | WHERE email = ... |
| **GIN** | Arrays, JSONB, full-text | JSONB containment, array overlap |
| **GiST** | Geometric, full-text, range | PostGIS, range queries |
| **BRIN** | Large tables, naturally ordered | Time-series, IoT data |
| **Partial** | Subset of rows | WHERE is_active = true |
| **Covering** | Index-only scans | INCLUDE columns |

```sql
-- B-tree (default, most common)
CREATE INDEX idx_users_email ON users (email);

-- GIN for JSONB
CREATE INDEX idx_products_attrs ON products USING GIN (attributes);

-- Partial index (only indexes active users)
CREATE INDEX idx_active_users ON users (last_login) WHERE is_active;

-- Covering index (index-only scan, no table lookup)
CREATE INDEX idx_orders_covering ON orders (user_id) INCLUDE (status, total, created_at);

-- BRIN for time-series (very small, page-level)
CREATE INDEX idx_events_time ON events USING BRIN (created_at);
```

**Key point:** B-tree handles 90% of use cases. Use GIN for JSONB/arrays, BRIN for massive ordered tables.

**On Hash indexes:** almost never worth it. B-tree already handles equality efficiently and *also* supports ordering, ranges, and uniqueness. Hash indexes only became crash-safe (WAL-logged) in PG 10, can't support `UNIQUE`, and can't be used for `ORDER BY`. Their one niche is equality on very large values, where the hash is much smaller than the key. Saying "I'd just use B-tree" is the right answer.

**On BRIN:** it's tiny (kilobytes for a table of hundreds of GB) because it stores only min/max per block range. But it collapses entirely if physical row order stops correlating with the column values — so it works for an append-only `created_at`, and not for a column updated in place.

---

## Q2: How do you identify slow queries?

**Answer:**

```sql
-- Enable slow query log (postgresql.conf)
-- log_min_duration_statement = 1000;  -- log queries over 1s

-- Use EXPLAIN ANALYZE to see actual execution plan
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM orders WHERE user_id = 1 AND created_at > '2024-01-01';

-- Check most expensive queries from pg_stat_statements
-- First enable: CREATE EXTENSION pg_stat_statements;
SELECT query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**In Node.js:** `pg` has no built-in query logging, so wrap the pool:

```javascript
const originalQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  const start = Date.now();
  try {
    return await originalQuery(text, params);
  } finally {
    const ms = Date.now() - start;
    if (ms > 100) console.warn('[slow query]', ms, 'ms', text);
  }
};

// Always attach this — an idle client erroring with no listener crashes the process
pool.on('error', (err) => console.error('Unexpected pool error', err));

// Knex: the option is `debug`, not `logging`
const knex = require('knex')({ client: 'pg', connection, debug: true });
```

**Two useful `pg_stat_statements` columns people forget:** `stddev_exec_time` (finds queries with unstable plans) and sorting by `total_exec_time` rather than `mean_exec_time` — a 5ms query called 2 million times costs more than a 3-second report run nightly.

---

## Q3: What is the N+1 query problem and how do you fix it?

**Answer:** The N+1 problem occurs when you query a parent, then query children for each parent row.

```javascript
// ❌ N+1 — 1 query for users + N queries for posts
const users = await pool.query('SELECT * FROM users');
for (const user of users.rows) {
  user.posts = (await pool.query('SELECT * FROM posts WHERE user_id = $1', [user.id])).rows;
}

// ✅ Fixed with JOIN — single query.
// FILTER is required: a plain json_agg on a LEFT JOIN yields [null] for users
// with no posts, instead of an empty array.
const { rows } = await pool.query(`
  SELECT u.id, u.name,
         COALESCE(json_agg(p.* ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '[]') AS posts
  FROM users u
  LEFT JOIN posts p ON p.user_id = u.id
  GROUP BY u.id, u.name
`);

// ✅ Fixed with two queries — often FASTER than a JOIN, and no row duplication
const users = (await pool.query('SELECT * FROM users')).rows;
const posts = (await pool.query(
  'SELECT * FROM posts WHERE user_id = ANY($1)',
  [users.map(u => u.id)]
)).rows;
const byUser = new Map(users.map(u => [u.id, { ...u, posts: [] }]));
for (const p of posts) byUser.get(p.user_id)?.posts.push(p);

// ✅ With Prisma — use include (Prisma issues 2 queries, like the pattern above)
const users = await prisma.user.findMany({ include: { posts: true } });

// ✅ With Sequelize — use include
const users = await User.findAll({ include: [Post] });
```

**The two-query pattern deserves emphasis.** Going from N+1 to 1 is not the goal — going from N+1 to a *constant* number of queries is. A JOIN duplicates every parent column once per child row (a user with 500 posts ships their name 500 times over the wire), so for one-to-many fan-out, two queries plus an in-memory join is frequently faster than one JOIN. This is exactly what `dataloader` does, and why Prisma's `include` doesn't emit a JOIN by default.

**Key point:** N+1 is the most common ORM performance issue, and it usually hides behind a lazy-loaded property or a `.map()` with `await` inside. Watch for `await` inside a loop — that shape is the tell.

---

## Q4: How do you read an EXPLAIN output?

**Answer:**

```
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'test@example.com';

Index Scan using idx_users_email on users  (cost=0.43..8.45 rows=1 width=32) (actual time=0.020..0.022 rows=1 loops=1)
  Index Cond: (email = 'test@example.com')
Planning Time: 0.100 ms
Execution Time: 0.050 ms
```

**Key nodes to understand:**
- **Seq Scan:** Full table scan — slow on large tables, consider adding index
- **Index Scan:** Uses index — efficient for selective queries
- **Index Only Scan:** Reads only from index — fastest, no table lookup
- **Bitmap Heap Scan:** Index finds pages, then reads table — common for range queries
- **Hash Join / Merge Join / Nested Loop:** Join strategies

**Reading the numbers:**
- `cost=0.43..8.45` — arbitrary planner units, **not milliseconds**. First number is startup cost (before the first row), second is total. Only useful for comparing plans.
- `rows=1` (in `cost=...`) is the planner's **estimate**; `actual ... rows=1` is reality.
- `loops=N` — the node ran N times. **`actual time` is per-loop, so multiply by `loops`** for the real cost. This is the most misread part of EXPLAIN output: a node showing `actual time=0.01..0.02 rows=1 loops=50000` took ~1 second, not 0.02ms.

**Red flags:**
- Seq Scan on a large table with a selective WHERE clause
- **Estimated vs actual rows off by 10x or more** — the planner is choosing badly because its statistics are wrong. Fix with `ANALYZE`, or raise `default_statistics_target` for skewed columns.
- Nested Loop with a high `loops` count (usually the consequence of the above)
- Sort with `Sort Method: external merge Disk: NNNkB` — the sort spilled to disk; raise `work_mem`
- `Rows Removed by Filter:` in the thousands — the index isn't selective enough
- Under `BUFFERS`, high `shared read` vs `shared hit` — cache misses hitting disk

**Always use `EXPLAIN (ANALYZE, BUFFERS)`,** not bare `EXPLAIN`. Bare EXPLAIN only shows estimates, and estimates are exactly what's wrong when a query is slow.

⚠️ `EXPLAIN ANALYZE` **actually executes the query.** For `INSERT`/`UPDATE`/`DELETE`, wrap it in a transaction and roll back:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM orders WHERE created_at < '2020-01-01';
ROLLBACK;
```

---

## Q5: When should you NOT add an index?

**Answer:**

Indexes speed up reads but slow down writes. Avoid indexing when:

1. **Small tables** (< ~1000 rows) — the whole table is one or two pages; seq scan wins
2. **Low-cardinality columns** — `is_active`, `status` with 3 values. If a value matches more than roughly 5-10% of the table, the planner will ignore the index anyway: random I/O per row costs more than reading sequentially.
3. **Rarely queried columns** — maintenance cost exceeds benefit
4. **Write-heavy tables** — every INSERT/UPDATE/DELETE must update every index. Indexes also defeat PostgreSQL's HOT-update optimization: updating an indexed column forces a new index entry rather than an in-page update, increasing bloat.
5. **Columns with many NULLs** — a partial index is smaller and faster

**Important exception to #2:** low cardinality is fine when the distribution is *skewed* and you query the rare value. A `status` column that is 99.9% `'complete'` and 0.1% `'failed'` is worth indexing if you only ever query `WHERE status = 'failed'` — as a partial index:

```sql
-- Instead of indexing a low-cardinality column:
-- CREATE INDEX idx_users_active ON users (is_active); -- BAD

-- Use a partial index — smaller, and only maintained for matching rows:
CREATE INDEX idx_active_users ON users (created_at) WHERE is_active;

-- Or index the rare value only:
CREATE INDEX idx_jobs_failed ON jobs (created_at) WHERE status = 'failed';
```

For the planner to use a partial index, the query's WHERE clause must **provably imply** the index predicate — `WHERE status = 'failed'` matches, but a parameterized `WHERE status = $1` will not.

```sql
-- Instead of indexing a low-cardinality column:
-- CREATE INDEX idx_users_active ON users (is_active); -- BAD

-- Use a partial index:
CREATE INDEX idx_active_users ON users (created_at) WHERE is_active;
```

---

## Q6: What is a composite index and how does column order matter?

**Answer:** A composite index covers multiple columns. Column order matters for query matching.

```sql
CREATE INDEX idx_orders ON orders (status, created_at);
```

This index supports:
- `WHERE status = 'pending'` — YES (leftmost prefix)
- `WHERE status = 'pending' AND created_at > '2024-01-01'` — YES (both columns)
- `WHERE status = 'pending' ORDER BY created_at` — YES, and the sort is **free**, because the index already stores rows in that order
- `WHERE created_at > '2024-01-01'` — mostly NO. This is the **leftmost prefix rule**: skipping the leading column means the index can't be range-scanned.

A nuance worth knowing: PostgreSQL *can* still use the index for that last query via a full **index scan** if the index is much narrower than the table, or via a bitmap scan when `status` has few distinct values. It just can't seek — so it's rarely a win. Don't count on it.

**The ordering rule** — this is where most candidates repeat a myth. "Most selective column first" is not the rule. The rule is:

> **Equality columns first, then the range/sort column.**

Because once the index hits a range predicate, everything after it is unordered and can only be filtered, not seeked. So for `WHERE status = 'x' AND created_at > 'y'`, `(status, created_at)` is right regardless of which column is more selective — putting `created_at` first would force a scan of every row in the date range.

Selectivity only breaks ties *among the equality columns*, and even there it matters far less than people claim.

```sql
-- If you genuinely query created_at alone too, add a second index
CREATE INDEX idx_orders_created ON orders (created_at);
-- Note: idx_orders (status, created_at) already covers `WHERE status = ...`,
-- so a separate index on (status) alone would be redundant — drop it.
```

**Find redundant indexes** (any index whose columns are a leftmost prefix of another) — they cost write throughput for nothing:

```sql
SELECT indexrelid::regclass AS index, idx_scan AS times_used, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

---

## Q7: How do you optimize a slow query?

**Answer:** Step-by-step approach:

1. **Run EXPLAIN ANALYZE** — identify the bottleneck
2. **Check for missing indexes** — add indexes on WHERE, JOIN, ORDER BY columns
3. **Check statistics** — `ANALYZE table_name;` to update planner statistics
4. **Simplify the query** — remove unnecessary JOINs, columns, subqueries
5. **Consider denormalization** — materialized views, computed columns
6. **Paginate properly** — use cursor-based pagination instead of OFFSET

```sql
-- Update statistics
ANALYZE orders;

-- Check table stats
SELECT n_live_tup, n_dead_tup, last_vacuum, last_analyze
FROM pg_stat_user_tables
WHERE relname = 'orders';
```

---

## Q8: What is the difference between OFFSET pagination and cursor-based pagination?

**Answer:**

```sql
-- OFFSET pagination — slow on large offsets
SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 10000;
-- DB must scan and discard 10,000 rows

-- Cursor-based pagination — always fast
SELECT * FROM products
WHERE created_at < $1 OR (created_at = $1 AND id < $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- Parameters: last_seen_created_at, last_seen_id
```

In Node.js:
```javascript
// Cursor pagination
app.get('/products', async (req, res) => {
  const { before, limit = 20 } = req.query;
  let query = 'SELECT * FROM products ORDER BY created_at DESC, id DESC LIMIT $1';
  let params = [limit];

  if (before) {
    const [createdAt, id] = before.split(':');
    // Row-value comparison — concise, and PG can use an index on (created_at, id) for it
    query = `SELECT * FROM products
             WHERE (created_at, id) < ($1::timestamptz, $2::int)
             ORDER BY created_at DESC, id DESC LIMIT $3`;
    params = [createdAt, id, limit];
  }

  const { rows } = await pool.query(query, params);
  res.json({
    data: rows,
    nextCursor: rows.length === Number(limit)
      ? `${rows[rows.length - 1].created_at.toISOString()}:${rows[rows.length - 1].id}`
      : null,
  });
});
```

Three details that make this actually work:

- **The tiebreaker is mandatory.** `created_at` alone isn't unique — two rows sharing a timestamp on a page boundary would be skipped or repeated. Appending the primary key makes the sort key total.
- **Index must match the sort:** `CREATE INDEX ON products (created_at DESC, id DESC);`
- **Cast the cursor params.** Without `$1::timestamptz` the row comparison can be typed as `text` and compare lexically.

**Key point:** OFFSET is O(offset) — the DB must fetch and discard every skipped row. Cursor pagination is O(log n) to seek plus O(limit) to read, so page 10,000 costs the same as page 1.

**Tradeoff:** cursors can't jump to an arbitrary page number, so they suit infinite scroll rather than numbered pagination. They're also *more* correct: with OFFSET, a row inserted while the user pages through shifts everything, causing duplicates and skips.

---

## Q9: What is a materialized view and when do you use it?

**Answer:** A materialized view stores query results physically on disk.

```sql
-- Create
CREATE MATERIALIZED VIEW mv_user_stats AS
SELECT user_id,
       count(order_id) as total_orders,
       sum(total) as total_spent,
       max(order_date) as last_order_date
FROM orders
GROUP BY user_id;

-- A UNIQUE index is REQUIRED for CONCURRENTLY refresh (see below)
CREATE UNIQUE INDEX idx_mv_user_stats ON mv_user_stats (user_id);

-- Refresh (manually or on schedule)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_stats;

-- Query the materialized view instead of the expensive join
SELECT * FROM mv_user_stats WHERE user_id = 1;
```

**Use when:**
- Expensive aggregations queried frequently
- Data can be slightly stale (refreshed periodically)
- Dashboard analytics, reporting

**Refresh strategies:**
- Manual: `REFRESH MATERIALIZED VIEW`
- Scheduled: pg_cron extension, or a Node cron job
- Trigger-based: refresh on related table changes (usually a bad idea — see below)

**The `CONCURRENTLY` gotcha:** a plain `REFRESH MATERIALIZED VIEW` takes an `ACCESS EXCLUSIVE` lock, so **all reads block until it completes**. On a dashboard view that takes 30 seconds to rebuild, that's a 30-second outage. `CONCURRENTLY` avoids the lock — but it requires a unique index on the view and is slower overall, since it builds the new version and diffs it.

**Limitations to mention:**
- A materialized view is **never incrementally updated** — every refresh recomputes the entire query. If the base table has 500M rows, refreshing hourly may not be viable; use a rollup table updated by triggers or a batch job instead.
- The data is stale by definition. Don't use one where correctness depends on freshness (account balances, inventory).
- Not replicated to standbys as a view — the *contents* are replicated, but refreshes only happen on the primary.

---

## Q10: How does VACUUM affect performance?

**Answer:** PostgreSQL uses MVCC. Deleted/updated rows are not physically removed — they become dead tuples. VACUUM reclaims this space.

```sql
-- Check for bloat
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1)) as dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC;

-- Manual vacuum
VACUUM ANALYZE orders;

-- AutoVacuum runs automatically (check settings)
SHOW autovacuum;
SHOW autovacuum_vacuum_threshold;
SHOW autovacuum_analyze_threshold;
```

**Key point:** If dead tuples exceed 20% of live tuples, performance degrades. Ensure autovacuum is configured properly for your workload.
