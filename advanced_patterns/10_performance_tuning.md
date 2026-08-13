# PostgreSQL Performance Tuning & Connection Pooling

## Table of Contents

1. Key Configuration Parameters
2. Monitoring and Observability
3. Connection Pooling Strategies
4. Query Performance Patterns
5. Vacuum and Analyze Tuning
6. Index Maintenance
7. Gotchas
8. Key Takeaways

---

## 1. Key Configuration Parameters

### Memory Settings

The four memory parameters that matter most. Set them in `postgresql.conf`.

```
-- Rule of thumb: 25% of system RAM, minimum 128MB
shared_buffers = '4GB'

-- Per-worker memory for sorts, joins, hash operations
-- Start conservative; query-level EXPLAIN will reveal if you need more
work_mem = '64MB'

-- Memory for maintenance operations (VACUUM, CREATE INDEX, ALTER TABLE ADD FOREIGN KEY)
-- Typically 2-4x shared_buffers
maintenance_work_mem = '2GB'

-- Tells the planner how much OS disk cache is available
-- Set to ~75% of total RAM; not an allocation, just a hint to the planner
effective_cache_size = '12GB'
```

**How work_mem actually works:**

```
Session starts
|
+-- Query needs a sort?       allocates work_mem
|
+-- Query needs a hash join?  allocates another work_mem
|
+-- Subquery with a sort?     allocates yet another work_mem
|
Total memory = work_mem x (number of operations) x (number of concurrent sessions)
```

A single complex query with 3 sort operations and 1 hash join at `work_mem = 64MB` can consume 256MB in one session. With 100 concurrent sessions, that is 25GB.

### Disk I/O Cost Settings

```
-- Default: 4.0 (spinning disk)
-- SSD: 1.1 - 1.5
-- NVMe: 1.0 (sequential and random are roughly equal)
random_page_cost = 1.1

-- Default is 1.0; typically no change needed for SSDs
seq_page_cost = 1.0
```

After changing `random_page_cost`, always run `ANALYZE` so the planner recalculates cost estimates with the new value.

### max_connections

```
max_connections = 200
```

Each connection holds ~10MB of memory minimum. At 200 connections that is 2GB just for connection overhead. This is the primary reason to use a connection pooler.

**Connection memory breakdown:**

```
1 connection = ~10MB base + work_mem (if active) + temp buffers
200 connections = ~2GB base overhead (idle)
200 connections = ~15GB+ (under load with work_mem allocations)
```

---

## 2. Monitoring and Observability

### Enable pg_stat_statements

```sql
-- postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
pg_stat_statements.max = 10000
pg_stat_statements.track_utility = on

-- Preserve stats across restarts (default: on)
pg_stat_statements.save = on
```

**Top resource consumers:**

```sql
-- Queries sorted by total execution time
SELECT
    query,
    calls,
    total_exec_time / 1000        AS total_seconds,
    mean_exec_time                AS avg_ms,
    stddev_exec_time              AS stddev_ms,
    total_plan_time / 1000        AS total_plan_seconds,
    rows,
    shared_blks_hit,
    shared_blks_read,
    (shared_blks_read::float / GREATEST(shared_blks_hit + shared_blks_read, 1)) * 100
        AS cache_miss_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

**Queries with high cache miss rates:**

```sql
SELECT query, calls,
       (shared_blks_read::float / GREATEST(shared_blks_hit + shared_blks_read, 1)) * 100
           AS cache_miss_pct
FROM pg_stat_statements
WHERE shared_blks_read > 1000
ORDER BY cache_miss_pct DESC
LIMIT 10;
```

### Table-Level Monitoring

```sql
-- Identify tables with heavy write activity
SELECT
    schemaname || '.' || relname            AS table_name,
    n_tup_ins,
    n_tup_upd,
    n_tup_del,
    n_live_tup,
    n_dead_tup,
    CASE WHEN n_live_tup > 0
         THEN round(n_dead_tup::numeric / n_live_tup * 100, 2)
         ELSE 0 END                          AS dead_tuple_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

### Index Usage Analysis

```sql
-- Find unused indexes (candidates for removal)
SELECT
    schemaname || '.' || relname            AS table,
    indexrelname                            AS index,
    idx_scan                                AS times_used,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

```sql
-- Find indexes with high writes but no reads
SELECT
    s.schemaname || '.' || s.relname       AS table,
    s.indexrelname                          AS index,
    s.idx_scan                              AS reads,
    t.n_tup_ins + t.n_tup_upd + t.n_tup_del AS writes
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t
    ON s.relid = t.relid
WHERE s.idx_scan < 10
  AND (t.n_tup_ins + t.n_tup_upd + t.n_tup_del) > 10000
ORDER BY writes DESC;
```

### pg_wait_sampling (PostgreSQL 14+)

```sql
-- postgresql.conf
shared_preload_libraries = 'pg_wait_sampling'
pg_wait_sampling.enabled = on
pg_wait_sampling.history_size = 1024
```

```sql
-- Current wait events across all backends
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state != 'idle'
GROUP BY wait_event_type, wait_event
ORDER BY count(*) DESC;
```

```sql
-- Historical wait sampling data
SELECT wait_event_type, wait_event, count(*)
FROM pg_wait_sampling_wait_event
GROUP BY wait_event_type, wait_event
ORDER BY count(*) DESC
LIMIT 10;
```

---

## 3. Connection Pooling Strategies

### Why Pool

```
Without pooling:                    With pooling (PgBouncer):
Client --connect--> PG              Client --> PgBouncer --> PG
Client --connect--> PG                       |         |
Client --connect--> PG                       |    10 connections
Each connection = 1 PG process              100 clients share 10 PG processes
```

### PgBouncer Modes

| Mode | Behavior | When to Use |
|------|----------|-------------|
| session | One client = one PG connection for the entire session | Legacy apps, connections that rely on session state |
| transaction | PG connection released after each transaction | Most workloads; best balance of safety and pooling |
| statement | PG connection released after each statement | High concurrency, simple read-heavy workloads |

**Transaction mode flow:**

```
Client: BEGIN;
  --> PgBouncer assigns PG connection A
Client: INSERT INTO orders ...
  --> executes on PG connection A
Client: COMMIT;
  --> PgBouncer releases PG connection A back to pool
Client: SELECT 1;
  --> PgBouncer may assign PG connection B (different connection)
```

**Critical gotcha with transaction mode:** session-level objects (temp tables, SET commands, prepared statements) do not survive across transactions.

### PgBouncer Configuration

```ini
# pgbouncer.ini
[databases]
myapp = host=127.0.0.1 port=5432 dbname=myapp

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

max_client_conn = 500
server_idle_timeout = 600
server_lifetime = 3600
server_connect_timeout = 15

log_disconnections = 1
log_pooler_errors = 1
```

### Odyssey

PostgreSQL-compatible pooler written in Rust. Key differences from PgBouncer:

- Native support for prepared statements in transaction mode
- Built-in health checks with automatic failover
- Query rewriting for analytics offloading
- Configured via YAML instead of INI

```yaml
# odyssey.yaml
listeners:
  "0.0.0.0:6433":
    pools: default

pools:
  default:
    users:
      - user: app_user
        password: "secret"
    servers:
      - host: 127.0.0.1
        port: 5432
    query_router:
      mode: round_robin
      targets:
        - type: primary
          weight: 1
        - type: replica
          weight: 2

pool:
  min_size: 5
  max_size: 20
  mode: transaction
  idle_timeout: 600
```

### Choosing Between Poolers

```
Need prepared statements + transaction mode?  --> Odyssey
Need battle-tested simplicity?                --> PgBouncer
Need query routing to replicas?               --> Odyssey or PgBouncer + app logic
Need health checks / failover?                --> Odyssey
```

---

## 4. Query Performance Patterns

### Sequential Scan vs Index Scan

```sql
-- Force the planner to show cost estimates
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders
WHERE customer_id = 42
  AND order_date >= '2024-01-01';
```

```
Output interpretation:
Seq Scan on orders (cost=0.00..15234.00 rows=500 width=128)
  actual time=0.045..12.340 rows=487 loops=1
  Buffers: shared hit=4567 read=123
  ^^^^^^
  "hit" = found in shared_buffers (fast)
  "read" = had to read from disk (slow)
  "dirtied" = modified in memory, needs writeback
```

### Correlation and Table Ordering

```sql
-- Check if table data is physically ordered by the indexed column
SELECT
    attname,
    correlation
FROM pg_statistic
WHERE starelid = 'orders'::regclass
  AND attname = 'created_at';
-- correlation close to 1.0 or -1.0 means data is physically ordered
-- correlation close to 0.0 means random distribution (index seeks cause random I/O)
```

High correlation means the planner favors index scans. Low correlation with large tables means the planner may prefer sequential scans even when an index exists.

### Partial Indexes for Hot Paths

```sql
-- Only index active orders; archived orders are rarely queried
CREATE INDEX idx_orders_active
ON orders (customer_id, order_date)
WHERE status != 'archived'
  AND order_date >= CURRENT_DATE - INTERVAL '1 year';
```

### Covering Indexes (INCLUDE)

```sql
-- Avoid heap fetches entirely for common SELECT patterns
CREATE INDEX idx_orders_covering
ON orders (customer_id)
INCLUDE (total_amount, status, created_at);

-- This query can be satisfied from the index alone (Index Only Scan)
SELECT total_amount, status, created_at
FROM orders
WHERE customer_id = 42;
```

### Brute-Force Parallelism

```sql
-- Check if a query is using parallel workers
EXPLAIN (ANALYZE, VERBOSE)
SELECT customer_id, COUNT(*), SUM(total_amount)
FROM orders
WHERE order_date >= '2024-01-01'
GROUP BY customer_id;

-- Look for "Gather" node with workers_launched > 0
```

```
Tunable parameters for parallel queries:
max_parallel_workers_per_gather = 2       -- default; increase for large scans
max_parallel_workers = 8                  -- total parallel workers across all queries
min_parallel_table_scan_size = '8MB'      -- table must exceed this to consider parallelism
min_parallel_index_scan_size = '512kB'    -- index must exceed this
```

---

## 5. Vacuum and Analyze Tuning

### Autovacuum Parameters

```
-- postgresql.conf
autovacuum = on
autovacuum_max_workers = 3
autovacuum_naptime = 60

-- Thresholds (absolute count OR percentage of table size)
autovacuum_vacuum_threshold = 50
autovacuum_vacuum_scale_factor = 0.1       -- vacuum after 10% dead tuples
autovacuum_analyze_threshold = 50
autovacuum_analyze_scale_factor = 0.05     -- analyze after 5% tuple changes

-- Aggressive settings for high-churn tables
autovacuum_vacuum_cost_delay = 2           -- ms per page; lower = more aggressive
autovacuum_vacuum_cost_limit = 200         -- cost units before pause
```

### Per-Table Autovacuum Override

```sql
-- High-churn table: vacuum more aggressively
ALTER TABLE orders
SET (
    autovacuum_vacuum_threshold = 100,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_threshold = 50,
    autovacuum_analyze_scale_factor = 0.01
);

-- Rarely written table: reduce vacuum overhead
ALTER TABLE reference_codes
SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.5,
    autovacuum_analyze_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.2
);
```

### Detecting Autovacuum Problems

```sql
-- Tables that are approaching transaction ID wraparound
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    2147483647 - age(datfrozenxid) AS xid_remaining
FROM pg_database
ORDER BY xid_age DESC;

-- If xid_remaining < 10 million, investigate immediately
```

```sql
-- Tables where autovacuum is falling behind
SELECT
    schemaname || '.' || relname AS table_name,
    n_dead_tup,
    last_autovacuum,
    EXTRACT(EPOCH FROM NOW() - last_autovacuum) AS seconds_since_vacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

### Manual Vacuum Strategies

```sql
-- Full vacuum: reclaims space, returns it to the OS
-- Requires exclusive lock; schedule during maintenance windows
VACUUM (FULL, VERBOSE) orders;

-- Freeze-only vacuum: prevents wraparound without full rewrite
VACUUM (FREEZE, VERBOSE) orders;

-- Targeted freeze for tables approaching wraparound
VACUUM (FREEZE, TABLES IN SCHEMA public);
```

---

## 6. Index Maintenance

### REINDEX

```sql
-- Reindex a single index (acquires ShareLock on table; reads are allowed)
REINDEX INDEX idx_orders_customer_id;

-- Reindex all indexes on a table
REINDEX TABLE orders;

-- Reindex entire database (acquires locks sequentially; safe for production)
REINDEX DATABASE myapp;

-- Concurrent reindex (PostgreSQL 12+): no exclusive lock on the table
REINDEX (CONCURRENTLY) INDEX idx_orders_customer_id;
```

### When to Reindex

```
Signs an index needs reindexing:
1. pgstat_user_indexes shows high idx_scan but slow response
2. EXPLAIN shows Index Scan with inflated cost estimates
3. Table has undergone massive UPDATE cycles
4. btree index depth has grown (check `pgstattuple.pg_stat_index` or `bt_metap(get_raw_page('index_name', 0))`)
```

```sql
-- Check index bloat
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS current_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexname::regclass) DESC
LIMIT 20;
```

### pg_repack

Online table reorganization without extended exclusive locks.

```sql
-- Install extension
CREATE EXTENSION IF NOT EXISTS pg_repack;

-- Repack a table (creates a temporary copy, swaps in place)
SELECT repack_table('orders');

-- Repack with index rebuild
SELECT repack_table('orders', '-i');

-- Repack with specific index priority
SELECT repack_table('orders', '-i -I idx_orders_customer_id');
```

```
pg_repack process:
1. Create temporary table with same structure
2. Copy data in small batches (configurable chunk size)
3. Track changes during copy via trigger
4. Apply remaining changes
5. Rename: original -> old, temp -> original
6. Drop old table

Table is readable throughout; brief exclusive lock only at step 5 (milliseconds)
```

---

## 7. Gotchas

### work_mem x Connections = OOM

Setting `work_mem = 1GB` with `max_connections = 200` means the theoretical maximum memory usage is 200 GB per query operation. PostgreSQL does not enforce a per-session memory cap. Monitor with `pg_stat_activity` and set `work_mem` conservatively, then increase for specific queries using `SET LOCAL work_mem = '256MB'` inside a transaction block.

### effective_cache_size Is Not a Memory Allocation

This parameter does not reserve memory. It is a planner hint about how much disk cache the OS provides. Setting it too high causes the planner to prefer index scans over sequential scans, which can be slower on SSDs if the index is not in cache.

### Autovacuum Can Starve Production Workloads

Autovacuum runs at default priority. Under heavy load, it may fall behind, leading to table bloat and eventually transaction ID wraparound emergency vacuums that lock the table. Mitigation: use `autovacuum_vacuum_cost_delay` and `autovacuum_vacuum_cost_limit` to throttle, or schedule manual VACUUM during off-peak hours.

### PgBouncer Transaction Mode Breaks Prepared Statements

Named prepared statements (`PREPARE`, `EXECUTE`) are session-local. In transaction mode, the PG connection returned by the pooler after a transaction commit may be a different backend, so the prepared statement no longer exists. Use inline `EXECUTE($1, $2)` parameterized queries instead, or switch to Odyssey which supports prepared statements in transaction mode.

### REINDEX CONCURRENTLY Still Takes a Brief Lock

The `CONCURRENTLY` option avoids holding an exclusive lock during the bulk of the reindex, but it still acquires `AccessExclusiveLock` at the start and end. The end lock is typically sub-millisecond but can be longer on very large indexes.

### SSDs Need Different Planner Costs

The default `random_page_cost = 4.0` assumes spinning disks where random I/O is 4x slower than sequential I/O. On SSDs this ratio is closer to 1:1. Leaving the default on SSDs causes the planner to avoid index scans unnecessarily.

---

## 8. Key Takeaways

1. Start with monitoring. Use `pg_stat_statements` to identify the top 10 queries by total time, then optimize those. Do not tune blindly.

2. Set `shared_buffers` to 25% of RAM, `effective_cache_size` to 75% of RAM. These are the two settings that move the needle most.

3. Keep `work_mem` conservative (32-64MB default). Override per-query with `SET LOCAL` for known heavy operations.

4. Use a connection pooler. Transaction mode is the default choice. Odyssey if you need prepared statements or query routing.

5. Tune autovacuum per-table for high-churn tables. The defaults are optimized for average workloads, not hot tables.

6. Lower `random_page_cost` for SSDs. This single change often improves query plans across the board.

7. Monitor dead tuple ratios. Tables with `dead_tuple_pct` above 20% need autovacuum tuning or manual VACUUM.

8. Remove unused indexes. Each index adds write overhead to INSERT, UPDATE, and DELETE operations. An unused index is pure cost.

9. Use `REINDEX CONCURRENTLY` for routine maintenance. Reserve `VACUUM FULL` and `pg_repack` for cases where space reclamation is critical.

10. Run `ANALYZE` after any bulk data load or significant schema change. Stale statistics cause the planner to make bad decisions regardless of how well the rest of the system is tuned.
