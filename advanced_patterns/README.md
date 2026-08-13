# Advanced PostgreSQL Patterns

Advanced topics that go beyond basic schema design. Each file is self-contained with runnable SQL examples targeting PostgreSQL 14+.

## Quick Reference

| Topic | File | What You'll Learn |
|---|---|---|
| Indexing Strategies | `01_indexing_strategies.md` | B-tree, GIN, GiST, BRIN, partial, covering, expression indexes |
| Query Optimization | `02_query_optimization.md` | Reading EXPLAIN ANALYZE, identifying bottlenecks, query rewriting |
| Concurrency & MVCC | `03_concurrency_mvcc.md` | MVCC mechanics, isolation levels, locking, deadlocks, advisory locks |
| Partitioning | `04_partitioning.md` | Range, list, hash partitioning, pruning, maintenance |
| Advanced Queries | `05_advanced_query_patterns.md` | CTEs, window functions, LATERAL joins |
| Stored Procedures & Triggers | `06_stored_procedures_triggers.md` | PL/pgSQL, functions vs procedures, trigger patterns |
| Views & Materialized Views | `07_views_materialized_views.md` | Regular views, materialized views, refresh strategies |
| Security & RLS | `08_security_rbac_rls.md` | Roles, privileges, row-level security, multi-tenant patterns |
| Full-Text Search & PostGIS | `09_fulltext_search_geospatial.md` | tsvector/tsquery, ranking, PostGIS spatial queries |
| Performance Tuning | `10_performance_tuning.md` | Config parameters, monitoring, connection pooling, vacuum tuning |
| Backup & High Availability | `11_backup_recovery_ha.md` | pg_dump, pg_basebackup, PITR, streaming replication, Patroni |

## Learning Path

Follow this order for a structured learning experience:

```
Schema Design (schema_design/)
    ↓
01 → Indexing           (how to speed up queries)
02 → Query Optimization  (how to read and fix slow queries)
05 → Advanced Queries    (powerful query patterns)
    ↓
03 → Concurrency         (how PostgreSQL handles parallel access)
06 → Stored Procedures   (server-side logic)
07 → Views               (abstraction layers)
    ↓
04 → Partitioning        (managing large tables)
08 → Security            (access control)
09 → FTS & Geospatial    (specialized queries)
    ↓
10 → Performance Tuning  (configuration and monitoring)
11 → Backup & HA         (reliability and availability)
```

## Core Principles

1. **Measure before optimizing** — Use `EXPLAIN (ANALYZE, BUFFERS)` to identify real bottlenecks, not suspected ones.
2. **Right index for the job** — B-tree for equality/range, GIN for JSONB/arrays/FTS, GiST for geometric/range, BRIN for naturally ordered large tables.
3. **Concurrency is MVCC** — PostgreSQL never blocks reads with writes. Understand tuple visibility to understand your queries.
4. **Partition for management, not just performance** — Partitioning makes data lifecycle operations (drop old, archive) instant.
5. **Security defaults to open** — PostgreSQL grants public access by default. Use schemas, roles, and RLS deliberately.
6. **Backup strategy is a design decision** — Choose backup type (logical vs physical) and RPO/RTO targets before you need them.

## Related

- `../schema_design/` — fundamental relationship patterns and normalization
