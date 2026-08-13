# ADVANCED PATTERN 1: INDEXING STRATEGIES

An index is a trade: faster reads, slower writes, more disk. Getting it right means understanding which structure fits which query pattern. Getting it wrong means paying the write penalty for nothing.

## THE SHORT VERSION

| Query pattern | Index type | Why |
|---|---|---|
| Equality, range, sorting | B-tree | Default, handles `< <= = >= >`, multicolumn |
| JSONB containment, arrays, full-text | GIN | Inverted index -- one entry per element |
| Range types, geometric, nearest-neighbor | GiST | Generalized search tree, extensible |
| Huge tables with natural ordering | BRIN | Summaries per block range, tiny footprint |
| Multi-column equality, no range | Bloom (extension) | Hash-based, no correlation needed |
| Only index a fraction of rows | Partial | `WHERE` predicate on the index itself |
| Few columns, no heap lookups | Covering (`INCLUDE`) | Index-only scans |
| Query uses an expression | Expression | Index the computed value directly |

---

## B-TREE: THE DEFAULT

B-tree is the index type you get when you just write `CREATE INDEX`. It handles the most common operations: equality, range comparisons, and sorting.

### WHY IT MATTERS

Every `WHERE col = ?`, `WHERE col > ?`, `ORDER BY col`, and `DISTINCT col` starts here. B-tree indexes support `< <= = >= >`, `BETWEEN`, `IN`, `IS NULL`, `IS NOT NULL`, and prefix-anchored `LIKE`/`~` patterns.

### NULL HANDLING

B-tree indexes **include** NULL values by default. NULLs sort before all other values in ascending order (after all values in descending order). `IS NULL` and `IS NOT NULL` queries **can** use B-tree indexes.

```sql
create index idx_orders_ref on orders (ref);

-- All three can use the index:
select * from orders where ref = 'ABC-123';
select * from orders where ref is null;
select * from orders where ref is not null;

-- NULLs sort first in ASC, last in DESC -- use nulls_first/nulls_last to control
create index idx_orders_ref_asc_nulls_last on orders (ref asc nulls last);
```

### WHEN TO USE IT

Almost always. B-tree is the right answer for:
- Primary keys and foreign keys
- Any column used in equality or range comparisons
- Columns in `ORDER BY` or `GROUP BY`
- Columns with moderate cardinality (not a single repeated value, not every row unique)

### HOW TO IMPLEMENT IT

```sql
-- Single column (the default)
create index idx_users_email on users (email);

-- Descending order -- matches ORDER BY col DESC without a sort step
create index idx_orders_created_desc on orders (created_at desc);

-- Multicolumn: column order matters
create index idx_orders_status_date on orders (status, created_at desc);

-- Nulls control: nulls_first / nulls_last match the sort direction
create index idx_scores_value on scores (value desc nulls last);

-- Pattern matching: supports LIKE 'prefix%' in non-C locales
create index idx_names_last on users (last_name varchar_pattern_ops);
```

### MULTICOLUMN ORDERING

The leftmost-column rule is the most important concept in multicolumn indexing:

```
Index on (a, b, c) can efficiently serve:

  WHERE a = 1                          -- uses a
  WHERE a = 1 AND b = 2               -- uses a, b
  WHERE a = 1 AND b > 2               -- uses a, b (range on b)
  WHERE a = 1 AND c = 3               -- uses a (c is skipped, but still filtered)
  WHERE b = 2                         -- NO -- b is not the leading column
  WHERE c = 3                         -- NO
```

```
    B-tree leaf page for (a, b, c):
    +---+---+---+--------+
    | a | b | c | ctid   |
    +---+---+---+--------+
    | 1 | 2 | 5 | (10,3) |
    | 1 | 2 | 8 | (10,7) |
    | 1 | 5 | 1 | (11,2) |
    | 2 | 1 | 3 | (12,1) |
    +---+---+---+--------+
    Sorted by a first, then b, then c.
    WHERE a = 1 jumps straight to the first row with a=1.
    WHERE b = 2 must scan the entire index.
```

### OPERATOR CLASSES

The default operator class uses the locale's collation for text comparisons. For `LIKE 'prefix%'` to use the index, you need `varchar_pattern_ops`:

```sql
-- Default index: sorted by locale collation, LIKE 'x%' won't use it
create index idx_name on products (name);

-- Pattern_ops index: byte-order sort, LIKE 'x%' works
create index idx_name_pattern on products (name varchar_pattern_ops);

-- C locale: the default index already supports pattern matching
-- (set LC_COLLATE = 'C' at database creation time)
```

### COMMON MISTAKES

- **Reversing column order** in a multicolumn index. `(status, created_at)` serves `WHERE status = ? AND created_at > ?`. `(created_at, status)` does not.
- **Indexing low-cardinality columns** alone. A column with 3 distinct values across 10 million rows will rarely benefit from a B-tree -- the planner will prefer a sequential scan.
- **Creating a separate index per column** when a single multicolumn index serves both queries. `(a, b)` serves queries on `a` alone and on `a + b`. Two separate indexes double the write cost.
- **Forgetting the locale issue** with `LIKE`. In a non-C locale, `LIKE 'prefix%'` will not use a default B-tree index.

---

## GIN: INVERTED INDEXES

GIN (Generalized Inverted Index) indexes composite values by creating a separate entry for each component value. Think of it as a book index: each keyword points to the pages where it appears.

### WHY IT MATTERS

GIN is the only built-in index type that efficiently handles:
- JSONB containment (`@>`) and existence checks (`?`, `?|`, `?&`)
- Array containment (`@>`), intersection (`&&`), and subset (`<@`)
- Full-text search (`@@` with `tsvector`/`tsquery`)

### WHEN TO USE IT

- JSONB columns queried with `@>`, `?`, `?|`, `?&`
- Array columns queried with `&&`, `@>`, `<@`
- Full-text search on `tsvector` columns
- When a single row's value contains multiple searchable elements

### HOW TO IMPLEMENT IT

```sql
-- JSONB containment (default operator class)
create index idx_events_data on events using gin (data);
-- Serves: WHERE data @> '{"type": "click"}'
-- Serves: WHERE data ? 'user_id'

-- JSONB path ops -- faster for @> and @? only, smaller index
create index idx_events_data_path on events using gin (data jsonb_path_ops);
-- Serves: WHERE data @> '{"type": "click"}'
-- Does NOT serve: WHERE data ? 'user_id'

-- Array containment
create index idx_products_tags on products using gin (tags);
-- Serves: WHERE tags && ARRAY['sale', 'new']
-- Serves: WHERE tags @> ARRAY['sale']

-- Full-text search with a generated column (PG 12+)
alter table articles add column search_vec tsvector
  generated always as (to_tsvector('english', body)) stored;
create index idx_articles_fts on articles using gin (search_vec);
-- Serves: WHERE search_vec @@ to_tsquery('english', 'database & optimization')
```

### GIN INTERNALS

```
    GIN structure for tags = {red, blue, sale}:

    Key tree (B-tree over keys):
    +--------+----------------+
    | Key    | Posting list   |
    +--------+----------------+
    | blue   | -> (5,1)       |  row 5, version 1
    | red    | -> (3,1),(5,1) |  rows 3 and 5
    | sale   | -> (5,1)       |  row 5
    +--------+----------------+

    Query: WHERE tags && ARRAY['red', 'sale']
    -> Look up 'red' -> get row IDs {3, 5}
    -> Look up 'sale' -> get row IDs {5}
    -> Union: {3, 5}
```

### FAST UPDATE

GIN uses a pending list by default. New entries go into an unsorted pending list, then get merged during vacuum. This makes inserts fast but queries slightly slower when the pending list is large.

```sql
-- Disable fast update for consistent read performance
create index idx_events_data on events using gin (data)
  (fastupdate = off);

-- Tune the pending list size
alter index idx_events_data set (fastupdate = on, pending_list_limit = 64);
```

### COMMON MISTAKES

- **Using `jsonb_ops` when you only need `@>` and `@?`.** `jsonb_path_ops` is smaller and faster for containment queries. Use `jsonb_ops` only when you also need `?`, `?|`, `?&`.
- **Not tuning `maintenance_work_mem` for GIN creation.** GIN build time is highly sensitive to this setting. Set it higher for large indexes:

  ```sql
  set maintenance_work_mem = '1GB';
  create index ...;
  ```

- **Forgetting about the pending list.** After a bulk load, run `VACUUM` or `gin_clean_pending_list()` to merge pending entries and restore query performance.
- **Using GIN for index-only scans.** GIN does not support index-only scans -- each entry holds only part of the original value.

---

## GiST: GENERALIZED SEARCH TREE

GiST is an infrastructure, not a single algorithm. It supports range types, geometric operations, nearest-neighbor searches, and custom operator classes.

### WHY IT MATTERS

GiST is the only built-in index type that efficiently handles:
- Range overlap (`&&`), containment (`@>`, `<@`), and adjacency (`-|-`)
- Geometric operations: `@` (contains), `&&` (overlaps), `<->` (distance)
- Nearest-neighbor searches with `<->` (distance-based ordering)
- Custom operator classes via extensions (e.g., trigram, cube, h3)

### WHEN TO USE IT

- Range columns (`int4range`, `numrange`, `tsrange`, `daterange`, etc.)
- Geometric columns (`point`, `circle`, `polygon`, `box`, `lseg`, `path`)
- `inet`/`cidr` containment queries
- Nearest-neighbor on `point` or `cube` columns
- trigram similarity (`%` operator from `pg_trgm` extension)

### HOW TO IMPLEMENT IT

```sql
-- Range overlap
create index idx_bookings_range on bookings using gist (date_range);
-- Serves: WHERE date_range && '["2024-01-01", "2024-03-01"]'::daterange
-- Serves: WHERE date_range @> '2024-02-15'::date

-- Geometric: nearest-neighbor
create index idx_stores_location on stores using gist (location);
-- Serves: WHERE location && 'BOX((0,0),(10,10))'::box
-- Nearest: ORDER BY location <-> '(-73.99,40.74)'::point LIMIT 10

-- Network address containment
create index idx_vpn_ranges on vpn_assignments using gist (subnet);
-- Serves: WHERE subnet @> '10.0.1.5'::inet

-- Trigram similarity (requires extension)
create extension if not exists pg_trgm;
create index idx_names_trgm on users using gist (name gist_trgm_ops);
-- Serves: WHERE name % 'smith'          (similarity)
-- Serves: WHERE name <-> 'smith' < 0.3  (distance)
```

### COMMON MISTAKES

- **Using GiST for equality.** GiST is overkill for `=`. A B-tree is smaller and faster for point lookups.
- **Forgetting `LIMIT` on nearest-neighbor.** `ORDER BY col <-> point` without `LIMIT` forces a full scan. The `<->` operator requires a bounded search to be efficient.
- **Not using the right operator class.** The default GiST class for `text` doesn't exist. You need `gist_trgm_ops` from `pg_trgm`.

---

## BRIN: BLOCK RANGE INDEX

BRIN (Block Range Index) stores summaries of value ranges per group of heap pages. It's tiny but only works when the data is physically ordered.

### WHY IT MATTERS

BRIN indexes are orders of magnitude smaller than B-tree indexes on large tables. A 100 million row table might have a 1 MB BRIN index versus a 4 GB B-tree. The trade-off: the column must correlate with physical row order.

### WHEN TO USE IT

- Large tables where data is naturally ordered by insertion time
- Time-series data with `created_at` columns
- Partitioned tables where each partition is time-ordered
- Columns with gradual value progression across the table

### HOW TO IMPLEMENT IT

```sql
-- Default: 128 pages per range (adjustable)
create index idx_events_time on events using brin (created_at);

-- Smaller ranges = more accurate, larger index
create index idx_events_time_fine on events using brin (created_at)
  with (pages_per_range = 32);

-- Larger ranges = smaller index, less accurate
create index idx_events_time_coarse on events using brin (created_at)
  with (pages_per_range = 256);

-- Multicolumn BRIN
create index idx_events_time_type on events using brin (created_at, type);
```

### BRIN INTERNALS

```
    BRIN structure for created_at (pages_per_range = 128):

    +-----------+---------------------+---------------------+
    | Range     | Min created_at      | Max created_at      |
    +-----------+---------------------+---------------------+
    | Pages 1-128   | 2024-01-01 00:00   | 2024-01-01 23:59   |
    | Pages 129-256 | 2024-01-02 00:00   | 2024-01-02 23:59   |
    | Pages 257-384 | 2024-01-03 00:00   | 2024-01-03 23:59   |
    +-----------+---------------------+---------------------+

    Query: WHERE created_at = '2024-01-02 12:00'
    -> Only pages 129-256 can contain this value -> scan only those pages
    -> If data is well-ordered, this is nearly as good as a B-tree
    -> If data is random, this is nearly useless
```

### TUNING `pages_per_range`

| pages_per_range | Index size | Accuracy | Best for |
|---|---|---|---|
| 1-32 | Larger | High | Highly selective queries |
| 64-128 | Medium | Good | Default, balanced |
| 256-1024 | Small | Low | Broad range scans |

```sql
-- Check BRIN correlation (1.0 = perfect, 0.0 = random)
select indexrelname, correlation
from pg_stat_user_indexes
where indexrelname = 'idx_events_time';

-- Rebuild with autovacuum summary update
create index CONCURRENTLY idx_events_time on events using brin (created_at)
  with (pages_per_range = 64, autosummarize = on);
```

### COMMON MISTAKES

- **Using BRIN on random data.** If `created_at` doesn't correlate with physical order, BRIN will scan almost the entire table. Check `pg_stat_user_indexes.correlation` first.
- **Expecting BRIN to match B-tree precision.** BRIN is approximate. It excludes page ranges that can't contain the value, but may include pages that don't.
- **Forgetting to rebuild after bulk loads.** BRIN summaries are built incrementally. After a large `COPY` or `INSERT`, rebuild or run `brin_summarize_new_values()`.

---

## BLOOM INDEX

Bloom indexes are hash-based indexes for multi-column equality queries. They require an extension and have no leftmost-prefix requirement.

### WHY IT MATTERS

Unlike B-tree multicolumn indexes, Bloom indexes don't enforce column order. Every column in the index is equally searchable, making them ideal for queries that filter on different column combinations.

### WHEN TO USE IT

- Queries with varying column combinations (sometimes `WHERE a = ? AND b = ?`, sometimes `WHERE b = ? AND c = ?`)
- Low-to-medium cardinality columns where B-tree selectivity is poor
- Equality-only workloads (no range or sorting)

### HOW TO IMPLEMENT IT

```sql
create extension if not exists bloom;

-- Create bloom index
create index idx_products_bloom on products using bloom (category, brand, color, size);

-- All of these can use the index (no leftmost prefix needed):
select * from products where category = 'electronics';
select * from products where brand = 'Nike';
select * from products where color = 'red' AND size = 'M';
select * from products where category = 'shoes' AND color = 'blue';
```

### TUNING

```sql
-- Default length = 32 bytes (adjustable)
-- Higher length = more selective, larger index, slower writes
create index idx_products_bloom on products using bloom (category, brand, color, size)
  with (length = 64);

-- length values: 1 to 8191 bytes
-- Start with 32, increase if selectivity is too low
```

### COMMON MISTAKES

- **Using Bloom for range queries.** Bloom only supports `=`. For range operations, use B-tree.
- **Setting `length` too high.** A very large `length` increases index size and write cost without proportional query benefit. Start at 32, tune from there.
- **Using Bloom on high-cardinality single columns.** A B-tree is better for `WHERE id = ?` on a unique or near-unique column. Bloom shines on multi-column equality combinations.

---

## PARTIAL INDEXES

A partial index includes only rows matching a `WHERE` predicate. It's smaller, faster to maintain, and can serve queries that the planner matches to the predicate.

### WHY IT MATTERS

Partial indexes reduce index size, write overhead, and memory footprint by indexing only the rows you actually query.

### WHEN TO USE IT

- A small fraction of rows match the query (e.g., `WHERE status = 'active'` when 95% are inactive)
- You never query a certain subset (e.g., deleted rows, archived records)
- You want a unique constraint on a nullable column

### HOW TO IMPLEMENT IT

```sql
-- Only index active orders (avoids indexing the 90% that are closed)
create index idx_orders_active on orders (created_at desc)
  where status = 'active';

-- Only index non-null values
create index idx_users_ref on users (ref)
  where ref is not null;

-- Range-based: use a fixed cutoff because index predicates must be immutable.
-- Replace this index periodically if the cutoff needs to move forward.
create index idx_logs_since_2026 on logs (created_at)
  where created_at >= date '2026-01-01';

-- Unique constraint on nullable column
create unique index idx_users_email_active on users (email)
  where deleted_at is null;
```

### PLANNER MATCHING

The query's `WHERE` clause must imply the index predicate. The planner is strict:

```sql
-- Index: WHERE status = 'active'

-- USES the index:
select * from orders where status = 'active' and created_at > '2024-01-01';

-- USES the index (broader WHERE implies the predicate):
select * from orders where status = 'active';

-- DOES NOT use the index (different value):
select * from orders where status = 'pending' and created_at > '2024-01-01';

-- DOES NOT use the index (missing predicate column):
select * from orders where created_at > '2024-01-01';
```

### COMMON MISTAKES

- **Query doesn't match the predicate.** The query must include the predicate condition (or a condition that implies it). `WHERE status IN ('active', 'pending')` won't use an index on `WHERE status = 'active'`.
- **Overlapping partial indexes.** Two partial indexes whose predicates overlap can confuse the planner. Keep predicates mutually exclusive.
- **Forgetting to update the predicate.** If your data distribution changes (e.g., "active" grows from 10% to 60%), the partial index loses its advantage.

---

## COVERING INDEXES

Covering indexes (via `INCLUDE`) store non-key columns in the index leaf, enabling Index-Only Scans where the planner never touches the heap.

### WHY IT MATTERS

Index-Only Scans eliminate random I/O to the heap. For queries that read a few columns from many rows, this can be 10x faster than a B-tree scan + heap fetch.

### WHEN TO USE IT

- Queries that SELECT a small subset of columns
- Wide tables where heap pages are expensive to read
- Read-heavy workloads where a few columns dominate the query patterns

### HOW TO IMPLEMENT IT

```sql
-- Key columns for filtering/sorting, INCLUDE for projection
create index idx_orders_covering on orders (status, created_at desc)
  include (customer_id, total, shipping_address);

-- Query uses index-only scan -- no heap access:
select customer_id, total, shipping_address
from orders
where status = 'shipped'
  and created_at > '2024-01-01'
order by created_at desc;

-- Multiple INCLUDE columns (PG 11+)
create index idx_users_covering on users (email)
  include (first_name, last_name, avatar_url, settings);

-- Expressions must be key columns; INCLUDE accepts plain columns only
create index idx_products_covering on products
  (category, (jsonb_extract_path_text(metadata, 'display_name')))
  include (id, price);
```

### VISUAL

```
    B-tree leaf (status, created_at) INCLUDE (customer_id, total):

    +--------+----------------+-------------+-------+
    | status | created_at     | customer_id | total |  <- all in the index
    +--------+----------------+-------------+-------+
    | shipped| 2024-03-15     | 42          | 99.99 |
    | shipped| 2024-03-14     | 17          | 250.00|
    | pending| 2024-03-15     | 8           | 45.00 |
    +--------+----------------+-------------+-------+

    Query: SELECT customer_id, total WHERE status = 'shipped'
    -> All needed data is in the index -> Index-Only Scan
    -> No heap lookup required
```

### VACUUM AND VISIBILITY MAP

Index-Only Scans require the visibility map to be up to date. If a tuple was recently updated, the planner falls back to a regular index scan.

```sql
-- Check visibility map coverage
select
  relname,
  n_live_tup,
  n_dead_tup,
  last_vacuum,
  last_autovacuum
from pg_stat_user_tables
where relname = 'orders';

-- After heavy updates, VACUUM to restore index-only scan eligibility
vacuum analyze orders;
```

### COMMON MISTAKES

- **Including too many columns.** Each INCLUDE column adds to index size and write cost. Only include columns that appear in the SELECT list of your target queries.
- **Ignoring the visibility map.** After bulk updates, covering indexes may not be used until vacuum runs. Monitor with `EXPLAIN (ANALYZE, BUFFERS)`.
- **Including key columns in INCLUDE.** Columns used for filtering/sorting must be key columns, not INCLUDE columns. INCLUDE is for projection only.

---

## EXPRESSION INDEXES

An expression index stores the result of a function or expression, enabling fast lookups on computed values.

### WHY IT MATTERS

If your queries consistently use a function or expression, indexing the raw column doesn't help. Indexing the expression does.

### WHEN TO USE IT

- Case-insensitive lookups (`lower(col) = ?`)
- Math expressions (`col1 / col2 > ?`, `col * 2 = ?`)
- JSONB path extraction (`data->>'key' = ?`)
- Regular expression matching (`col ~ '^[A-Z]{3}'`)
- Generated columns that aren't materialized

### HOW TO IMPLEMENT IT

```sql
-- Case-insensitive search
create index idx_users_email_lower on users (lower(email));
-- Serves: WHERE lower(email) = 'user@example.com'

-- JSONB extraction
create index idx_events_type on events ((data->>'event_type'));
-- Serves: WHERE data->>'event_type' = 'click'

-- Mathematical expression
create index idx_items_discounted on inventory ((price * (1 - discount)));
-- Serves: WHERE price * (1 - discount) < 50.00

-- Trigram expression (alternative to GiST trigram)
create extension if not exists pg_trgm;
create index idx_names_trgm_btree on users (lower(name) text_pattern_ops);
-- Serves: WHERE lower(name) LIKE 'smith%'

-- CAST expression
create index idx_amounts_int on transactions ((amount::int));
-- Serves: WHERE amount::int = 100
```

### UNIQUE CONSTRAINTS ON EXPRESSIONS

```sql
-- Unique on a case-insensitive value
create unique index idx_users_lower_email on users (lower(email));

-- Unique on extracted JSONB field
create unique index idx_items_sku on inventory ((data->>'sku'));
```

### FUNCTION IMMUTABILITY

Expression indexes require the function to be `IMMUTABLE` or `STABLE`.

```sql
-- Works: IMMUTABLE
create index idx on t (lower(col));
create index idx on t (col::int);
create index idx on t (col->>'key');

-- Does NOT work: VOLATILE
create index idx on t (now());        -- error
create index idx on t (random());     -- error
create index idx on t (col @> now()); -- error (now() is volatile)
```

### COMMON MISTAKES

- **Query doesn't match the expression exactly.** `WHERE lower(email) = 'x'` uses the index. `WHERE email ILIKE 'x'` does not (the planner doesn't rewrite `ILIKE` to `lower()` automatically).
- **Indexing volatile functions.** Only `IMMUTABLE` and `STABLE` functions can be indexed.
- **Forgetting the parentheses.** Index expressions require parentheses: `((data->>'key'))`, not `(data->>'key')`.

---

## KEY TAKEAWAYS

| Decision | Rule |
|---|---|
| Default index type | B-tree -- it handles equality, range, and sort |
| JSONB, arrays, full-text | GIN -- inverted index, one entry per element |
| Ranges, geometry, nearest-neighbor | GiST -- extensible search tree |
| Massive ordered tables | BRIN -- tiny footprint, requires physical order |
| Multi-column equality, no order | Bloom -- hash-based, no leftmost prefix |
| Only a fraction of rows | Partial -- `WHERE` on the index itself |
| Few columns, no heap lookups | Covering (`INCLUDE`) -- index-only scans |
| Query uses a function | Expression -- index the computed value |
| B-tree and NULLs | B-tree includes NULLs; `IS NULL` can use the index |
| Multicolumn B-tree | Leftmost-column rule -- leading column must be in the query |

### INDEX SELECTION CHECKLIST

1. **What operators does the query use?** Equality -> B-tree or Bloom. Containment -> GIN. Overlap/range -> GiST.
2. **How selective is the filter?** Low selectivity (< 5% of rows) -> B-tree or Partial. High selectivity -> consider BRIN.
3. **Which columns are in SELECT?** If few columns, add `INCLUDE` for index-only scans.
4. **Is the column expression-based?** Index the expression, not the raw column.
5. **What's the write:read ratio?** Heavy writes -> fewer indexes, smaller indexes (BRIN, Partial). Heavy reads -> more indexes, covering indexes.
6. **Check with `EXPLAIN (ANALYZE, BUFFERS)`.** Theory is a starting point. Actual execution plans are the answer.
