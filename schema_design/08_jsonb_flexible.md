# PATTERN 8: JSONB FLEXIBLE SCHEMA

Storing semi-structured data in PostgreSQL using JSONB. Best for attributes that vary by entity or change frequently.

## VISUALIZATION

```
  products
  +----+-------+-------+-----------------------------------+
  | id | name  | price | attributes (jsonb)                 |
  +----+-------+-------+-----------------------------------+
  | 1  | Shirt | 29.99 | {"color": "red", "size": "M",     |
  |    |       |       |  "material": "cotton"}             |
  | 2  | Laptop| 999   | {"cpu": "i7", "ram": "16GB",      |
  |    |       |       |  "storage": "512SSD", "screen":   |
  |    |       |       |  "15.6inch"}                       |
  +----+-------+-------+-----------------------------------+
```

Each product type has DIFFERENT attributes — no schema changes needed.

```sql
drop schema if exists jsonb_flex cascade;
create schema jsonb_flex;
```

## APPROACH A: JSONB for Variable Attributes

```sql
create table jsonb_flex.products (
    product_id int generated always as identity primary key,
    name       varchar(200) not null,
    price      numeric(10, 2) not null check (price >= 0),
    attributes jsonb not null default '{}'::jsonb
);

-- Insert with different attribute structures
insert into jsonb_flex.products (name, price, attributes) values
    ('T-Shirt', 29.99, '{"color": "red", "size": "M", "material": "cotton"}'::jsonb),
    ('Laptop', 999.99, '{"cpu": "i7", "ram_gb": 16, "storage": "512GB SSD", "screen_inches": 15.6}'::jsonb),
    ('Coffee Mug', 12.99, '{"color": "white", "capacity_ml": 350, "dishwasher_safe": true}'::jsonb);

-- Query: Find all red products
select * from jsonb_flex.products
where attributes @> '{"color": "red"}';

-- Query: Find laptops with >= 16GB RAM
-- CAUTION: this cast fails with "invalid input syntax for type integer" on ANY
-- row whose ram_gb is non-numeric or absent-but-present-as-a-string. There is
-- no schema forcing consistency, and PostgreSQL may evaluate the cast on rows
-- you expected the WHERE clause to filter out first.
select * from jsonb_flex.products
where (attributes->>'ram_gb')::int >= 16;

-- Safer: JSONPath compares numerically without an explicit cast and simply
-- doesn't match rows where the key is missing or the wrong type.
select * from jsonb_flex.products
where attributes @@ '$.ram_gb >= 16';

-- Query: Extract specific attributes
select name,
  attributes->>'color' as color,
  attributes->>'size' as size
from jsonb_flex.products;

-- Expression B-tree index: fast for ONE known key, and unlike GIN it also
-- supports ordering and range scans on that key.
create index idx_products_color
    on jsonb_flex.products ((attributes->>'color'));

-- Generic GIN index: supports @>, ?, ?|, ?&, @?, @@ on ANY key
create index idx_products_attrs_gin
    on jsonb_flex.products using gin (attributes);

-- Smaller, faster GIN variant — indexes only values-at-paths, not keys.
-- Supports @> @? @@ but NOT the key-existence operators (? ?| ?&).
create index idx_products_attrs_pathops
    on jsonb_flex.products using gin (attributes jsonb_path_ops);
```

### Choosing an index

| Index | Supports | Size | Use when |
|---|---|---|---|
| Expression B-tree on `->>'k'` | `=`, `<`, `>`, `ORDER BY` on that one key | Tiny | You always filter on the same key |
| GIN `jsonb_ops` (default) | `@>`, `?`, `?\|`, `?&`, `@?`, `@@` | Large | Ad-hoc queries over arbitrary keys |
| GIN `jsonb_path_ops` | `@>`, `@?`, `@@` only | ~2-3× smaller, faster | You only need containment |

**The limitation people hit:** a GIN index cannot serve a **range** query. `attributes @> '{"color":"red"}'` uses the index; `(attributes->>'price')::numeric > 100` does not — GIN indexes equality/containment, not ordering. If you need ranges on a JSONB field, add an expression index for that specific key, or promote it to a real column.

### Generated columns: the best of both

Since PostgreSQL 12, you can promote a hot JSONB key to a real, indexable, constrainable column that stays automatically in sync:

```sql
alter table jsonb_flex.products
    add column color text generated always as (attributes->>'color') stored;

create index idx_products_color_gen on jsonb_flex.products (color);
```

Now `WHERE color = 'red'` is an ordinary indexed column lookup — sortable, usable in a composite index, and visible to the query planner's statistics (which JSONB expressions largely are not). The JSONB stays the source of truth. This is the standard escape hatch when a "flexible" attribute turns out to be queried on every page load.

## APPROACH B: JSONB for User Settings / Preferences

```sql
create table jsonb_flex.user_settings (
    user_id    int primary key,
    settings   jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),

    -- Validate that settings is an object, not an array
    constraint chk_settings_is_object
        check (jsonb_typeof(settings) = 'object')
);

-- Insert nested settings
insert into jsonb_flex.user_settings (user_id, settings) values
    (1, '{"theme": "dark", "language": "en", "notifications": {"email": true, "push": false}, "layout": {"sidebar": "left", "density": "compact"}}'::jsonb);

-- Query: Users with dark theme
select * from jsonb_flex.user_settings
where settings->>'theme' = 'dark';

-- Query: Users with email notifications enabled
select * from jsonb_flex.user_settings
where settings @> '{"notifications": {"email": true}}';

-- Update a nested value.
-- 4th arg create_missing = false: only updates if the path ALREADY exists.
-- Pass true (the default) to create it when absent.
update jsonb_flex.user_settings
set settings = jsonb_set(settings, '{notifications,push}', 'true', true),
    updated_at = now()
where user_id = 1;

-- Merge several keys at once with || (shallow merge — replaces whole subtrees)
update jsonb_flex.user_settings
set settings = settings || '{"theme": "light", "language": "fr"}'::jsonb
where user_id = 1;

-- Deep merge needs jsonb_set per path, or a recursive helper.
-- `settings || '{"notifications":{"email":false}}'` REPLACES the entire
-- notifications object, silently dropping the "push" key.

-- Remove a key
update jsonb_flex.user_settings
set settings = settings #- '{notifications,sms}'
where user_id = 1;
```

> ⚠️ **`jsonb_set` returns NULL if any argument is NULL.** `jsonb_set(settings, path, NULL)` wipes the whole column rather than setting the key to JSON null. Guard with `coalesce`, and use `'null'::jsonb` when you genuinely mean JSON null.

**The write-amplification cost:** JSONB is stored as a single value, so updating one key rewrites the entire document — and if it's TOASTed (over ~2KB), that means rewriting out-of-line storage too. A 100KB settings blob updated on every page view generates 100KB of WAL each time. Frequently-updated fields belong in their own columns.

## APPROACH C: JSONB with Constraints (hybrid approach)

Store known required fields as columns, flexible ones as JSONB.

```sql
create table jsonb_flex.orders (
    order_id   int generated always as identity primary key,
    customer   varchar(200) not null,
    total      numeric(10, 2) not null check (total >= 0),
    status     varchar(20) not null check (status in ('pending', 'shipped', 'delivered', 'cancelled')),
    metadata   jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

-- Index for common metadata queries
create index idx_orders_metadata on jsonb_flex.orders using gin (metadata);
```

## APPROACH D: EAV Alternative with JSONB

Instead of Entity-Attribute-Value tables, use JSONB.

```sql
create table jsonb_flex.entity_data (
    entity_type varchar(50) not null,
    entity_id   int not null,
    data        jsonb not null,
    primary key (entity_type, entity_id)
);

-- Same structure for different entity types
insert into jsonb_flex.entity_data (entity_type, entity_id, data) values
    ('product', 1, '{"weight_kg": 0.5, "dimensions": {"cm": "30x20x5"}, "warranty_months": 12}'::jsonb),
    ('user', 42, '{"avatar_url": "https://...", "bio": "Developer", "social": {"twitter": "@dev"}}'::jsonb);
```

## JSONB OPERATORS CHEAT SHEET

| Operator | Description | Returns | Example | GIN-indexable |
|---|---|---|---|---|
| `@>` | contains | boolean | `'{"a":1,"b":2}'::jsonb @> '{"a":1}'` | ✅ |
| `<@` | contained by | boolean | `'{"a":1}'::jsonb <@ '{"a":1,"b":2}'` | ✅ |
| `?` | has key | boolean | `'{"a":1}'::jsonb ? 'a'` | ✅ (default ops only) |
| `?\|` | has any of these keys | boolean | `'{"a":1}'::jsonb ?\| array['a','b']` | ✅ (default ops only) |
| `?&` | has all these keys | boolean | `'{"a":1,"b":2}'::jsonb ?& array['a','b']` | ✅ (default ops only) |
| `->` | get by key/index | **jsonb** | `'{"a":1}'::jsonb -> 'a'` → `1` | ❌ |
| `->>` | get as text | **text** | `'{"a":1}'::jsonb ->> 'a'` → `'1'` | ❌ |
| `#>` | get by path | jsonb | `'{"a":{"b":1}}'::jsonb #> '{a,b}'` | ❌ |
| `#>>` | get by path as text | text | `'{"a":{"b":1}}'::jsonb #>> '{a,b}'` | ❌ |
| `@?` | JSONPath exists | boolean | `data @? '$.tags[*] ? (@ == "sale")'` | ✅ |
| `@@` | JSONPath predicate | boolean | `data @@ '$.ram_gb > 8'` | ✅ |
| `\|\|` | concatenate / merge (shallow) | jsonb | `'{"a":1}'::jsonb \|\| '{"b":2}'` | — |
| `-` | delete key | jsonb | `'{"a":1,"b":2}'::jsonb - 'a'` | — |
| `#-` | delete at path | jsonb | `'{"a":{"b":1}}'::jsonb #- '{a,b}'` | — |

**`->` vs `->>` is the distinction to internalize:** `->` returns jsonb (so `-> 'a'` on a string value gives `"hello"` **with** quotes), `->>` returns text (`hello`). Comparing a `->` result to a SQL string silently fails to match. Chain `->` for traversal and finish with `->>`: `data -> 'user' -> 'address' ->> 'city'`.

> ⚠️ **The `?` operator collides with query placeholders in most Node.js drivers.** `knex.raw("... where attrs ? 'color'")` will try to bind a parameter. Workarounds: escape it as `??` in knex, or use the function form `jsonb_exists(attrs, 'color')`. `pg` uses `$1` placeholders and is unaffected.

## WHEN TO USE JSONB vs RELATIONAL COLUMNS

### Use JSONB when:

- Attributes vary significantly between rows
- Schema changes are frequent
- Data is hierarchical or nested
- Attributes are rarely queried/filtered
- Settings, preferences, configurations

### Use relational columns when:

- The attribute is queried frequently
- You need referential integrity (FKs)
- The attribute needs constraints (CHECK, NOT NULL)
- You need to index and sort by the attribute
- The data structure is stable and well-known

### json vs jsonb

| | `json` | `jsonb` |
|---|---|---|
| Storage | Exact text copy | Parsed binary |
| Write | Faster (no parsing) | Slower (parse + sort keys) |
| Read/query | Reparses every access | Fast |
| Indexing | ❌ Not directly indexable | ✅ GIN |
| Duplicate keys | Preserved | Last one wins |
| Key order / whitespace | Preserved | Not preserved |

**Use `jsonb`.** The only reason for `json` is needing a byte-exact round-trip of the original document (e.g. storing a signed webhook payload whose signature covers the exact bytes).

### Validating structure

"Schemaless" doesn't have to mean "unvalidated" — CHECK constraints work on JSONB:

```sql
alter table jsonb_flex.user_settings add constraint chk_theme_valid
    check (settings->>'theme' is null or settings->>'theme' in ('light', 'dark'));

alter table jsonb_flex.user_settings add constraint chk_required_keys
    check (settings ?& array['theme', 'language']);

-- Type checking
alter table jsonb_flex.products add constraint chk_ram_is_number
    check (jsonb_typeof(attributes->'ram_gb') in ('number', 'null')
           or attributes->'ram_gb' is null);
```

### COMMON MISTAKES

- **Storing FK references as JSONB values.** `{"category_id": 5}` has no foreign key, no cascade, and no protection against pointing at a deleted row. Relationships belong in columns.
- **Using JSONB to avoid designing a schema.** If every row has the same keys, those are columns. JSONB is for attributes that genuinely *vary*, not for postponing decisions.
- **Not indexing JSONB columns used in WHERE.** A sequential scan that reparses a document per row is dramatically slower than a scan over ordinary columns.
- **Expecting GIN to help with range queries.** It won't — use an expression index or a generated column.
- **Casting JSONB to a numeric type in a WHERE clause** without guaranteeing every row's value is castable. One bad row breaks the whole query.
- **Frequently updating large JSONB documents.** The whole value is rewritten each time.
- **Using `json` when you meant `jsonb`.**
- **Assuming key order is preserved.** `jsonb` reorders keys; never rely on it for output formatting or hashing.
- **No CHECK constraints at all.** Flexible doesn't have to mean unvalidated.

### KEY TAKEAWAYS

- `jsonb`, never `json`, unless you need byte-exact preservation
- `->` gives jsonb, `->>` gives text — mixing them up produces silent non-matches
- GIN for containment; expression index or generated column for ranges and sorting
- When a JSONB key becomes hot, promote it to a generated column rather than restructuring
- JSONB is a good home for *variable* attributes and a bad home for *relationships*
