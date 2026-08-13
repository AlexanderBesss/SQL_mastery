# SQL Interview Q&A for Node.js Backend Developers

Common interview questions covering SQL concepts in the context of Node.js backend development.

## Topics

Examples use PostgreSQL and the `pg` driver unless noted otherwise.

| File | Topic | Questions |
|---|---|---|
| `01_connections_and_pooling.md` | Connection management, pooling, PgBouncer, async | 9 |
| `02_sql_injection_and_security.md` | Security, parameterized queries, Row Level Security | 7 |
| `03_orms_and_query_builders.md` | ORM vs raw SQL, migrations, zero-downtime schema changes | 9 |
| `04_transactions_and_concurrency.md` | ACID, isolation levels, deadlocks, locking strategies | 8 |
| `05_performance_and_indexing.md` | Indexes, EXPLAIN, N+1, query optimization | 10 |
| `06_common_patterns.md` | Soft deletes, retries, seeding, caching, bulk inserts | 7 |
| `07_practical_scenarios.md` | Real-world design problems with solutions | 6 |

## Quick Reference: Most Asked Questions

1. **"How do you prevent SQL injection in Node.js?"** — `02_sql_injection_and_security.md` Q1
2. **"What is the N+1 query problem?"** — `05_performance_and_indexing.md` Q3
3. **"When would you use an ORM vs raw SQL?"** — `03_orms_and_query_builders.md` Q1
4. **"Explain connection pooling and why it matters"** — `01_connections_and_pooling.md` Q2
5. **"How do you handle transactions in Node.js?"** — `04_transactions_and_concurrency.md` Q1
6. **"What indexes would you add and why?"** — `05_performance_and_indexing.md` Q1

## Mistakes That Come Up Constantly

Bugs that look fine in review and fail in production. Each is covered in depth in the linked answer.

| Mistake | Why it breaks | Where |
|---|---|---|
| `pool.query('BEGIN')` for a transaction | Each call may get a different connection — no transaction at all | `04` Q1 |
| `SET app.tenant = $1` | `SET` doesn't accept bind parameters; interpolating reintroduces injection | `02` Q5 |
| RLS enabled but app connects as table owner | Owner bypasses policies unless `FORCE ROW LEVEL SECURITY` | `02` Q5 |
| `FOR UPDATE` via `pool.query()` | Autocommit releases the lock immediately; the job queue hands the same rows to every worker | `04` Q6 |
| `ssl: { rejectUnauthorized: false }` | Encrypted but unauthenticated — MITM-vulnerable | `02` Q4 |
| Retrying any failed query | Non-idempotent writes get duplicated; constraint violations never succeed | `01` Q8, `06` Q2 |
| Backfill and drop in one migration | Old instances still writing the old column during a rolling deploy lose data | `03` Q6 |
| `Date + number` for a deadline | JavaScript concatenates strings, producing `NaN` | `06` Q7 |
| Multi-row INSERT without chunking | Hard cap of 65535 bind parameters per statement | `06` Q6 |
| Sizing the pool from app-server cores | The limit is the database's core count, shared across all instances | `01` Q3 |

## Related

- `../schema_design/` — relationship modeling patterns referenced by `07_practical_scenarios.md`
