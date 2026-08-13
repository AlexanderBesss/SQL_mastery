# ADVANCED PATTERN 2: QUERY OPTIMIZATION

A query plan is a contract between you and the planner. You write SQL, PostgreSQL decides how to execute it. EXPLAIN ANALYZE is the only way to verify the contract is fair.

## THE SHORT VERSION

| EXPLAIN option | What it shows | When to use |
|---|---|---|
| `EXPLAIN` | Estimated plan only | Quick syntax check, no execution |
| `EXPLAIN ANALYZE` | Actual runtime + estimates | Production debugging, bottleneck hunting |
| `EXPLAIN (ANALYZE, BUFFERS)` | I/O breakdown | Cache problems, disk pressure |
| `EXPLAIN (ANALYZE, FORMAT JSON)` | Machine-readable | Tooling, monitoring, CI checks |
| `EXPLAIN (ANALYZE, TIMING OFF)` | Without timing overhead | Microsecond-level noise reduction |

---

## EXPLAIN VARIANTS

### BASIC EXPLAIN

Returns the estimated plan without executing the query. Useful for syntax validation and understanding the planner's intentions.

```sql
explain
select o.*, c.name
from orders o
join customers c on c.id = o.customer_id
where o.status = 'pending';
```

```
                                    QUERY PLAN
-----------------------------------------------------------------------------------------
 Hash Join  (cost=14.20..37.45 rows=12 width=42)
   Hash Cond: (o.customer_id = c.id)
   ->  Seq Scan on orders o  (cost=0.00..20.00 rows=12 width=38)
         Filter: (status = 'pending')
   ->  Hash  (cost=12.00..12.00 rows=120 width=8)
         ->  Seq Scan on customers c  (cost=0.00..12.00 rows=120 width=8)
(6 rows)
```

### EXPLAIN ANALYZE

Executes the query and reports actual runtime statistics alongside estimates. This is the primary debugging tool.

```sql
explain analyze
select o.*, c.name
from orders o
join customers c on c.id = o.customer_id
where o.status = 'pending';
```

```
                                             QUERY PLAN
---------------------------------------------------------------------------------------------------------------
 Hash Join  (cost=14.20..37.45 rows=12 width=42) (actual time=0.045..0.089 rows=12 loops=1)
   Hash Cond: (o.customer_id = c.id)
   ->  Seq Scan on orders o  (cost=0.00..20.00 rows=12 width=38) (actual time=0.012..0.034 rows=12 loops=1)
         Filter: (status = 'pending')
         Rows Removed by Filter: 488
   ->  Hash  (cost=12.00..12.00 rows=120 width=8) (actual time=0.025..0.025 rows=120 loops=1)
         Buckets: 1024  Batches: 1  Memory Usage: 7kB
         ->  Seq Scan on customers c  (cost=0.00..12.00 rows=120 width=8) (actual time=0.003..0.018 rows=120 loops=1)
 Planning Time: 0.312 ms
 Execution Time: 0.115 ms
(11 rows)
```

### EXPLAIN WITH BUFFERS

Reveals the I/O story -- which pages came from memory, which required disk reads.

```sql
explain (analyze, buffers)
select * from orders where status = 'pending';
```

```
                                              QUERY PLAN
------------------------------------------------------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..20.00 rows=12 width=38) (actual time=0.015..0.038 rows=12 loops=1)
   Buffers: shared hit=8
   Filter: (status = 'pending')
   Rows Removed by Filter: 488
 Planning Time: 0.180 ms
 Execution Time: 0.052 ms
(5 rows)
```

### EXPLAIN WITH FORMAT JSON

Returns structured output for programmatic analysis.

```sql
explain (analyze, format json)
select count(*) from orders where status = 'pending';
```

```json
[
  {
    "Plan": {
      "Node Type": "Aggregate",
      "Startup Cost": 20.30,
      "Total Cost": 20.31,
      "Plan Rows": 1,
      "Actual Startup Time": 0.045,
      "Actual Total Time": 0.046,
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Plans": [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          "Filter": "status = 'pending'",
          "Rows Removed by Filter": 488
        }
      ]
    },
    "Planning Time": 0.150
  }
]
```

---

## SCAN NODE TYPES

Every node in a plan represents an operation. Understanding them is the foundation of reading plans.

```
+------------------+     +------------------+     +------------------+
|   Seq Scan       |     |   Index Scan     |     |   Index Only     |
|   Full table     |     |   Index + heap   |     |   Index only     |
|   read           |     |   lookup         |     |   (no heap)      |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        v                        v                        v
+------------------+     +------------------+     +------------------+
|   Bitmap Scan    |     |   Index Scan     |     |   Tid Scan       |
|   Index + batch  |     |   Backward       |     |   CTID direct    |
|   heap access    |     |   (ORDER BY desc)|     |   access         |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        v                        v                        v
+------------------+     +------------------+     +------------------+
|   Append         |     |   Merge Append   |     |   Recursive      |
|   UNION ALL      |     |   UNION ALL      |     |   CTE            |
|   (no sort)      |     |   (sorted)       |     |   Union          |
+------------------+     +------------------+     +------------------+
```

### SEQUENTIAL SCAN

Reads every page of a table in physical order. Not inherently bad -- for wide tables or high selectivity, it is the fastest option.

```
 Seq Scan on orders  (cost=0.00..15200.00 rows=50000 width=42)
   (actual time=0.018..185.420 rows=50000 loops=1)
```

**When it is correct:**
- Returning more than ~15% of the table
- Table is small enough to fit in cache
- No suitable index exists

**When it signals a problem:**
- Large table, narrow result set (< 5% selectivity)
- Column has an index but planner chose to ignore it
- Query runs repeatedly and table is too large for cache

### INDEX SCAN

Uses the index to find rows, then fetches the full row from the heap.

```
 Index Scan using idx_orders_status on orders  (cost=0.43..125.80 rows=50 width=42)
   (actual time=0.032..0.892 rows=50 loops=1)
   Index Cond: (status = 'pending')
```

**Cost pattern:** Low startup cost (0.43), higher per-row cost. Good for small result sets.

### INDEX ONLY SCAN

Reads data from the index without touching the heap. Requires the index to cover all needed columns.

```
 Index Only Scan using idx_orders_status_customer on orders  (cost=0.43..89.20 rows=50 width=14)
   (actual time=0.028..0.445 rows=50 loops=1)
   Index Cond: (status = 'pending')
   Heap Fetches: 0
```

**Key metric:** `Heap Fetches: 0` means zero heap lookups. Any non-zero value indicates visibility map misses -- the index had to check the heap to confirm tuple visibility.

### BITMAP INDEX SCAN

Two-phase access: first builds a bitmap of matching pages from the index, then reads those pages in physical order. Ideal when many index entries point to the same page.

```
 Bitmap Heap Scan on orders  (cost=12.50..245.80 rows=500 width=42)
   (actual time=0.156..2.890 rows=500 loops=1)
   Recheck Cond: (status = 'pending')
   Heap Fetches: 500
   ->  Bitmap Index Scan on idx_orders_status  (cost=0.00..12.38 rows=500 width=0)
         (actual time=0.132..0.132 rows=500 loops=1)
         Index Cond: (status = 'pending')
```

**Why bitmap over index scan:** Random I/O from index scan is expensive when rows are scattered. Bitmap batches page reads sequentially.

---

## COST ESTIMATION

Every node reports `cost=startup..total`. Understanding these numbers reveals why the planner chose one plan over another.

### COST COMPONENTS

```
 cost = startup_cost + total_cost

 startup_cost  = work done before returning the first row
 total_cost    = work done to return ALL rows

 per-row cost  = (total_cost - startup_cost) / estimated_rows
```

### DEFAULT SETTINGS (postgresql.conf)

| Parameter | Default | Meaning |
|---|---|---|
| `seq_page_cost` | 1.0 | Cost of reading one 8KB page sequentially |
| `random_page_cost` | 4.0 | Cost of a random page fetch (lower for SSDs) |
| `cpu_tuple_cost` | 0.01 | Cost of processing one tuple |
| `cpu_index_tuple_cost` | 0.005 | Cost of processing one index entry |
| `cpu_operator_cost` | 0.0025 | Cost of one operator evaluation |
| `effective_cache_size` | 4GB | Estimated OS cache size (not a limit) |

### READING A COST LINE

```
 Seq Scan on orders  (cost=0.00..15200.00 rows=50000 width=42)
 ^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      startup=0.00  total=15200.00  est_rows=50000

 Index Scan using idx on orders  (cost=0.43..125.80 rows=50 width=42)
                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                              startup=0.43  total=125.80  est_rows=50
```

The planner picks the plan with the lowest total cost for the expected number of fetched rows.

### ADJUSTING random_page_cost FOR SSDs

On SSD storage, random and sequential reads are similar in cost.

```sql
-- Check current setting
show random_page_cost;

-- For SSD-backed storage, lower to 1.1-1.5
alter system set random_page_cost = 1.2;
select pg_reload_conf();
```

Lower `random_page_cost` makes the planner prefer index scans over sequential scans.
---

## ACTUAL TIME AND LOOPS

The most actionable metrics in EXPLAIN ANALYZE.

### ACTUAL TIME FORMAT

```
 (actual time=0.032..0.892 rows=50 loops=1)
            ^^^^^^^^  ^^^^^^^
            start     total
            time      time
```

- **Startup time:** Milliseconds from node start to first row returned
- **Total time:** Milliseconds from node start to LAST row returned
- **Rows:** Actual number of rows produced by this node
- **Loops:** How many times this node executed (nested loops)

### LOOPS IN NESTED LOOPS

```
 Nested Loop  (cost=0.46..2580.50 rows=500 width=42) (actual time=0.035..12.450 rows=500 loops=1)
   ->  Index Scan using idx_orders_status on orders  (cost=0.43..125.80 rows=50 width=10)
         (actual time=0.028..0.445 rows=50 loops=1)
         Index Cond: (status = 'pending')
   ->  Index Scan using idx_order_items_order_id on order_items  (cost=0.29..48.70 rows=10 width=38)
         (actual time=0.025..0.240 rows=10 loops=50)
         Index Cond: (order_id = orders.id)
```

The inner scan runs 50 times -- once for each outer row. Total inner work: `0.240 * 50 = 12.0 ms`.

```
 Outer loop (50 rows from orders)
     |
     +---> Inner scan #1  (finds 10 items)
     +---> Inner scan #2  (finds 10 items)
     +---> Inner scan #3  (finds 10 items)
     ...
     +---> Inner scan #50 (finds 10 items)
```

### SPOTTING ESTIMATE ERRORS

Compare estimated rows to actual rows at each node.

```
 Seq Scan on orders  (cost=0.00..20.00 rows=12 width=38)
   (actual time=0.012..0.034 rows=1200 loops=1)
   Filter: (status = 'pending')
   Rows Removed by Filter: 48800
```

Estimated 12 rows, got 1200. This is a 100x error. The planner will make bad choices based on this -- choosing nested loops over hash joins, picking wrong index, etc.

**Fix:** Run `ANALYZE orders;` to update statistics.

---

## BUFFER HITS AND READS

The BUFFERS option reveals the I/O story.

### BUFFER TERMINOLOGY

| Buffer type | Source | Speed |
|---|---|---|
| `shared hit` | PostgreSQL shared buffer cache | Memory (~100 ns) |
| `shared read` | Disk read into shared buffers | SSD (~0.1 ms) / HDD (~5 ms) |
| `temp read` | Sort/spill to temporary file | Disk |
| `prefetch` | Read-ahead pages | Depends on strategy |

### EXAMPLE: FULL CACHE HIT

```
 Seq Scan on orders  (cost=0.00..20.00 rows=12 width=38)
   (actual time=0.015..0.038 rows=12 loops=1)
   Buffers: shared hit=8
```

All 8 pages came from memory. Fast.

### EXAMPLE: CACHE MISS

```
 Seq Scan on orders  (cost=0.00..20.00 rows=12 width=38)
   (actual time=12.015..45.038 rows=12 loops=1)
   Buffers: shared hit=2 shared read=6
```

6 of 8 pages required disk reads. The query is I/O bound.

### EXAMPLE: TEMP BUFFERS (SPILL)

```
 Sort  (cost=150.00..155.00 rows=2000 width=42)
   (actual time=8.500..12.340 rows=2000 loops=1)
   Sort Method: external merge  Disk: 128kB
   Buffers: shared hit=20 temp read=4 temp write=4
```

The sort spilled to disk because `work_mem` was insufficient. `temp read` and `temp write` indicate disk I/O for temporary files.

### TUNING work_mem

```sql
-- Check current setting
show work_mem;

-- Increase for sessions doing large sorts or hash operations
set work_mem = '64MB';

-- Or set at role level for specific users
alter role analytics_role set work_mem = '128MB';
```

---

## COMMON PLAN PROBLEMS

### PROBLEM 1: NESTED LOOP ON LARGE SETS

```
 Nested Loop  (cost=0.46..580000.00 rows=1000000 width=42)
   (actual time=0.035..45000.000 rows=1000000 loops=1)
   ->  Seq Scan on orders  (cost=0.00..15200.00 rows=50000 width=10)
         (actual time=0.018..185.420 rows=50000 loops=1)
   ->  Index Scan using idx_customers_id on customers  (cost=0.29..10.50 rows=1 width=38)
         (actual time=0.001..0.001 rows=1 loops=50000)
```

50,000 index lookups in a loop. Total: 45 seconds. The planner underestimated the outer row count.

**Fix:** Add a join condition that reduces the outer set, or force a hash join with `enable_nestloop = off` temporarily.

### PROBLEM 2: SORT WHERE INDEX COULD SERVE

```
 Sort  (cost=150.00..155.00 rows=2000 width=42)
   (actual time=2.500..3.100 rows=2000 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 256kB
   ->  Seq Scan on orders  (cost=0.00..120.00 rows=2000 width=42)
         (actual time=0.010..1.800 rows=2000 loops=1)
```

A sort step is adding 2.5 ms of startup cost. An index on `created_at DESC` would eliminate it.

**Fix:**
```sql
create index idx_orders_created_desc on orders (created_at desc);
```

### PROBLEM 3: SEQUENTIAL SCAN ON LARGE TABLE WITH FEW ROWS

```
 Seq Scan on orders  (cost=0.00..15200.00 rows=5 width=42)
   (actual time=0.500..185.420 rows=5 loops=1)
   Filter: (order_id = 99999)
   Rows Removed by Filter: 999995
```

Scanned 1 million rows to find 5. An index on `order_id` would return in microseconds.

**Fix:**
```sql
create index idx_orders_id on orders (order_id);
```

### PROBLEM 4: HASH AGGREGATE WITH PARTITION PRUNING MISSED

```
 HashAggregate  (cost=250.00..260.00 rows=1000 width=18)
   (actual time=15.200..15.800 rows=1000 loops=1)
   Group Key: region_id
   ->  Seq Scan on sales  (cost=0.00..180.00 rows=50000 width=18)
         (actual time=0.010..8.500 rows=50000 loops=1)
         Filter: (sale_date BETWEEN '2024-01-01' AND '2024-01-31')
         Rows Removed by Filter: 950000
```

Scanning the entire partitioned table instead of pruning to the January partition.

**Fix:** Ensure the partition key is in the WHERE clause and statistics are current.

```sql
-- Verify partition pruning is enabled
show enable_partition_pruning;

-- Check with DETAILED output
explain (analyze, detail)
select region_id, sum(amount)
from sales
where sale_date BETWEEN '2024-01-01' AND '2024-01-31'
group by region_id;
```

---

## QUERY REWRITING

The planner is good, but not omniscient. Rewriting queries can guide it toward better plans.

### PUSHDOWN FILTERS EARLY

```sql
-- Before: subquery materialized first
select *
from (
    select * from orders where created_at > '2024-01-01'
) sub
where sub.status = 'pending';

-- After: single scan with combined filters
select *
from orders
where created_at > '2024-01-01'
  and status = 'pending';
```

The planner often pushes filters down automatically, but CTEs in PostgreSQL act as optimization fences -- they materialize unless inlined.

### CTE MATERIALIZATION (PostgreSQL 12+)

```sql
-- Before PG 12: CTEs were always materialization barriers
-- PG 12+: simple CTEs are automatically inlined by default

-- Force materialization (evaluated once, stored) — useful when referenced multiple times
with materialized_cte as materialized (
    select * from orders where status = 'pending'
)
select * from materialized_cte;

-- Force inlining (evaluated per reference) — useful for filter pushdown
with inline_cte as not materialized (
    select customer_id, count(*) as cnt
    from orders
    group by customer_id
)
select c.name, ic.cnt
from customers c
join inline_cte ic on ic.customer_id = c.id;
```

### USE EXISTS INSTEAD OF IN FOR LARGE SUBQUERIES

```sql
-- Before: may materialize the subquery
select * from customers
where id in (select customer_id from orders where status = 'pending');

-- After: correlated subquery, stops at first match
select * from customers
where exists (
    select 1 from orders
    where orders.customer_id = customers.id
      and orders.status = 'pending'
);
```

### SEMI-JOIN WITH JOIN INSTEAD OF EXISTS

```sql
-- When the subquery result is small, a JOIN may be faster
select distinct c.*
from customers c
join orders o on o.customer_id = c.id
where o.status = 'pending';
```

### AVOID SELECT *

```sql
-- Before: fetches every column, prevents index-only scans
select * from orders where status = 'pending';

-- After: only needed columns, enables index-only scan
select id, customer_id, total, created_at
from orders
where status = 'pending';
```

---

## STATISTICS AND ANALYZE

The planner estimates row counts from statistics stored in `pg_statistic`. Outdated statistics produce wrong plans.

### DEFAULT STATISTICS TARGET

```sql
-- Check the default
show default_statistics_target;
-- Default: 100

-- Per-column target
alter table orders alter column status set statistics 200;
analyze orders;
```

Higher targets capture more detail about data distribution, at the cost of longer ANALYZE runs and more catalog storage.

### WHEN TO INCREASE STATISTICS TARGET

| Scenario | Recommended target |
|---|---|
| Uniform distribution (IDs, timestamps) | 100 (default) |
| Skewed distribution (status, region) | 200-500 |
| Expression index columns | 200+ |
| MCV-heavy columns (few repeated values) | 500+ |

### CHECKING STATISTICS QUALITY

```sql
-- Compare estimated vs actual row counts
select
    relname as table_name,
    n_live_tup as estimated_rows
from pg_class
where relname = 'orders';

-- Check last analyze time
select relname, last_analyze, last_autoanalyze
from pg_stat_user_tables
where relname = 'orders';
```

### AUTO-ANALYZE CONFIGURATION

```sql
-- Check autovacuum settings
show autovacuum;
show autovacuum_analyze_threshold;  -- default: 50
show autovacuum_analyze_scale_factor;  -- default: 0.1

-- ANALYZE runs when changes exceed:
-- threshold + (scale_factor * total_rows)
-- For a 1M row table: 50 + 0.1 * 1000000 = 100,050 changes

-- For tables with frequent updates, lower the threshold
alter table orders
  set (autovacuum_analyze_threshold = 100),
  set (autovacuum_analyze_scale_factor = 0.01);
```

### EXTENDED STATISTICS FOR CORRELATED COLUMNS

When two columns are correlated, the planner needs to know to avoid multiplying selectivities.

```sql
-- Example: orders where country = 'US' AND state = 'CA'
-- Without extended stats, planner estimates: P(US) * P(CA) = wrong
-- With extended stats, planner sees the joint distribution

create statistics order_location_stats (dependencies)
on country, state from orders;

analyze orders;

-- Verify
select * from pg_statistic_ext where stxname = 'order_location_stats';
```

---

## QUERY HINTS

PostgreSQL does not have Oracle-style optimizer hints. Instead, use these mechanisms.

### RUNTIME CONFIGURATION FLAGS

```sql
-- Disable specific plan types to force alternatives
set enable_nestloop = off;
set enable_hashjoin = off;
set enable_mergejoin = off;
set enable_bitmapscan = off;
set enable_seqscan = off;

-- Use EXPLAIN ANALYZE to verify the forced plan
explain analyze
select o.*, c.name
from orders o
join customers c on c.id = o.customer_id
where o.status = 'pending';
```

### FORCE INDEX SCAN

```sql
-- Prevent sequential scan to force index usage
set enable_seqscan = off;

explain analyze
select * from orders where status = 'pending';

-- Remember to reset
set enable_seqscan = on;
```

### SET work_mem PER SESSION

```sql
-- Increase for complex queries with large sorts or hash operations
set work_mem = '256MB';

-- Verify the sort stayed in memory
explain (analyze, buffers)
select customer_id, sum(total)
from orders
group by customer_id;
```

### TABLESAMPLE FOR LARGE TABLE TESTING

```sql
-- Test query performance on a subset before running on full table
explain analyze
select status, count(*)
from orders tablesample bernoulli(1)
group by status;
```

### USING pg_hint_plan EXTENSION

For cases where built-in controls are insufficient, the third-party `pg_hint_plan` extension provides Oracle-style hints.

```sql
-- Requires extension installation
-- create extension pg_hint_plan;

/*+ NestLoop(o c) IndexScan(o idx_orders_status) */
select o.*, c.name
from orders o
join customers c on c.id = o.customer_id
where o.status = 'pending';
```

---

## COMMON MISTAKES

### MISTAKE 1: TRUSTING ESTIMATES WITHOUT ANALYZE

```sql
-- EXPLAIN without ANALYZE shows only estimates
explain select * from orders where status = 'pending';

-- EXPLAIN ANALYZE shows reality
explain analyze select * from orders where status = 'pending';
```

Estimates are guesses. Actual times are facts. Always use ANALYZE when debugging performance.

### MISTAKE 2: IGNORING LOOPS COUNT

```
 Nested Loop  (actual time=0.035..45000.000 rows=1000000 loops=1)
   ->  Seq Scan on orders  (actual time=0.018..185.420 rows=50000 loops=1)
   ->  Index Scan on customers  (actual time=0.001..0.001 rows=1 loops=50000)
```

The inner node's total time is misleading. It reports 0.001 ms, but ran 50,000 times. Multiply: `0.001 * 50000 = 50 ms` minimum, but actual I/O amplification makes it much worse.

### MISTAKE 3: ASSUMING SEQUENTIAL SCAN IS ALWAYS BAD

A sequential scan on a 100-row table is faster than an index scan. A sequential scan returning 80% of a table is correct. The planner is often right to choose it.

**Rule of thumb:** If the planner estimates it will read more than ~15% of the table, a seq scan is usually the right call.

### MISTAKE 4: NOT UPDATING STATISTICS AFTER DATA LOADING

```sql
-- After a bulk load, statistics are stale
copy orders from '/data/orders.csv' with csv;

-- Always run ANALYZE after bulk operations
analyze orders;

-- Or set a high autovacuum threshold for staging tables
alter table staging_orders set (autovacuum_analyze_threshold = 1000000);
```

### MISTAKE 5: OVER-INDEXING

```sql
-- Every index adds write overhead
create index idx_orders_status on orders (status);
create index idx_orders_customer on orders (customer_id);
create index idx_orders_date on orders (created_at);
create index idx_orders_total on orders (total);
create index idx_orders_region on orders (region_id);
create index idx_orders_priority on orders (priority);
-- ... and so on
```

Each index slows INSERT, UPDATE, and DELETE. Each index consumes disk space. Only index columns that appear in WHERE, JOIN, ORDER BY, or GROUP BY clauses of actual production queries.

### MISTAKE 6: COMPARING EXPLAIN OUTPUT ACROSS DIFFERENT POSTGRESQL VERSIONS

Cost formulas changed between versions. A plan that looks expensive in PostgreSQL 14 may look different in PostgreSQL 16. Always compare plans from the same server version.

---

## PRACTICAL WORKFLOW

### STEP 1: IDENTIFY THE SLOW QUERY

```sql
-- Use pg_stat_statements to find top queries by total time
create extension if not exists pg_stat_statements;

select
    query,
    calls,
    total_exec_time / calls as avg_ms,
    total_exec_time as total_ms,
    rows
from pg_stat_statements
order by total_exec_time desc
limit 10;
```

### STEP 2: GET THE PLAN WITH ANALYZE

```sql
explain (analyze, buffers, timing, summary)
-- paste the slow query here
select o.id, o.total, c.name
from orders o
join customers c on c.id = o.customer_id
where o.created_at > '2024-01-01'
  and o.status = 'pending'
order by o.created_at desc
limit 50;
```

### STEP 3: READ FROM BOTTOM TO TOP

```
 Step 1: Check Planning Time and Execution Time at the bottom
 Step 2: Read the leaf nodes first (deepest indentation)
 Step 3: Compare estimated rows vs actual rows at each node
 Step 4: Check loops count for nested operations
 Step 5: Look for temp buffers (sort/hash spills)
 Step 6: Identify the node with the highest actual time
```

### STEP 4: APPLY A FIX

```
 High seq scan cost on large table?  --> Add index
 Estimate error > 10x?               --> Run ANALYZE, increase statistics target
 Sort spilling to disk?              --> Increase work_mem
 Nested loop with high loops?        --> Add index on inner join column, or rewrite query
 Hash join on small datasets?        --> Consider forcing nested loop with index
 Sequential scan on small table?     --> Accept it, it is correct
```

### STEP 5: VERIFY THE IMPROVEMENT

```sql
-- Re-run EXPLAIN ANALYZE and compare
explain (analyze, buffers)
select o.id, o.total, c.name
from orders o
join customers c on c.id = o.customer_id
where o.created_at > '2024-01-01'
  and o.status = 'pending'
order by o.created_at desc
limit 50;
```

---

## SUMMARY

EXPLAIN ANALYZE is a diagnostic tool, not a grading system. The goal is not to make every plan look perfect -- it is to find the mismatch between what the planner expects and what actually happens, then fix the root cause.

| Symptom | Likely cause | Fix |
|---|---|---|
| Estimated rows far from actual | Stale statistics | `ANALYZE table_name` |
| Sequential scan on large table, few rows | Missing index | `CREATE INDEX` |
| Sort with temp buffers | `work_mem` too low | Increase `work_mem` |
| Nested loop with high loops | Missing join index | Index the join column |
| Bitmap scan with many heap fetches | Visibility map stale | `VACUUM` the table |
| Hash join on small datasets | Planner misestimate | Force nested loop, or update stats |
| Query plan changes between runs | Random sampling in stats | Increase statistics target |

The loop is: explain, analyze, fix, repeat. There is no shortcut.
