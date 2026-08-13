# PostgreSQL 17 Data Types

Reference: https://www.postgresql.org/docs/current/datatype.html

| Name | Aliases | Description |
|------|---------|-------------|
| bigint | int8 | signed eight-byte integer, -9223372036854775808 to 9223372036854775807 |
| bigserial | serial8 | autoincrementing eight-byte integer |
| bit [(n)] | | fixed-length bit string |
| bit varying [(n)] | varbit [(n)] | variable-length bit string |
| boolean | bool | logical Boolean (true/false) |
| box | | rectangular box on a plane |
| bytea | | binary data ("byte array") |
| character [(n)] | char [(n)] | fixed-length character string |
| character varying [(n)] | varchar [(n)] | variable-length character string |
| cidr | | IPv4 or IPv6 network address |
| circle | | circle on a plane |
| date | | calendar date (year, month, day) |
| double precision | float8 | double precision floating-point number (8 bytes) |
| inet | | IPv4 or IPv6 host address |
| integer | int, int4 | signed four-byte integer, -2147483648 to 2147483647 |
| interval [fields] [(p)] | | time span |
| json | | textual JSON data |
| jsonb | | binary JSON data, decomposed |
| line | | infinite line on a plane |
| lseg | | line segment on a plane |
| macaddr | | MAC (Media Access Control) address |
| macaddr8 | | MAC (Media Access Control) address (EUI-64 format) |
| money | | currency amount |
| numeric [(p, s)] | decimal [(p, s)] | exact numeric of selectable precision |
| path | | geometric path on a plane |
| pg_lsn | | PostgreSQL Log Sequence Number |
| pg_snapshot | | user-level transaction ID snapshot |
| point | | geometric point on a plane |
| polygon | | closed geometric path on a plane |
| real | float4 | single precision floating-point number (4 bytes) |
| smallint | int2 | signed two-byte integer, -32768 to 32767 |
| smallserial | serial2 | autoincrementing two-byte integer |
| serial | serial4 | autoincrementing four-byte integer |
| text | | variable-length character string |
| time [(p)] [without time zone] | | time of day (no time zone) |
| time [(p)] with time zone | timetz | time of day, including time zone |
| timestamp [(p)] [without time zone] | | date and time (no time zone) |
| timestamp [(p)] with time zone | timestamptz | date and time, including time zone |
| tsquery | | text search query |
| tsvector | | text search document |
| txid_snapshot | | user-level transaction ID snapshot (deprecated; see pg_snapshot) |
| uuid | | universally unique identifier |
| xml | | XML data |

---

# SQL Types (Common Across Databases)

## Numeric Data Types

| Type | Description |
|------|-------------|
| INT | signed four-byte integer |
| SMALLINT | signed two-byte integer |
| TINYINT | signed one-byte integer (MySQL-specific) |
| BIGINT | signed eight-byte integer |
| FLOAT | approximate floating-point number |
| REAL | single precision floating-point (4 bytes) |
| DOUBLE PRECISION | double precision floating-point (8 bytes) |
| DECIMAL(p, s) | exact numeric with fixed precision and scale |
| NUMERIC(p, s) | same as DECIMAL, exact numeric of selectable precision |

## Character String Data Types

| Type | Description |
|------|-------------|
| CHAR(n) | fixed-length string, padded with spaces |
| VARCHAR(n) | variable-length string up to n characters |
| TEXT | variable-length string with no length limit |

## Binary Data Types

| Type | Description |
|------|-------------|
| BINARY(n) | fixed-length binary string |
| VARBINARY(n) | variable-length binary string |
| BLOB | binary large object |

## Date and Time Data Types

| Type | Description |
|------|-------------|
| DATE | calendar date (year-month-day) |
| TIME | time of day (hours:minutes:seconds) |
| TIMESTAMP | date and time combination |
| DATETIME | date and time (MySQL-specific, no time zone) |
| YEAR | year value (MySQL-specific) |

## Boolean Data Type

| Type | Description |
|------|-------------|
| BOOLEAN | true or false value |

## Miscellaneous Data Types

| Type | Description |
|------|-------------|
| UUID | universally unique identifier (128-bit) |
| ARRAY | ordered collection of same-type elements |
| JSON | textual JSON data |
| JSONB | binary JSON data (PostgreSQL-specific, indexed) |
| XML | XML formatted data |
