# PostgreSQL Table Partitioning

Partitioning splits one logically large table into smaller physical pieces (partitions). The planner uses partition pruning to skip irrelevant partitions at query time. The result: faster reads on selective queries, faster writes via parallelism, and the ability to drop old data in milliseconds instead of seconds.

This guide covers PostgreSQL 14+ partitioning: range, list, hash, and the patterns that make or break performance.

---

## Why Partition

| Concern | Without Partitioning | With Partitioning |
|---|---|---|
| Query selective on partition key | Full index/table scan | Planner prunes irrelevant partitions |
| Bulk load | Single writer, serial | Multiple partitions can be written in parallel |
| Delete old data | `DELETE` (writes WAL, bloats) | `DROP PARTITION` (instant metadata op) |
| Vacuum | One big table, one big lock | Per-partition, less contention |
| Index size | One large index | Smaller per-partition indexes, better cache fit |

Partitioning is not a silver bullet. If your queries never filter on the partition key, partitioning adds overhead.

---

## Range Partitioning

Divides rows into intervals based on a column value. Most common for time-series data.

### Basic Setup

```sql
CREATE TABLE orders (
    order_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    order_date  DATE NOT NULL,
    customer_id INTEGER NOT NULL,
    total       NUMERIC(12,2),
    status      TEXT
) PARTITION BY RANGE (order_date);

-- Monthly partitions for 2024
CREATE TABLE orders_2024q1 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

CREATE TABLE orders_2024q2 PARTITION OF orders
    FOR VALUES FROM ('2024-04-01') TO ('2024-07-01');

CREATE TABLE orders_2024q3 PARTITION OF orders
    FOR VALUES FROM ('2024-07-01') TO ('2024-10-01');

CREATE TABLE orders_2024q4 PARTITION OF orders
    FOR VALUES FROM ('2024-10-01') TO ('2025-01-01');
```

### Visual Structure

```
orders (parent table -- not queryable directly for inserts)
├── orders_2024q1  [2024-01-01, 2024-04-01)
├── orders_2024q2  [2024-04-01, 2024-07-01)
├── orders_2024q3  [2024-07-01, 2024-10-01)
└── orders_2024q4  [2024-10-01, 2025-01-01)

Query: WHERE order_date = '2024-06-15'
  Planner prunes: orders_2024q1, orders_2024q3, orders_2024q4
  Scans only:     orders_2024q2
```

### Default Partition (Safety Net)

Without a default, inserts outside all ranges fail. A default partition catches misrouted rows:

```sql
CREATE TABLE orders_default PARTITION OF orders DEFAULT;
```

```
orders
├── orders_2024q1  [2024-01-01, 2024-04-01)
├── orders_2024q2  [2024-04-01, 2024-07-01)
├── orders_2024q3  [2024-07-01, 2024-10-01)
├── orders_2024q4  [2024-10-01, 2025-01-01)
└── orders_default  (everything else)
```

Query the default partition periodically to find data that should have gone elsewhere.

### Dropping Old Data

```sql
-- Instant: no DELETE, no WAL, no bloat
DROP TABLE orders_2024q1;
```

The partition and its indexes vanish in a single metadata operation. This is the single strongest argument for range partitioning on time-series data.

### Multi-Column Range

```sql
CREATE TABLE events (
    tenant_id  INTEGER NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    payload    JSONB
) PARTITION BY RANGE (tenant_id, event_time);

CREATE TABLE events_t1_2024 PARTITION OF events
    FOR VALUES FROM (1, '2024-01-01') TO (1, '2025-01-01');

CREATE TABLE events_t2_2024 PARTITION OF events
    FOR VALUES FROM (2, '2024-01-01') TO (2, '2025-01-01');
```

The range is lexicographic: `tenant_id` is compared first, then `event_time`. Useful for multi-tenant systems where you want per-tenant time windows.

---

## List Partitioning

Explicitly assigns rows to partitions based on discrete values. Best for status columns, regions, categories.

### Basic Setup

```sql
CREATE TABLE sensor_readings (
    reading_id  BIGINT GENERATED ALWAYS AS IDENTITY,
    sensor_id   INTEGER NOT NULL,
    region      TEXT NOT NULL,
    reading     NUMERIC(10,4),
    read_at     TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY LIST (region);

CREATE TABLE sensor_us_east PARTITION OF sensor_readings
    FOR VALUES IN ('us-east-1', 'us-east-2');

CREATE TABLE sensor_us_west PARTITION OF sensor_readings
    FOR VALUES IN ('us-west-1', 'us-west-2');

CREATE TABLE sensor_eu PARTITION OF sensor_readings
    FOR VALUES IN ('eu-west-1', 'eu-central-1');

CREATE TABLE sensor_apac PARTITION OF sensor_readings
    FOR VALUES IN ('ap-southeast-1', 'ap-northeast-1');
```

### Visual Structure

```
sensor_readings
├── sensor_us_east  ('us-east-1', 'us-east-2')
├── sensor_us_west  ('us-west-1', 'us-west-2')
├── sensor_eu       ('eu-west-1', 'eu-central-1')
└── sensor_apac     ('ap-southeast-1', 'ap-northeast-1')

Query: WHERE region = 'eu-west-1'
  Planner prunes: sensor_us_east, sensor_us_west, sensor_apac
  Scans only:     sensor_eu
```

### Default Partition for List

```sql
CREATE TABLE sensor_other PARTITION OF sensor_readings DEFAULT;
```

Any `region` value not in a defined list goes here. Without it, the insert fails with `no partition found`.

### When List Shines

- Geographic routing: queries filter by region, each partition lives near its data.
- Status buckets: `active`, `archived`, `deleted` -- each with different access patterns and retention policies.
- Category-based analytics: product categories, customer tiers, event types.

### When List Fails

- Too many distinct values (hundreds of regions, thousands of categories).
- Values change frequently (adding a region requires `CREATE PARTITION` + `ALTER TABLE ... ATTACH`).

---

## Hash Partitioning

Distributes rows uniformly across N partitions using a hash of the key. Ideal for load balancing.

### Basic Setup

```sql
CREATE TABLE user_sessions (
    session_id  UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id     INTEGER NOT NULL,
    started_at  TIMESTAMPTZ DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    metadata    JSONB
) PARTITION BY HASH (user_id);

CREATE TABLE user_sessions_0 PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE user_sessions_1 PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE user_sessions_2 PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE user_sessions_3 PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

### Visual Structure

```
user_sessions  (HASH on user_id, MODULUS 4)
├── user_sessions_0  (remainder 0)
├── user_sessions_1  (remainder 1)
├── user_sessions_2  (remainder 2)
└── user_sessions_3  (remainder 3)

user_id = 1000 -> hash(1000) % 4 = 0 -> user_sessions_0
user_id = 1001 -> hash(1001) % 4 = 1 -> user_sessions_1
user_id = 1002 -> hash(1002) % 4 = 2 -> user_sessions_2
user_id = 1003 -> hash(1003) % 4 = 3 -> user_sessions_3
```

### Key Characteristics

- Uniform distribution: each partition gets roughly the same number of rows.
- No pruning on range queries: `WHERE user_id BETWEEN 100 AND 200` scans all partitions.
- Excellent for point lookups: `WHERE user_id = 42` goes to exactly one partition.
- No default partition exists for hash.

### Scaling Hash Partitions

Adding partitions to a hash setup is painful. You must rebuild:

```sql
-- To go from MODULUS 4 to MODULUS 8:
-- 1. Create a new parent table with MODULUS 8
-- 2. Detach all old partitions
-- 3. Re-attach them as sub-partitions or migrate data
-- Plan for your final partition count upfront.
```

This is the biggest gotcha with hash partitioning. Choose a modulus that will not need to grow.

---

## Subpartitioning

Combine strategies by partitioning a partitioned table. Common pattern: range on time, then list or hash within each time window.

```sql
CREATE TABLE metrics (
    metric_id   BIGINT GENERATED ALWAYS AS IDENTITY,
    metric_name TEXT NOT NULL,
    region      TEXT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL,
    value       NUMERIC(16,6)
) PARTITION BY RANGE (collected_at);

-- Monthly partition, further split by region
CREATE TABLE metrics_2024_01 PARTITION OF metrics
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
    PARTITION BY LIST (region);

CREATE TABLE metrics_2024_01_us PARTITION OF metrics_2024_01
    FOR VALUES IN ('us-east-1', 'us-west-1');

CREATE TABLE metrics_2024_01_eu PARTITION OF metrics_2024_01
    FOR VALUES IN ('eu-west-1', 'eu-central-1');

CREATE TABLE metrics_2024_02 PARTITION OF metrics
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01')
    PARTITION BY LIST (region);

CREATE TABLE metrics_2024_02_us PARTITION OF metrics_2024_02
    FOR VALUES IN ('us-east-1', 'us-west-1');

CREATE TABLE metrics_2024_02_eu PARTITION OF metrics_2024_02
    FOR VALUES IN ('eu-west-1', 'eu-central-1');
```

### Visual Structure

```
metrics (RANGE on collected_at)
├── metrics_2024_01 (LIST on region)
│   ├── metrics_2024_01_us
│   └── metrics_2024_01_eu
└── metrics_2024_02 (LIST on region)
    ├── metrics_2024_02_us
    └── metrics_2024_02_eu

Query: WHERE collected_at >= '2024-01-15' AND region = 'us-east-1'
  Step 1: prune to metrics_2024_01
  Step 2: prune to metrics_2024_01_us
  Result: single partition scan
```

Subpartitioning adds naming complexity but gives maximum pruning power.

---

## Managing Partitions

### Detach and Attach

```sql
-- Detach: removes partition from the tree but keeps the table
ALTER TABLE orders DETACH PARTITION orders_2024q1;

-- The table orders_2024q1 still exists and can be queried independently

-- Re-attach (must satisfy partition constraints)
ALTER TABLE orders ATTACH PARTITION orders_2024q1
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

-- Attach with validation check (slower but safer)
ALTER TABLE orders ATTACH PARTITION orders_2024q1
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01') VALIDATE;
```

### Swap Partition via Detach/Attach

PostgreSQL has no `EXCHANGE PARTITION` command. To swap a standalone table into a partition slot, use `DETACH` + `ATTACH`:

```sql
-- Bulk load data into a staging table
CREATE TABLE staging_q3 (LIKE orders_2024q3 INCLUDING ALL);
INSERT INTO staging_q3 SELECT * FROM external_source;

-- Detach the existing partition (keeps the table)
ALTER TABLE orders DETACH PARTITION orders_2024q3;

-- Attach the staging table as the new partition
ALTER TABLE orders ATTACH PARTITION staging_q3
    FOR VALUES FROM ('2024-07-01') TO ('2024-10-01') VALIDATE;
```

Use `VALIDATE` to check all rows satisfy the partition constraint. Omit it for a fast but unchecked attach.

### Concurrency During Partition Operations

- `DETACH PARTITION` takes an `ACCESS EXCLUSIVE` lock on the parent table.
- `ATTACH PARTITION` without `VALIDATE` is fast (no row validation) but risky.
- `ATTACH PARTITION ... VALIDATE` validates every row and can be slow on large partitions.

---

## Indexes and Constraints

### Indexes on Partitioned Tables

Create indexes on the parent; they propagate to all partitions automatically.

```sql
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_date_status ON orders (order_date, status);

-- These indexes exist on every partition:
--   orders_2024q1.idx_orders_customer
--   orders_2024q2.idx_orders_customer
--   ...
```

### Per-Partition Index Control (PostgreSQL 11+)

You can create or drop indexes on individual partitions for fine-grained control:

```sql
-- Drop index on a cold partition to save space
DROP INDEX orders_2024q1.idx_orders_customer;

-- Add a specialized index only on a hot partition
CREATE INDEX idx_q4_status ON orders_2024q4 (status);
```

### Constraints

```sql
-- Primary key MUST include all partition key columns
ALTER TABLE orders ADD PRIMARY KEY (order_id, order_date);

-- Unique constraints must also include partition key
ALTER TABLE orders ADD UNIQUE (customer_id, order_date);

-- Check constraints propagate to partitions
ALTER TABLE orders ADD CONSTRAINT chk_total_positive CHECK (total >= 0);
```

This is a critical rule: **every primary key and unique constraint must contain the full partition key**. PostgreSQL enforces uniqueness within a partition, not across partitions.

---

## Partition Pruning

Pruning is the mechanism that makes partitioning useful. The planner eliminates partitions whose value ranges cannot match the query predicate.

### Static Pruning (Plan Time)

```sql
EXPLAIN (COSTS OFF)
SELECT * FROM orders WHERE order_date = '2024-06-15';

-- Output:
-- Append
--   -> Seq Scan on orders_2024q2
--        Filter: (order_date = '2024-06-15')
```

Only `orders_2024q2` appears. The other three partitions are pruned at plan time.

### Dynamic Pruning (Execution Time)

```sql
EXPLAIN (COSTS OFF)
SELECT * FROM orders WHERE order_date = current_date;

-- At plan time, current_date is unknown, so all partitions appear.
-- At execution time, the planner prunes based on the actual value.
-- Check with:
SET enable_partition_pruning = on;  -- default
```

### When Pruning Fails

Pruning does not happen when:

- The predicate is not on the partition key column.
- The predicate uses a function on the partition key: `WHERE DATE_TRUNC('month', order_date) = '2024-06-01'`.
- The predicate uses OR across non-adjacent partitions without proper structure.
- The query uses a parameterized plan where the parameter value is unknown at plan time.

### Diagnosing Pruning

```sql
-- Check which partitions are scanned
EXPLAIN (VERBOSE, COSTS OFF)
SELECT * FROM orders WHERE order_date BETWEEN '2024-01-01' AND '2024-03-31';

-- Look at the output: only orders_2024q1 should appear

-- Force no pruning to compare
SET enable_partition_pruning = off;
EXPLAIN (VERBOSE, COSTS OFF)
SELECT * FROM orders WHERE order_date = '2024-06-15';
-- Now all partitions appear in the plan
```

---

## Partition-Wise Joins

PostgreSQL 14+ supports joining two partitioned tables on their partition keys efficiently.

```sql
CREATE TABLE order_items (
    item_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    order_date DATE NOT NULL,
    order_id   BIGINT NOT NULL,
    product_id INTEGER NOT NULL,
    quantity   INTEGER
) PARTITION BY RANGE (order_date);

-- Mirror the partition structure
CREATE TABLE order_items_2024q1 PARTITION OF order_items
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');
-- ... (same boundaries as orders)

-- Enable partition-wise joins
SET enable_partitionwise_join = on;  -- default in PG14+

SELECT o.order_id, o.total, SUM(oi.quantity)
FROM orders o
JOIN order_items oi ON o.order_id = oi.order_id
    AND o.order_date = oi.order_date
WHERE o.order_date >= '2024-01-01' AND o.order_date < '2024-04-01'
GROUP BY o.order_id, o.total;
```

With partition-wise joins enabled, PostgreSQL joins `orders_2024q1` with `order_items_2024q1` directly, avoiding a cross-partition join.

---

## Partition-Wise Aggregation

Aggregate across partitions in parallel, then combine results.

```sql
SET enable_partitionwise_aggregate = on;  -- default in PG14+

SELECT
    DATE_TRUNC('month', order_date) AS month,
    COUNT(*) AS order_count,
    SUM(total) AS revenue
FROM orders
WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01'
GROUP BY 1;
```

Each partition is aggregated independently, then the partial results are merged. This improves memory usage and parallelism.

---

## Gotchas

### 1. Primary Key Must Include Partition Key

```sql
-- This will FAIL:
ALTER TABLE orders ADD PRIMARY KEY (order_id);

-- PostgreSQL requires:
ALTER TABLE orders ADD PRIMARY KEY (order_id, order_date);
```

Every unique constraint spans only one partition. Without the partition key in the constraint, PostgreSQL cannot guarantee global uniqueness.

### 2. Partition Key Cannot Be NULL (for Range and List)

```sql
-- For range and list partitioning, the partition key column must be NOT NULL
-- This is enforced implicitly by the partitioning mechanism

-- Hash partitioning allows NULLs (they all go to the same partition)
```

### 3. No Default Partition in Hash

Hash partitioning has no `DEFAULT` partition. Every value maps to a remainder. Plan your modulus carefully.

### 4. Foreign Keys Are Not Supported on Partitioned Tables

```sql
-- This will FAIL:
CREATE TABLE order_payments (
    payment_id BIGINT PRIMARY KEY,
    order_id   BIGINT,
    order_date DATE,
    FOREIGN KEY (order_id, order_date) REFERENCES orders(order_id, order_date)
);
```

Partitioned tables cannot be the target of a foreign key reference. Workarounds:
- Use application-level validation.
- Use triggers to enforce referential integrity.
- Denormalize the foreign key data into the partitioned table.

### 5. Partition Key Changes Are Impossible

```sql
-- You cannot change the partition key of an existing partitioned table.
-- You cannot add or remove columns from the partition key.
-- If you need a different partition key, rebuild the table.
```

### 6. Sequential Scans on Unpruned Queries

```sql
-- This query scans ALL partitions (no pruning possible):
SELECT COUNT(*) FROM orders;

-- This query also scans all partitions:
SELECT * FROM orders WHERE customer_id = 42;

-- The partition key must appear in the WHERE clause for pruning to work.
```

### 7. Statistics Are Per-Partition

The planner collects statistics per partition. If a partition is small, statistics may be sparse. Consider:

```sql
-- Increase statistics target for the partition key
ALTER TABLE orders ALTER COLUMN order_date SET STATISTICS 1000;
```

### 8. VACUUM Runs Per Partition

```sql
-- Vacuum each partition individually
VACUUM ANALYZE orders_2024q1;
VACUUM ANALYZE orders_2024q2;

-- Or vacuum the parent (runs on all partitions)
VACUUM ANALYZE orders;
```

Autovacuum tunes per partition, not per parent. Small partitions may get vacuumed too aggressively; large partitions may not get enough attention. Tune `autovacuum_vacuum_scale_factor` per partition if needed.

### 9. Lock Contention on the Parent

DDL operations on partitions (`DETACH`, `ATTACH`, `DROP`) lock the parent table. In high-throughput systems, schedule these during maintenance windows.

### 10. Partition Count Matters

Too many partitions degrade planner performance. The planner evaluates each partition during planning.

- Under 100 partitions: negligible overhead.
- 100-500 partitions: measurable planning time increase.
- Over 500 partitions: consider coarser partitioning or declarative partitioning alternatives.

---

## Automated Partition Creation

For time-series data, create partitions proactively with a scheduled function.

```sql
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS VOID AS $$
DECLARE
    target_date DATE;
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    -- Create partitions 3 months ahead
    FOR i IN 0..2 LOOP
        target_date := date_trunc('month', NOW() + (i || ' months')::INTERVAL)::DATE;
        partition_name := 'orders_' || to_char(target_date, 'YYYYmon');
        start_date := target_date;
        end_date := (target_date + INTERVAL '1 month')::DATE;

        -- Check if partition already exists
        IF NOT EXISTS (
            SELECT 1 FROM pg_class WHERE relname = partition_name
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF orders FOR VALUES FROM (%L) TO (%L)',
                partition_name, start_date, end_date
            );
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Run via pg_cron or an external scheduler
-- SELECT create_monthly_partition();
```

---

## Choosing a Strategy

| Data Pattern | Best Strategy | Example |
|---|---|---|
| Time-series, rolling window | Range on timestamp | Logs, metrics, orders |
| Fixed categories, few values | List on category | Regions, statuses, types |
| High cardinality, uniform access | Hash on ID | Sessions, cache, sharded data |
| Multi-tenant time-series | Subpartition: range + list | SaaS analytics |
| Mixed access patterns | Subpartition: range + hash | Event processing |

### Decision Flow

```
Does your data have a natural time dimension?
  Yes -> Range partitioning on timestamp
    Also need per-tenant isolation?
      Yes -> Subpartition with list on tenant_id
      No  -> Range alone

No time dimension?
  Are there a small number of categories (< 20)?
    Yes -> List partitioning
    No  -> Hash partitioning on the most-queried ID column
```

---

## Monitoring Partitioning

### Partition Sizes

```sql
SELECT
    inhrelid::regclass AS partition_name,
    pg_size_pretty(pg_relation_size(inhrelid)) AS size,
    n_live_tup AS approximate_rows
FROM pg_inherits
JOIN pg_stat_user_tables ON pg_inherits.inhrelid = pg_stat_user_tables.relid
WHERE inhparent = 'orders'::regclass
ORDER BY inhrelid::regclass;
```

### Partition Tree

```sql
SELECT
    parent.relname AS parent_table,
    child.relname  AS partition,
    pg_get_expr(c.partbound, c.oid) AS partition_bound
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid = child.oid
JOIN pg_partitioned_table c ON parent.oid = c.partrelid
WHERE parent.relname = 'orders'
ORDER BY child.relname;
```

---

## Key Takeaways

1. **Partition on what you query.** If your WHERE clauses do not filter on the partition key, partitioning adds overhead without benefit.

2. **Range partitioning is the default choice** for time-series data. The ability to drop old partitions instantly is unmatched.

3. **Always include a DEFAULT partition** for range and list strategies. It prevents insert failures when new values appear.

4. **Primary keys must include the partition key.** This is non-negotiable. Design your keys accordingly.

5. **Foreign keys do not work with partitioned tables.** Plan your schema to avoid this dependency.

6. **Hash partitioning modulus is hard to change.** Pick a value that will last. If you anticipate growth, start at a higher modulus.

7. **Pruning only works on the partition key.** Queries that filter on other columns scan all partitions.

8. **Keep partition count reasonable.** Under 500 is a practical upper bound. Coarser partitions with better pruning beats many tiny partitions.

9. **Subpartitioning is powerful but complex.** Use it when you have two natural dimensions (time + region, time + tenant) and queries filter on both.

10. **Automate partition lifecycle.** Create future partitions ahead of time. Archive or drop old partitions on schedule. Let the system manage itself.
