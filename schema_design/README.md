# PostgreSQL Schema Design Patterns

Common schema design patterns with Mermaid ER/flow diagrams and ready-to-use SQL solutions.
Each pattern includes the **why**, **when to use**, and **gotchas** to watch for.

All SQL targets PostgreSQL 14+. Each file creates its own schema and is runnable start to finish.

## Quick Reference

| Pattern | File | Use Case |
|---|---|---|
| One-to-Many | `01_one_to_many.md` | Author → Books, Customer → Orders |
| Many-to-Many | `02_many_to_many.md` | Students ↔ Courses, Products ↔ Categories |
| One-to-One | `03_one_to_one.md` | User → Profile, Account → Settings |
| Self-Referencing | `04_self_referencing.md` | Categories, Employees → Manager |
| Polymorphic | `05_polymorphic.md` | Comment on Post/Video/Image |
| Inheritance | `06_inheritance.md` | Employee/Manager/Contractor |
| Temporal | `07_temporal.md` | Audit trail, soft delete, history |
| JSONB Flexible | `08_jsonb_flexible.md` | Dynamic attributes, settings |
| Data Types | `09_data_types.md` | Choosing the right column type |
| Keys & Constraints | `10_keys_and_constraints.md` | PKs, UUIDs, CHECK, EXCLUDE, deferrable |
| Normalization | `11_normalization.md` | 1NF → BCNF, and when to denormalize |

## Complex production blueprints

The chapters above teach individual building blocks. For complete schemas that combine several relationship types and explain the architectural decisions, see [`../architecture_solutions/`](../architecture_solutions/README.md):

- E-commerce catalog, orders, payments, shipments, and inventory
- Multi-tenant SaaS memberships and role-based access control
- Booking and scheduling with concurrency-safe overlap prevention
- Content, nested comments, tags, likes, and follows
- Reliable event delivery with a transactional outbox and consumer inbox
- Double-entry accounting with deferred balance validation

## Core Principles

1. **Normalize first, denormalize intentionally** — Start with 3NF, then denormalize only for proven performance needs. See `11_normalization.md`.
2. **One fact, one place** — Each piece of data should be stored in exactly one table.
3. **Push integrity into the database** — `NOT NULL`, `CHECK`, `UNIQUE`, `FOREIGN KEY`, and `EXCLUDE` are the only rules that hold when a migration script, a psql session, or a second service writes to your tables. Application-level validation protects one code path; a constraint protects all of them.
4. **Surrogate keys** — Use `GENERATED ALWAYS AS IDENTITY` (not `SERIAL`) as PKs for simplicity and stability. See `10_keys_and_constraints.md`.
5. **Naming conventions** — Plural table names (`users`), singular column names, `snake_case` everywhere. Pick one and be consistent; the specific choice matters far less than the consistency.

## Decision Guide

Start here when you know the relationship but not the pattern:

| If... | Use | File |
|---|---|---|
| A row belongs to exactly one parent | FK on the child | `01` |
| Rows on both sides relate to many | Junction table with composite PK | `02` |
| You're splitting a wide table | Shared PK on the child | `03` |
| A row's parent is the same table | Adjacency list + recursive CTE, or `ltree` | `04` |
| A child could belong to several parent *tables* | Separate FK columns, or a shared supertype | `05` |
| Subtypes share some columns and differ in others | Class-table inheritance | `06` |
| You must answer "what did this look like last March?" | Effective dating with an exclusion constraint | `07` |
| Attributes differ per row and are rarely filtered | JSONB column | `08` |

## Gotchas Worth Memorizing

These are the ones that silently produce wrong data rather than an error:

| Gotcha | Consequence | Where |
|---|---|---|
| PostgreSQL does **not** auto-index foreign keys | Slow joins, and every parent DELETE seq-scans the child table | `01` |
| `BETWEEN` on validity periods is inclusive at both ends | Two "current" rows match the same date | `07` |
| `col IN ('A', NULL)` never matches NULL | CHECK constraint doesn't do what it reads like | `02` |
| `CASCADE` from an audited table to its history table | Deleting a row erases the audit trail meant to record the deletion | `07` |
| Class-table inheritance without a discriminator | One person can be a full-time employee *and* a contractor | `06` |
| PG native `INHERITS` doesn't inherit PKs or UNIQUE | Duplicate "primary keys" across child tables | `06` |
| `char(n)` blank-pads to a fixed width | `'A'` comes back as `'A '` | `09` |
| `timestamp` (without time zone) for real events | Ambiguous instants; DST bugs | `09` |
| `float` for money | `0.1 + 0.2 != 0.3` | `09` |

## Related

- `../architecture_solutions/` — complete multi-table blueprints for commerce, SaaS/RBAC, booking, social content, reliable events, and ledgers
- `../interview_sql_nodejs/` — the same material as interview Q&A, plus Node.js/`pg` specifics
