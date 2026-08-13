# PostgreSQL Views and Materialized Views

## Table of Contents

1. [Regular Views](#regular-views)
2. [View Inheritance and Schema Design](#view-inheritance-and-schema-design)
3. [Updatable Views](#updatable-views)
4. [Materialized Views](#materialized-views)
5. [Refresh Strategies](#refresh-strategies)
6. [Indexes on Materialized Views](#indexes-on-materialized-views)
7. [Concurrent Refresh](#concurrent-refresh)
8. [When to Use Each](#when-to-use-each)
9. [Performance Tradeoffs](#performance-tradeoffs)
10. [Gotchas](#gotchas)
11. [Key Takeaways](#key-takeaways)

---

## Regular Views

A view is a stored query that presents data from one or more tables as if it were a table itself. PostgreSQL does not store view data; it re-executes the underlying query each time the view is accessed.

### Definition

```sql
CREATE VIEW v_active_orders AS
SELECT
    o.order_id,
    o.order_date,
    c.customer_name,
    o.total_amount
FROM orders o
JOIN customers c USING (customer_id)
WHERE o.status = 'active';
```

Every `SELECT * FROM v_active_orders` runs the full query against `orders` and `customers` in real time.

### Use Cases

- **Abstraction**: Hide complex joins, window functions, or conditional logic behind a simple interface.
- **Access control**: Grant `SELECT` on a view that filters sensitive columns or rows, without granting table-level permissions.
- **Schema stability**: When upstream tables change, update the view definition instead of rewriting application queries.
- **Polymorphism**: Union multiple related tables under one logical interface.

```sql
-- Unified interface over partitioned-like tables
CREATE VIEW v_all_events AS
SELECT *, 'web' AS source FROM web_events
UNION ALL
SELECT *, 'mobile' AS source FROM mobile_events
UNION ALL
SELECT *, 'api' AS source FROM api_events;
```

### Limitations

- No independent indexes; the planner pushes predicates into the underlying query.
- `CHECK OPTION` on views is enforced but can be expensive with deep view chains.
- Recursive view chains (view A references view B references view A) are not allowed.
- Views do not accelerate queries by themselves; they are purely logical.
- Some DDL operations on underlying tables (e.g., `ALTER TABLE ... DROP COLUMN`) can break dependent views.

---

## View Inheritance and Schema Design

Views can reference other views, forming a dependency chain. PostgreSQL tracks these dependencies via `pg_depend`.

```
  Table: orders       Table: customers
       |                    |
       +--------+-----------+
                |
      View: v_order_details
                |
      View: v_customer_order_summary
                |
      View: v_dashboard_metrics
```

```sql
-- Layer 1: base view
CREATE VIEW v_order_details AS
SELECT
    o.order_id,
    c.customer_name,
    c.region,
    o.total_amount,
    o.order_date
FROM orders o
JOIN customers c USING (customer_id);

-- Layer 2: aggregation view
CREATE VIEW v_customer_order_summary AS
SELECT
    customer_name,
    region,
    COUNT(*) AS order_count,
    SUM(total_amount) AS revenue,
    AVG(total_amount) AS avg_order_value
FROM v_order_details
GROUP BY customer_name, region;

-- Layer 3: dashboard view
CREATE VIEW v_dashboard_metrics AS
SELECT
    region,
    SUM(revenue) AS total_revenue,
    AVG(avg_order_value) AS avg_order_value,
    SUM(order_count) AS total_orders
FROM v_customer_order_summary
GROUP BY region;
```

### Dependency Inspection

```sql
-- Find all views depending on a table
SELECT
    c.relname AS view_name,
    d.refobjid,
    ct.relname AS depends_on_table
FROM pg_depend d
JOIN pg_class c ON d.objid = c.oid
JOIN pg_class ct ON d.refobjid = ct.oid
WHERE c.relkind = 'v'
  AND ct.relname = 'orders';
```

### Design Guidelines

- Keep view chains shallow (2-3 layers max) to avoid planning overhead.
- Document the purpose of each layer.
- Use `CREATE OR REPLACE VIEW` during development to avoid dropping dependent objects.

---

## Updatable Views

By default, simple views are updatable. PostgreSQL can translate `INSERT`, `UPDATE`, and `DELETE` on the view back to the underlying table.

### Rules for Automatic Updatability

A view is automatically updatable when it:

1. References exactly one base table in the `FROM` clause.
2. Contains no `DISTINCT`, `GROUP BY`, `HAVING`, `LIMIT`, `OFFSET`, set operations, or aggregate functions.
3. Has no expressions in the `SELECT` list that are not simple column references.

```sql
-- Updatable view
CREATE VIEW v_eu_customers AS
SELECT customer_id, customer_name, email, region
FROM customers
WHERE region = 'EU';

-- These all work
UPDATE v_eu_customers SET email = 'new@example.com' WHERE customer_id = 1;
INSERT INTO v_eu_customers (customer_id, customer_name, email, region)
VALUES (999, 'Test Corp', 'test@example.com', 'EU');
DELETE FROM v_eu_customers WHERE customer_id = 999;
```

### INSTEAD OF Triggers for Complex Views

When a view is not automatically updatable (joins, aggregates, expressions), use `INSTEAD OF` triggers.

```sql
CREATE VIEW v_order_with_status AS
SELECT
    o.order_id,
    o.customer_id,
    c.customer_name,
    o.status,
    o.total_amount
FROM orders o
JOIN customers c USING (customer_id);

-- This view is NOT automatically updatable due to the JOIN.
-- Add an INSTEAD OF trigger:

CREATE OR REPLACE FUNCTION fn_update_order_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE orders
    SET status = NEW.status,
        total_amount = NEW.total_amount
    WHERE order_id = NEW.order_id
    RETURNING * INTO NEW;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_order_status
INSTEAD OF UPDATE ON v_order_with_status
FOR EACH ROW
EXECUTE FUNCTION fn_update_order_status();
```

### CHECK OPTION

Enforces that inserted or updated rows satisfy the view's `WHERE` clause.

```sql
CREATE VIEW v_premium_customers AS
SELECT customer_id, customer_name, tier, spending
FROM customers
WHERE tier = 'premium'
WITH CHECK OPTION;

-- This fails: violates CHECK OPTION
INSERT INTO v_premium_customers (customer_id, customer_name, tier, spending)
VALUES (100, 'Low Tier', 'basic', 50);
-- ERROR: new row violates check option for view "v_premium_customers"
```

---

## Materialized Views

A materialized view stores the result of a query on disk. Subsequent reads access the stored data rather than re-executing the query.

### Creation

```sql
CREATE MATERIALIZED VIEW mv_monthly_sales AS
SELECT
    DATE_TRUNC('month', o.order_date) AS sale_month,
    c.region,
    COUNT(*) AS order_count,
    SUM(o.total_amount) AS revenue,
    AVG(o.total_amount) AS avg_order,
    COUNT(DISTINCT c.customer_id) AS unique_customers
FROM orders o
JOIN customers c USING (customer_id)
GROUP BY DATE_TRUNC('month', o.order_date), c.region;
```

The query runs once at creation time. The data is persisted in the tablespace.

### Key Differences from Regular Views

| Aspect | Regular View | Materialized View |
|---|---|---|
| Storage | None (logical only) | Physical data on disk |
| Freshness | Always current | Stale until refreshed |
| Refresh cost | Zero (no refresh) | Full or incremental rebuild |
| Index support | No | Yes |
| Concurrent refresh | N/A | Yes (with unique index) |
| Planning | Inlined into parent query | Scanned as a table |

---

## Refresh Strategies

### Full Refresh

Rebuilds the entire materialized view from scratch.

```sql
REFRESH MATERIALIZED VIEW mv_monthly_sales;
```

This locks the view against reads during refresh (unless `CONCURRENTLY` is used).

### Scheduled Refresh via pg_cron

```sql
-- Install pg_cron extension first: CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Refresh every 15 minutes
SELECT cron.schedule(
    'refresh-monthly-sales',
    '*/15 * * * *',
    'REFRESH MATERIALIZED VIEW mv_monthly_sales'
);

-- Refresh at 2 AM daily
SELECT cron.schedule(
    'refresh-daily-summary',
    '0 2 * * *',
    'REFRESH MATERIALIZED VIEW mv_daily_summary'
);
```

### Event-Driven Refresh via Triggers

```sql
-- Triggers run before their transaction commits, so enqueue a refresh request.
-- A separate worker can see this row only after commit and then run
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_sales.
CREATE TABLE materialized_view_refresh_queue (
    view_name TEXT PRIMARY KEY,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION fn_request_mv_sales_refresh()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO materialized_view_refresh_queue (view_name)
    VALUES ('mv_monthly_sales')
    ON CONFLICT (view_name) DO UPDATE
    SET requested_at = EXCLUDED.requested_at;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_request_sales_mv_refresh
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR STATEMENT
EXECUTE FUNCTION fn_request_mv_sales_refresh();
```

The worker reads `requested_at`, refreshes the view after the source transaction commits, and then deletes the request only if its timestamp is unchanged:

```sql
DELETE FROM materialized_view_refresh_queue
WHERE view_name = 'mv_monthly_sales'
  AND requested_at = $1; -- timestamp read before the refresh
```

If another source transaction updates the request during the refresh, the timestamp changes and the row remains queued for another pass. The worker should also retry refresh failures.

### Staleness Tracking

```sql
-- No built-in staleness timestamp; add one manually
ALTER MATERIALIZED VIEW mv_monthly_sales
ADD COLUMN refreshed_at TIMESTAMPTZ DEFAULT now();

-- Or query pg_stat_user_tables
SELECT
    relname,
    last_vacuum,
    last_autovacuum,
    n_tup_ins AS tuples_inserted,
    n_live_tup AS live_tuples
FROM pg_stat_user_tables
WHERE relname = 'mv_monthly_sales';
```

---

## Indexes on Materialized Views

Unlike regular views, materialized views support indexes because they store actual data.

```sql
-- Primary-like unique index (required for CONCURRENTLY refresh)
CREATE UNIQUE INDEX idx_mv_sales_month_region
ON mv_monthly_sales (sale_month, region);

-- Supporting indexes for common query patterns
CREATE INDEX idx_mv_sales_region
ON mv_monthly_sales (region);

CREATE INDEX idx_mv_sales_month
ON mv_monthly_sales (sale_month DESC);

-- A partial-index cutoff must be fixed/immutable; replace the index periodically
CREATE INDEX idx_mv_sales_since_2026
ON mv_monthly_sales (sale_month, region)
WHERE sale_month >= DATE '2026-01-01';

-- Expression index
CREATE INDEX idx_mv_sales_quarter
ON mv_monthly_sales ((EXTRACT(QUARTER FROM sale_month)));
```

### Index Impact on Refresh

- `REFRESH MATERIALIZED VIEW` (non-concurrent): Drops and rebuilds all indexes. Slow for large views.
- `REFRESH MATERIALIZED VIEW CONCURRENTLY`: Preserves existing indexes. Uses a unique index to diff old vs new data.

---

## Concurrent Refresh

`REFRESH MATERIALIZED VIEW CONCURRENTLY` allows reads to continue during refresh.

### Requirements

- A unique index must exist on the materialized view (not necessarily unique across all columns; any unique index suffices).

```sql
CREATE UNIQUE INDEX idx_mv_sales_pk
ON mv_monthly_sales (sale_month, region);

-- Now concurrent refresh is possible
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_sales;
```

### How It Works

CONCURRENTLY refresh is **diff-based** — it applies changes incrementally without locking readers. It builds the new result set in a temporary workspace, diffs it against the existing data, and applies only the INSERTs, UPDATEs, and DELETEs needed to bring the live view up to date. This is **not** an atomic swap; a non-CONCURRENTLY refresh performs a full rebuild with an exclusive lock.

```
   Phase 1: Build new data in a temporary workspace
   Phase 2: Diff new data against existing data
   Phase 3: Apply INSERTs, UPDATEs, DELETEs incrementally

   During all phases, readers see consistent data.
```

### Tradeoffs

| Aspect | Regular Refresh | Concurrent Refresh |
|---|---|---|
| Read lock during refresh | Exclusive (blocks reads) | Shared (reads allowed) |
| Unique index required | No | Yes |
| Speed (small views) | Faster | Slightly slower |
| Speed (large views) | Very slow (rebuilds indexes) | Faster (incremental diff) |
| Disk space | Minimal extra | Needs ~2x space temporarily |

---

## When to Use Each

### Use a Regular View When

- The underlying data changes frequently and staleness is unacceptable.
- The query is simple enough that re-execution is cheap.
- You need row-level security abstraction without storage overhead.
- The result set is large but queries always filter to a small subset (predicates push down efficiently).
- You are building a logical schema layer for application code.

### Use a Materialized View When

- The query is expensive (multiple joins, aggregations, window functions).
- The data changes infrequently or can tolerate eventual consistency.
- The same aggregate result is read many more times than the source data changes.
- You need to index the result set for fast filtering and sorting.
- You are building a data warehouse or reporting layer.

### Decision Flow

```
  Is the query expensive?
  /                      \
 Yes                      No
  |                        |
 Can data be stale?      Use regular view
  |
 /        \
 Yes        No
  |          |
  |      Use regular view
  |
 Need indexed access?
  |
 /        \
 Yes        No
  |          |
  |      Materialized view
  |      (no indexes needed)
  |
 Use materialized view
 with indexes
```

---

## Performance Tradeoffs

### Storage Cost

```sql
-- Check materialized view size
SELECT
    pg_size_pretty(pg_total_relation_size('mv_monthly_sales')) AS total_size,
    pg_size_pretty(pg_relation_size('mv_monthly_sales')) AS data_size,
    pg_size_pretty(pg_indexes_size('mv_monthly_sales')) AS index_size;
```

Materialized views consume disk proportional to their result set. A view that aggregates 10M rows into 1K rows is cheap to store. A view that duplicates 50M rows with minor transformations is expensive.

### Refresh vs Query Latency

| Scenario | Regular View | Materialized View |
|---|---|---|
| Read after source change | Always reflects change (query time) | Stale until refresh |
| Read-only workload | Pays full query cost each time | Pays cost once at refresh |
| Write-heavy source | No refresh overhead | Refresh may contend with writes |
| Ad-hoc filtering | Predicates push down; efficient | Must scan materialized data; indexes help |

### Planner Behavior

With a regular view, the planner inlines the view definition and optimizes the combined query. With a materialized view, the planner treats it as a physical table and may or may not choose to use it depending on statistics.

```sql
-- Force the planner to consider a materialized view
ANALYZE mv_monthly_sales;

-- Check the plan
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM mv_monthly_sales
WHERE region = 'EU' AND sale_month >= '2025-01-01';
```

### Incremental Refresh via CONCURRENTLY

`REFRESH MATERIALIZED VIEW CONCURRENTLY` performs a diff-based incremental refresh: it compares the new result set against the existing data and applies only the differences. No tunable parameters control this behavior — it simply works when a unique index exists.

```sql
-- Correct syntax (no extra parameters)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_sales;
```

For true incremental view maintenance (auto-updating on source changes), third-party tools like `pg_ivm` fill this gap:

```sql
-- pg_ivm example (requires extension)
CREATE EXTENSION IF NOT EXISTS ivm;
CREATE LIVE VIEW lvm_sales AS
SELECT
    DATE_TRUNC('month', order_date) AS sale_month,
    COUNT(*) AS order_count,
    SUM(total_amount) AS revenue
FROM orders
GROUP BY DATE_TRUNC('month', order_date);
-- Updates incrementally as orders table changes
```

---

## Gotchas

### 1. Stale Data with No Warning

PostgreSQL does not mark materialized views as stale. There is no built-in flag. You must track staleness yourself.

```sql
-- Common pattern: add a refresh timestamp column
CREATE MATERIALIZED VIEW mv_report AS
SELECT
    ...,
    now() AS last_refreshed
FROM ...;
```

### 2. Refresh Locks Out Readers (Without CONCURRENTLY)

A standard `REFRESH MATERIALIZED VIEW` takes an exclusive lock. All reads block until refresh completes.

```sql
-- Check for blocking locks
SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.query AS blocked_query,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid;
```

### 3. CONCURRENTLY Requires a Unique Index

Forgetting the unique index is the most common error.

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_no_unique_idx;
-- ERROR: cannot refresh materialized view "mv_no_unique_idx" concurrently
-- HINT: First create a unique index on the materialized view.
```

### 4. Column Changes Break Materialized Views

`ALTER TABLE ... ADD COLUMN` on a source table does not propagate to views. For materialized views, you can add columns directly in **PostgreSQL 12+** using `ALTER MATERIALIZED VIEW ... ADD COLUMN`. The column is added as NULL for all existing rows; you must then `REFRESH` to populate it.

```sql
-- Source table gains a column
ALTER TABLE orders ADD COLUMN discount_pct NUMERIC;

-- Add the column to the materialized view (PostgreSQL 12+)
ALTER MATERIALIZED VIEW mv_monthly_sales ADD COLUMN avg_discount NUMERIC;

-- Refresh to populate the new column from the updated query
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_sales;
```

If the view's `SELECT` definition needs to change to include the new column, you must still drop and recreate.

### 5. Statistics Staleness

After a refresh, run `ANALYZE` to update planner statistics on the materialized view.

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_sales;
ANALYZE mv_monthly_sales;
```

### 6. Cascading Dependencies

Dropping a table that a materialized view depends on fails if the view still exists.

```sql
DROP TABLE orders;
-- ERROR: cannot drop table orders because materialized view mv_monthly_sales depends on it

DROP TABLE orders CASCADE;
-- This works but also drops the materialized view
```

### 7. Checksums and Replication

Materialized views are not replicated via logical replication because they are derived objects. Each replica must refresh its own copies.

---

## Key Takeaways

1. **Regular views are zero-cost abstractions**. They add no storage overhead and always return current data, but they do not improve query performance.

2. **Materialized views trade freshness for speed**. They store query results physically, enabling fast reads and indexing at the cost of potential staleness and storage.

3. **Always use `CONCURRENTLY` for production materialized views**. It requires a unique index but prevents read blocking during refresh.

4. **Index materialized views like tables**. The same indexing strategies apply: cover common query patterns, use partial indexes for filtered workloads, and monitor index bloat.

5. **Track staleness explicitly**. PostgreSQL provides no built-in staleness detection. Add a timestamp column or use an external tracking table.

6. **Keep view dependency chains shallow**. Deep chains of views referencing views increase planning time and make schema changes error-prone.

7. **Use `INSTEAD OF` triggers for complex updatable views**. When a view involves joins or expressions, PostgreSQL cannot auto-translate writes.

8. **Run `ANALYZE` after refreshing materialized views**. Stale planner statistics lead to suboptimal query plans on the refreshed data.

9. **Materialized views are not a substitute for partitioning**. For time-series data with high write volume, partitioning reduces table scans; materialized views reduce query complexity. Use both when appropriate.

10. **Test refresh duration in staging**. A materialized view that takes 30 seconds to refresh in development may take 30 minutes in production. Size your refresh strategy accordingly.
