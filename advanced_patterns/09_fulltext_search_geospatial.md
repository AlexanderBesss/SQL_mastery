# PostgreSQL Full-Text Search & Geospatial with PostGIS

## Table of Contents

1. [Full-Text Search](#full-text-search)
2. [Geospatial with PostGIS](#geospatial-with-postgis)
3. [Combined Use Cases](#combined-use-cases)
4. [Gotchas](#gotchas)
5. [Key Takeaways](#key-takeaways)

---

## Full-Text Search

### Overview

PostgreSQL's built-in full-text search (FTS) provides robust text-searching capabilities without external dependencies. It supports stemming, ranking, and multiple languages.

### Core Types

| Type | Purpose |
|---|---|
| `tsvector` | A sorted list of distinct lexemes from a document |
| `tsquery` | A search query composed of lexemes and boolean operators (`&`, `\|`, `!`) |

### Converting Text to tsvector

```sql
-- Basic conversion (uses default 'english' config)
SELECT to_tsvector('english', 'The quick brown foxes jumped');
-- Result: 'brown':3 'fox':4 'jump':5 'quick':2

-- Note how "The" is stripped (stopword) and "foxes"/"jumped" are stemmed
```

```sql
-- Websearch-to-tsquery understands natural user input
SELECT websearch_to_tsquery('english', 'running & fast -shoe');
-- Result: 'run' & 'fast' & !'shoe'

-- Standard tsquery (manual boolean syntax)
SELECT to_tsquery('english', 'run & fast');
-- Result: 'run' & 'fast'
```

### The Match Operator

```sql
-- @@ matches tsvector against tsquery
SELECT to_tsvector('english', 'PostgreSQL is powerful') @@ to_tsquery('power & ful');
-- FALSE  (no word matches "ful")

SELECT to_tsvector('english', 'PostgreSQL is powerful') @@ to_tsquery('power');
-- TRUE  (stemmed match on "powerful" -> "power")
```

### Ranking

```sql
-- Rank documents by relevance (higher = more relevant)
SELECT
    title,
    ts_rank(document, query) AS rank
FROM articles
CROSS JOIN to_tsquery('english', 'database & optimization') AS query
WHERE document @@ query
ORDER BY rank DESC;
```

```sql
-- rank_cdff uses cover density: penalizes far-apart matches
SELECT
    title,
    ts_rank_cd(document, query) AS rank
FROM articles
CROSS JOIN to_tsquery('english', 'sql query') AS query
WHERE document @@ query
ORDER BY rank DESC
LIMIT 10;
```

```sql
-- Weighted ranking: assign importance to document sections
-- Weights: A (highest), B, C, D (lowest)
SELECT
    title,
    ts_rank(
        setweight(to_tsvector('english', title), 'A') ||
        setweight(to_tsvector('english', summary), 'B') ||
        setweight(to_tsvector('english', body), 'C'),
        query
    ) AS rank
FROM articles
CROSS JOIN to_tsquery('english', 'performance') AS query
WHERE
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', summary), 'B') ||
    setweight(to_tsvector('english', body), 'C')
    @@ query
ORDER BY rank DESC;
```

### Dedicated tsvector Columns

For large tables, materialize the tsvector to avoid recomputing on every query.

```sql
-- Add a tsvector column
ALTER TABLE articles ADD COLUMN search_vector tsvector;

-- Populate it
UPDATE articles
SET search_vector =
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C');
```

```sql
-- Keep it in sync with a trigger
CREATE FUNCTION articles_tsv_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update
    BEFORE INSERT OR UPDATE ON articles
    FOR EACH ROW
    EXECUTE FUNCTION articles_tsv_update();
```

```sql
-- Query against the precomputed column
SELECT title, ts_rank(search_vector, query) AS rank
FROM articles
CROSS JOIN to_tsquery('english', 'indexing') AS query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

### GIN Indexes for FTS

```sql
-- GIN index on tsvector (fastest for FTS)
CREATE INDEX idx_articles_search ON articles USING GIN (search_vector);

-- GIN index on computed expression (no extra column needed, but slower writes)
CREATE INDEX idx_articles_expr ON articles
    USING GIN (to_tsvector('english', title || ' ' || body));

--GIN vs GiST comparison:
-- GIN:  faster queries, slower writes, larger index
-- GiST: slower queries, faster writes, smaller index
-- For FTS, GIN is almost always the right choice
```

```sql
-- Verify the index is being used
EXPLAIN (ANALYZE, BUFFERS)
SELECT title FROM articles
WHERE search_vector @@ to_tsquery('english', 'postgresql');

-- Expected output should show:
-- Bitmap Index Scan on idx_articles_search
--   -> Index Scan using idx_articles_search
```

### Phrase Search with tsquery

```sql
-- Adjacency operator: <-> means "immediately next to"
SELECT to_tsvector('english', 'the quick brown fox') @@ to_tsquery('quick <-> brown');
-- TRUE

-- Flexible adjacency: A <->2 B allows up to 2 words between A and B
SELECT to_tsvector('english', 'quick and very brown fox') @@ to_tsquery('quick <->3 brown');
-- TRUE
```

### Headline Generation

```sql
SELECT headline(
    'PostgreSQL provides powerful full-text search capabilities',
    to_tsquery('postgresql & search'),
    'StartSel = [ ' || 'StopSel = ] ' || 'MaxWords = 30' || 'MinWords = 15'
) AS excerpt;
-- Result: [PostgreSQL] provides powerful [full-text search] capabilities
```

---

## Geospatial with PostGIS

### Installation

```sql
-- Enable the PostGIS extension (one-time per database)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Verify installation
SELECT PostGIS_Full_Version();

-- Optional: add raster and topology support
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
```

### Geometry vs Geography

```
+-------------------+----------------------+----------------------+
| Feature           | geometry             | geography            |
+-------------------+----------------------+----------------------+
| Model             | Flat (planar)        | Round (spherical)    |
| SRID              | Any (2D/3D/4D)       | Always 4326 (WGS 84) |
| Units             | Same as SRID units   | Meters               |
| Performance       | Faster               | Slower               |
| Best for          | Local/regional data  | Global data          |
| Functions         | Full ST_* suite      | Subset of ST_*       |
+-------------------+----------------------+----------------------+
```

```sql
-- Geometry: flat-earth model, use with projected CRS
CREATE TABLE buildings (
    id serial PRIMARY KEY,
    name text,
    location geometry(POLYGON, 26918)  -- NAD83 / UTM zone 18N (meters)
);

-- Geography: round-earth model, always WGS 84
CREATE TABLE cities (
    id serial PRIMARY KEY,
    name text,
    location geography(POINT, 4326)  -- lon/lat in degrees
);
```

### Creating Spatial Data

```sql
-- WKT (Well-Known Text)
INSERT INTO cities (name, location) VALUES
    ('New York', ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)')),
    ('London',   ST_GeographyFromText('SRID=4326;POINT(-0.1278 51.5074)')),
    ('Tokyo',    ST_GeographyFromText('SRID=4326;POINT(139.6917 35.6895)'));

-- WKB (Well-Known Binary) for efficient storage
INSERT INTO buildings (name, location) VALUES
    ('Tower A', ST_GeomFromText('POLYGON((0 0, 0 100, 100 100, 100 0, 0 0))', 26918));

-- From lon/lat columns (common migration pattern)
INSERT INTO cities (name, location)
SELECT name, ST_MakePoint(longitude, latitude)::geography
FROM legacy_city_table;
```

### Common Functions

#### Distance Calculations

```sql
-- Geography: distance in meters (uses great-circle)
SELECT
    c1.name, c2.name,
    ST_Distance(c1.location, c2.location) AS distance_meters
FROM cities c1
JOIN cities c2 ON c1.id < c2.id;

-- Geometry: distance in SRID units (meters for projected CRS)
SELECT
    b.name,
    ST_Distance(b.location, ST_GeomFromText('POINT(50 50)', 26918)) AS dist
FROM buildings b
ORDER BY dist;
```

```sql
-- Find all cities within 10,000 km of New York
SELECT name,
    ST_Distance(location,
        ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)')
    ) / 1000 AS distance_km
FROM cities
WHERE ST_DWithin(
    location,
    ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)'),
    10000000  -- 10,000 km in meters
);
```

#### Spatial Relationships

```sql
-- Does point A fall within polygon B?
SELECT ST_Within(
    ST_PointFromText('POINT(-74.006 40.7128)', 4326),
    ST_Buffer(ST_PointFromText('POINT(-74.0 40.7)', 4326), 0.01)
);
-- TRUE

-- Do two geometries share any space?
SELECT ST_Intersects(
    ST_GeomFromText('POLYGON((0 0, 0 10, 10 10, 10 0, 0 0))', 4326),
    ST_GeomFromText('POLYGON((5 5, 5 15, 15 15, 15 5, 5 5))', 4326)
);
-- TRUE

-- Other relationship functions:
-- ST_Contains(A, B)    -- A fully contains B
-- ST_Crosses(A, B)     -- A and B intersect but neither contains the other
-- ST_Touches(A, B)     -- share a boundary point but no interior
-- ST_Overlaps(A, B)    -- intersect but neither contains the other
-- ST_Disjoint(A, B)    -- do not intersect at all
-- ST_DWithin(A, B, d)  -- within distance d (uses index)
```

#### Geometry Construction & Transformation

```sql
-- Create a buffer around a point
SELECT ST_AsText(ST_Buffer(
    ST_PointFromText('POINT(-74.006 40.7128)', 4326),
    0.05  -- ~5.5 km at this latitude
));

-- Get the centroid of a polygon
SELECT ST_AsText(ST_Centroid(location)) FROM buildings;

-- Transform between coordinate systems
SELECT ST_AsText(ST_Transform(
    ST_GeomFromText('POINT(-74.006 40.7128)', 4326),
    3857  -- Web Mercator
));

-- Extract coordinates
SELECT
    ST_X(location::geometry) AS lon,
    ST_Y(location::geometry) AS lat
FROM cities;
```

### Spatial Indexes

```sql
-- GiST index for geometry/geography columns
CREATE INDEX idx_cities_location ON cities USING GIST (location);
CREATE INDEX idx_buildings_location ON buildings USING GIST (location);

-- The GiST index enables fast bounding-box pre-filtering
-- All ST_* spatial operators automatically use it
```

```
Query execution with spatial index:

  WHERE ST_DWithin(location, target_point, 10000)

  Step 1: GiST index finds bounding boxes overlapping the search area
  Step 2: Exact ST_DWithin filter on the reduced candidate set

  Without index:
    Full table scan -> exact distance for every row -> O(n)

  With GiST index:
    Bounding-box lookup -> exact distance for few rows -> O(log n + k)
```

```sql
-- Verify index usage
EXPLAIN (ANALYZE, BUFFERS)
SELECT name FROM cities
WHERE ST_DWithin(
    location,
    ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)'),
    5000000
);

-- Look for: "Index Scan using idx_cities_location on cities"
```

### K-Nearest Neighbors

```sql
-- Find 5 nearest cities to a point using KNN (<->) operator
SELECT name,
    ST_Distance(location,
        ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)')
    ) / 1000 AS distance_km
FROM cities
ORDER BY location <-> ST_GeographyFromText('SRID=4326;POINT(-74.006 40.7128)')
LIMIT 5;

-- The <-> operator uses the index for an efficient KNN search
```

---

## Combined Use Cases

### Use Case 1: Location-Based Search with Keywords

```sql
-- Find coffee shops matching a description within a radius
CREATE TABLE coffee_shops (
    id serial PRIMARY KEY,
    name text,
    description text,
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))
    ) STORED,
    location geography(POINT, 4326) NOT NULL
);

CREATE INDEX idx_coffee_search ON coffee_shops USING GIN (search_vector);
CREATE INDEX idx_coffee_location ON coffee_shops USING GIST (location);

-- Query: "latte" within 2 km of a point
SELECT
    name,
    description,
    ST_Distance(location, search_point) / 1000 AS distance_km,
    ts_rank(search_vector, search_query) AS relevance
FROM coffee_shops
CROSS JOIN LATERAL (
    SELECT
        ST_GeographyFromText('SRID=4326;POINT(-73.9856 40.7484)') AS search_point,
        to_tsquery('english', 'latte & cozy') AS search_query
) p
WHERE search_vector @@ p.search_query
  AND ST_DWithin(location, p.search_point, 2000)
ORDER BY
    ts_rank(search_vector, p.search_query) DESC,
    ST_Distance(location, p.search_point) ASC
LIMIT 20;
```

### Use Case 2: Real Estate Listings

```sql
CREATE TABLE properties (
    id serial PRIMARY KEY,
    title text,
    description text,
    price numeric,
    address text,
    location geography(POINT, 4326),
    search_vector tsvector
);

-- Combined trigger for tsvector
CREATE FUNCTION properties_tsv_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.address, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER properties_tsv_update_trigger
    BEFORE INSERT OR UPDATE ON properties
    FOR EACH ROW EXECUTE FUNCTION properties_tsv_update();

CREATE INDEX idx_props_search ON properties USING GIN (search_vector);
CREATE INDEX idx_props_location ON properties USING GIST (location);

-- Search: "2 bedroom" within 5 km of Central Park, under $500k
SELECT id, title, price,
    ST_Distance(location, park) / 1000 AS km_away,
    ts_rank(search_vector, q) AS rank
FROM properties
CROSS JOIN LATERAL (
    SELECT
        ST_GeographyFromText('SRID=4326;POINT(-73.9654 40.7829)') AS park,
        to_tsquery('english', 'bedroom') AS q
) s
WHERE search_vector @@ s.q
  AND ST_DWithin(location, s.park, 5000)
  AND price < 500000
ORDER BY rank DESC, km_away ASC;
```

### Use Case 3: Event Discovery

```sql
-- Find events near a user matching their interests
WITH user_location AS (
    SELECT ST_GeographyFromText('SRID=4326;POINT(-118.2437 34.0522)') AS loc
)
SELECT
    e.name,
    e.category,
    e.description,
    ST_Distance(e.location, u.loc) / 1000 AS km,
    ts_rank(e.tags_vector, to_tsquery('english', 'music | art')) AS score
FROM events e, user_location u
WHERE e.tags_vector @@ to_tsquery('english', 'music | art')
  AND ST_DWithin(e.location, u.loc, 10000)
  AND e.event_date >= CURRENT_DATE
ORDER BY score DESC, km ASC
LIMIT 10;
```

---

## Gotchas

### FTS Gotchas

```
1. Stopwords are language-specific.
   The word "the" is a stopword in English but not in all languages.
   Check with: SELECT * FROM pg_ts_config;

2. Stemming can produce unexpected matches.
   "running" and "runs" both stem to "run", which is usually desired
   but can cause false positives in technical text.

3. websearch_to_tsquery handles phrases in quotes.
    websearch_to_tsquery('english', '"full text" search')
    produces a phrase query. Quoted phrases are preserved exactly.
    For unquoted tokens, it strips only leading/trailing punctuation.
    to_tsquery does NOT handle quotes the same way.

4. tsvector columns need triggers to stay in sync.
   Forgetting the trigger means INSERTs/UPDATEs silently produce stale data.
   Consider GENERATED ALWAYS AS ... STORED (PostgreSQL 12+) as an alternative.

5. GIN indexes do not support partial matching.
   The query must match the full lexeme. "prog" will not match "program".
   Use pg_trgm (trigram) extension for prefix/partial matching.

6. Null values in tsvector columns.
   NULL tsvector does not match any query. Use COALESCE in triggers.
```

### PostGIS Gotchas

```
1. Geometry vs geography distance units.
   Geometry returns distance in the SRID's units (often meters for projected CRS).
   Geography always returns meters. Mixing them causes subtle bugs.

2. SRID mismatch errors.
   PostGIS will reject operations between geometries with different SRIDs.
   Always verify: SELECT Find_SRID('public', 'my_table', 'location');

3. Geography is limited to WGS 84 (SRID 4326).
   You cannot create a geography column with a different SRID.
   Use geometry with a projected CRS for non-WGS84 data.

4. ST_DWithin with geography requires distance in meters.
   ST_DWithin(geog, geog, distance_meters) -- not km, not miles

5. Spatial queries without indexes are slow.
   A full-table scan comparing every row's geometry is O(n).
   Always create a GiST index on spatial columns.

6. The <-> KNN operator works with both geometry and geography (since PostGIS 2.2.0).
    For geography, distances are in meters. For geometry, distances are in SRID units.

7. Invalid geometries cause errors.
   Use ST_IsValid() to check. Use ST_MakeValid() to fix.
   Common issue: self-intersecting polygons from GPS traces.
```

---

## Key Takeaways

```
Full-Text Search:
  - Use tsvector/tsquery for structured text search
  - Prefer dedicated tsvector columns with triggers for large tables
  - GIN indexes are essential for performance on FTS
  - Use setweight() to rank different document sections differently
  - websearch_to_tsquery() is more user-friendly than to_tsquery()
  - For prefix/partial matching, combine FTS with pg_trgm

PostGIS:
  - Use geography for global data (lon/lat), geometry for local projected data
  - Always create GiST indexes on spatial columns
  - ST_DWithin() is the preferred spatial filter (uses index efficiently)
  - ST_Distance() returns meters for geography, SRID units for geometry
  - Use <-> operator for K-Nearest-Neighbor queries on geometry
  - Validate geometries with ST_IsValid() before complex operations

Combined:
  - FTS + PostGIS enables rich location-aware search applications
  - Use CTEs or LATERAL joins to combine text and spatial filters cleanly
  - Index both dimensions: GIN for text, GiST for spatial
  - Order by text relevance first, then distance, or weight both in a composite score
```

### Performance Checklist

```
  [ ] GIN index on tsvector column
  [ ] GiST index on geometry/geography column
  [ ] Use ST_DWithin for radius filters (index-friendly)
  [ ] Use <-> for KNN (index-friendly, geometry only)
  [ ] Verify with EXPLAIN (ANALYZE) that indexes are used
  [ ] Avoid functions on indexed columns in WHERE (breaks index usage)
  [ ] Consider partial indexes for active/recent records
  [ ] Monitor index bloat with pg_stat_user_indexes
```

### Quick Reference

```sql
-- FTS query pattern
SELECT col, ts_rank(vec, q) AS r
FROM table
CROSS JOIN to_tsquery('config', 'term1 & term2') q
WHERE vec @@ q
ORDER BY r DESC;

-- Spatial query pattern
SELECT col, ST_Distance(geom, target) AS d
FROM table
WHERE ST_DWithin(geom, target, radius)
ORDER BY geom <-> target  -- KNN
LIMIT n;

-- Combined pattern
SELECT col,
    ts_rank(vec, q) AS relevance,
    ST_Distance(geom, target) AS distance
FROM table
CROSS JOIN to_tsquery('config', 'terms') q
WHERE vec @@ q
  AND ST_DWithin(geom, target, radius)
ORDER BY relevance DESC, distance ASC;
```
