# PATTERN 9: CHOOSING DATA TYPES

Type choices are the hardest schema decisions to reverse — changing a column type rewrites the table and takes an `ACCESS EXCLUSIVE` lock. These are the choices that matter, and the defaults worth memorizing.

## THE SHORT VERSION

| Need | Use | Not |
|---|---|---|
| Any string | `text` | `varchar(n)` with an arbitrary `n` |
| A point in time | `timestamptz` | `timestamp` |
| Money | `numeric(12,2)` | `float` / `real` / `double precision` |
| A surrogate key | `int`/`bigint GENERATED ALWAYS AS IDENTITY` | `serial` |
| A public-facing id | `uuid` (v7) | sequential `int` |
| A fixed set of values | `text` + `CHECK` | `enum` (usually) |
| True/false | `boolean` | `char(1)`, `smallint` |
| A validity period | `daterange` / `tstzrange` | paired from/to columns |
| An IP address | `inet` | `varchar(45)` |

---

## TEXT: `text` vs `varchar(n)` vs `char(n)`

In PostgreSQL these three are **the same underlying storage**. There is no performance benefit to `varchar(50)` over `text` — unlike in MySQL or SQL Server, a shorter declared length does not make anything faster or smaller.

```sql
-- These perform identically
name text
name varchar(500)

-- This one is different, and worse
code char(10)   -- blank-padded to exactly 10 characters
```

`char(n)` pads with spaces on write and strips them on comparison, which produces genuinely surprising behavior:

```sql
select 'A'::char(2) = 'A';           -- true (padding ignored in comparison)
select length('A'::char(2));         -- 1
select length('A'::char(2) || '|');  -- 3  ← the padding is really there
select 'A'::char(2) || '|';          -- 'A |'
```

**Never use `char(n)`.** It exists for COBOL-era fixed-width compatibility. Even for genuinely fixed-length data like a 3-letter currency code, use `varchar(3)` or `text CHECK (length(x) = 3)`.

**So `text` or `varchar(n)`?** Use `varchar(n)` only when the limit is a real business rule you want enforced (a `varchar(2)` US state code). Use `text` otherwise. The practical argument for `text`: growing a `varchar(50)` to `varchar(100)` requires a migration and, before PG 12, a full table rewrite — whereas a `CHECK (length(x) <= 50)` constraint can be dropped and re-added without touching the data.

```sql
-- Flexible: the limit can change without rewriting the table
description text,
constraint chk_description_length check (length(description) <= 5000)
```

---

## TIMESTAMPS: `timestamptz` is almost always right

This is the single most consequential type choice in most schemas.

| Type | Stores | Behavior |
|---|---|---|
| `timestamp` (a.k.a. `timestamp without time zone`) | Wall-clock reading, no zone | A bare number. `'2024-03-10 02:30'` may not exist or may occur twice. |
| `timestamptz` (`timestamp with time zone`) | **An absolute instant** (UTC internally) | Converted to/from the session's `TimeZone` on input and output |

The naming is actively misleading: `timestamptz` does **not** store a time zone. It stores an unambiguous point in time — which is what almost every event actually is. `created_at`, `updated_at`, `deleted_at`, `logged_in_at`, `published_at`: all `timestamptz`.

```sql
set timezone = 'UTC';
select '2024-07-01 12:00:00'::timestamptz;   -- 2024-07-01 12:00:00+00
set timezone = 'America/New_York';
select '2024-07-01 12:00:00'::timestamptz;   -- 2024-07-01 08:00:00-04
-- Same instant, rendered for the reader. That is the whole feature.
```

Both types occupy 8 bytes; there is no storage saving from `timestamp`.

**When plain `timestamp` or `date` is correct:** a value that is deliberately *not* tied to an instant. "The meeting is at 09:00 local time, wherever you are" is a wall-clock time. A birth date is a `date` — it does not shift when the person travels. A store's opening hours are `time`.

**For future events in a specific place,** store the local time *and* the zone name, not a UTC instant. Governments change time zone rules; a meeting scheduled for "2027-03-15 09:00 in Berlin" must remain 09:00 in Berlin even if the EU abolishes DST in the meantime.

```sql
create table meetings (
    starts_at_local timestamp not null,
    time_zone       text not null,   -- 'Europe/Berlin' — an IANA name, not '+02:00'
    -- Resolve to an instant at query time:
    --   starts_at_local AT TIME ZONE time_zone
    constraint chk_tz check (now() at time zone time_zone is not null)
);
```

Also prefer `now()` (transaction start time) over `clock_timestamp()` (actual current time) for `created_at` defaults — every row inserted in one transaction should share a timestamp.

---

## NUMBERS

| Type | Size | Range / precision | Use for |
|---|---|---|---|
| `smallint` | 2 B | ±32,767 | Rarely worth it |
| `int` | 4 B | ±2.1 billion | Default integer, most FKs |
| `bigint` | 8 B | ±9.2 quintillion | High-volume ids, event tables |
| `numeric(p,s)` | variable | Exact decimal | **Money**, anything requiring exactness |
| `real` / `double precision` | 4/8 B | Approximate binary float | Scientific data, measurements |

**Never store money in a float.** Binary floating point cannot represent most decimal fractions:

```sql
select 0.1::float8 + 0.2::float8 = 0.3::float8;   -- false
select 0.1::numeric + 0.2::numeric = 0.3::numeric; -- true
```

Two acceptable approaches: `numeric(12,2)`, or an integer count of the smallest unit (cents). `numeric` is more readable and arithmetic is exact; integer cents is faster and impossible to accidentally round. Both beat floats.

**A `pg`/Node.js gotcha:** the driver returns `numeric` as a **JavaScript string**, because JS numbers are IEEE 754 doubles and would lose precision. Don't `parseFloat` it and then do arithmetic — that reintroduces exactly the problem `numeric` prevented. Use a decimal library, or compute in SQL.

**`int` vs `bigint` for primary keys:** 2.1 billion sounds like plenty until you remember that ids are consumed by failed inserts and rolled-back transactions too. For anything append-heavy — events, logs, messages, audit rows — start with `bigint`. Migrating `int` → `bigint` on a large table is a full rewrite with a long exclusive lock, and it's a rite of passage nobody enjoys. The extra 4 bytes is cheap insurance.

---

## BOOLEAN

Use `boolean`. It accepts `true`/`false`/`NULL` and is one byte.

Be deliberate about whether NULL is meaningful. `is_active boolean` with three possible states (true, false, unknown) is usually a modelling error — add `NOT NULL DEFAULT false`. Where the third state is real ("has the user consented? not asked yet"), the nullability is carrying information and should be documented.

---

## ENUM vs CHECK vs LOOKUP TABLE

Three ways to constrain a column to a fixed set. This comes up constantly and the tradeoffs are genuinely close.

```sql
-- 1. Native enum
create type order_status as enum ('pending', 'paid', 'shipped');
create table orders (status order_status not null);

-- 2. text + CHECK
create table orders (
    status text not null check (status in ('pending', 'paid', 'shipped'))
);

-- 3. Lookup table
create table order_statuses (code text primary key, label text not null, sort_order int);
create table orders (status text not null references order_statuses (code));
```

| | Enum | CHECK | Lookup table |
|---|---|---|---|
| Add a value | `ALTER TYPE ... ADD VALUE` (cannot run in a transaction block before PG 12; still cannot be removed) | Drop + recreate constraint | `INSERT` |
| Remove a value | ❌ Impossible without recreating the type | Easy | `DELETE` |
| Reorder | ❌ Impossible | n/a | Change `sort_order` |
| Attach metadata (label, color) | ❌ | ❌ | ✅ |
| Sorts by | Declaration order | Alphabetical | Whatever you want |
| Storage | 4 bytes | Full text | Full text (or FK to an int) |
| Visible to the app | Needs a catalog query | Needs constraint parsing | Plain `SELECT` |

**Default to `text` + `CHECK`.** It's the easiest to change, and schema values change more often than anyone expects. Use a **lookup table** as soon as the values need any accompanying data — a display label, a sort order, an "is this still offered?" flag. Use an **enum** when the set is genuinely fixed forever and you want the 4-byte storage and natural ordering (`'low' < 'medium' < 'high'`).

The deciding question is usually: *will a non-engineer ever need to add a value?* If yes, lookup table.

---

## SPECIALIZED TYPES WORTH KNOWING

PostgreSQL has types that replace hand-rolled validation. Using them means the database rejects malformed data rather than your application discovering it later.

```sql
create table examples (
    ip          inet,        -- IPv4/IPv6 address, with containment operators (<<=)
    network     cidr,        -- network block
    mac         macaddr,
    period      tstzrange,   -- a time range, with && (overlaps) and @> (contains)
    price_band  int4range,
    tags        text[],      -- array; GIN-indexable with && and @>
    doc         tsvector,    -- full-text search
    location    point,       -- or PostGIS geography for real geospatial work
    id          uuid,
    settings    jsonb
);
```

**Ranges** (`daterange`, `tstzrange`, `numrange`) are the standout. They replace a pair of `from`/`to` columns with a single value that can't be internally inconsistent, and they unlock `EXCLUDE USING gist` for overlap prevention — see `07_temporal.md`.

**Arrays** are convenient and frequently misused. `text[]` is fine for a genuinely atomic list with no identity of its own (tags on a blog post). It is *not* a substitute for a junction table: you get no foreign keys, no per-element constraints, and no way to store attributes about the relationship. If you ever need "when was this tag added," you needed a table.

**`inet` over `varchar(45)`:** correct validation, 7-19 bytes instead of up to 45, and subnet operators (`WHERE ip <<= '10.0.0.0/8'`).

---

## COLUMN ORDER AFFECTS ROW SIZE

A detail that matters only at scale, but is free to get right. PostgreSQL aligns columns to their type's boundary, and padding accumulates:

```sql
-- 24 bytes per row: each bool is followed by 7 bytes of padding
create table padded (a boolean, b bigint, c boolean, d bigint);

-- 18 bytes per row: same columns, fixed-width types grouped by size
create table packed (b bigint, d bigint, a boolean, c boolean);
```

**Rule:** declare largest fixed-width types first (`bigint`, `timestamptz`, `numeric`), then smaller ones (`int`, `smallint`), then `boolean`, then variable-length types (`text`, `jsonb`). On a billion-row table this is gigabytes; on a thousand-row table it is noise. Don't contort a readable schema for it — just default to the ordering when nothing else dictates one.

---

## CHANGING A TYPE LATER

Not all `ALTER TYPE` operations are equal:

```sql
-- Instant (metadata only) — the binary representation is unchanged
alter table t alter column c type text;             -- from varchar
alter table t alter column c type varchar(200);     -- from varchar(100), widening

-- Full table rewrite + ACCESS EXCLUSIVE lock — blocks all reads and writes
alter table t alter column c type bigint;           -- from int
alter table t alter column c type numeric(12,4);    -- changing precision
```

Widening `varchar` or dropping its limit is free. Changing an integer's width is not. For a large table, the safe pattern is the expand/contract migration from `../interview_sql_nodejs/03_orms_and_query_builders.md` Q6: add a new column, backfill in batches, dual-write, switch reads, drop the old one.

---

### COMMON MISTAKES

- **`timestamp` instead of `timestamptz`** for real events. The bug appears at a DST boundary or when a second server runs in a different zone, months after deployment.
- **`float` for money.** Rounding errors that accumulate and never reconcile.
- **`char(n)`** for anything. Silent space padding.
- **`varchar(255)`** as a reflex. It's a MySQL artifact with no meaning in PostgreSQL; either the limit is a real rule or it should be `text`.
- **`int` primary keys on append-heavy tables.** The migration to `bigint` is painful and always happens at the worst time.
- **`varchar` for structured values** that have a dedicated type: IPs, MACs, UUIDs, ranges.
- **`enum` for a set that will change.** Values cannot be removed, and before PG 12 additions couldn't run inside a transaction — meaning inside a migration.
- **Storing a UTC offset (`+02:00`) instead of a zone name (`Europe/Berlin`)** for future events. An offset is a fact about one instant, not about a place.

### KEY TAKEAWAYS

- `text`, `timestamptz`, `numeric`, `bigint`, `boolean` are the right defaults
- Use PostgreSQL's specialized types — they validate for free
- Type changes are expensive; choose deliberately up front
- The type system is your cheapest constraint: a column that cannot hold bad data never needs a check for it
