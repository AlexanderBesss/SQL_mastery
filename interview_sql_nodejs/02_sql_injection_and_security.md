# SQL Injection and Security

## Q1: How do you prevent SQL injection in Node.js?

**Answer:**
Use **parameterized queries** (prepared statements). Never concatenate user input into SQL strings.

```javascript
const { Pool } = require('pg');
const pool = new Pool();

// ❌ VULNERABLE — string concatenation
const badQuery = `SELECT * FROM users WHERE email = '${req.body.email}'`;
await pool.query(badQuery);

// ✅ SAFE — parameterized query
const { rows } = await pool.query(
  'SELECT * FROM users WHERE email = $1',
  [req.body.email]
);

// ✅ SAFE — with named parameters (using knex)
const result = await knex('users')
  .where('email', req.body.email)
  .select();
```

**Why it works:** The database driver sends the query structure and parameters separately. The DB treats parameters as data, never as executable SQL.

**Key point:** Even `UNION`, `DROP TABLE`, or `' OR '1'='1` injected into a parameterized value is treated as a literal string.

---

## Q2: What about dynamic column names or table names? Can you parameterize those?

**Answer:**
No — you cannot parameterize identifiers (table names, column names). Use **whitelist validation** instead.

```javascript
// ❌ DANGER — table name cannot be parameterized
await pool.query(`SELECT * FROM ${req.body.table}`);

// ✅ SAFE — whitelist allowed tables
const ALLOWED_TABLES = ['users', 'products', 'orders'];
const table = req.body.table;

if (!ALLOWED_TABLES.includes(table)) {
  throw new Error(`Invalid table: ${table}`);
}
// `table` is now provably one of three literals we wrote ourselves
await pool.query(`SELECT * FROM ${table}`);

// ✅ ALSO SAFE — pg-format's %I escapes and quotes an identifier
const format = require('pg-format');
await pool.query(format('SELECT * FROM %I', table));

// ✅ knex escapes identifiers passed via ??
await knex.raw('SELECT * FROM ??', [table]);
```

The same applies to `ORDER BY`, which is a very common real-world case — sort direction cannot be parameterized either:

```javascript
const SORT_COLUMNS = { name: 'name', created: 'created_at', price: 'price' };
const column = SORT_COLUMNS[req.query.sort] ?? 'created_at';
const direction = req.query.dir === 'asc' ? 'ASC' : 'DESC'; // map, never interpolate

await pool.query(`SELECT * FROM products ORDER BY ${column} ${direction} LIMIT $1`, [limit]);
```

**Key point:** Parameterization (`$1`, `$2`) works only for **values**, not for identifiers or keywords. Map untrusted input through a lookup table so the string that reaches the SQL is always one you wrote. Escaping (`%I`) is a fallback — a whitelist is better, because it also stops a user from reading a table they shouldn't.

---

## Q3: What is NOSQL injection and how does it relate?

**Answer:**
NoSQL injection targets MongoDB-like query operators. While not SQL, it's relevant for Node.js developers who may switch between databases.

```javascript
// MongoDB — vulnerable
const user = await db.users.findOne({
  email: req.body.email,       // attacker sends: { $gt: '' }
  password: req.body.password, // attacker sends: { $gt: '' }
});

// Sending { "email": { "$gt": "" }, "password": { "$gt": "" } } as JSON matches
// the first user in the collection and logs the attacker in as them.

// ✅ Safe — validate the type before it reaches the query
if (typeof req.body.email !== 'string' || typeof req.body.password !== 'string') {
  return res.status(400).json({ error: 'Invalid credentials format' });
}

// ✅ Safe — schema validation at the edge (zod, joi, ajv)
const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
const { email, password } = schema.parse(req.body);
```

**Key point:** The root cause is the same in both worlds — **untrusted input changing the structure of a query rather than filling a slot in it**. SQL solves it with parameterization; NoSQL has no equivalent separation, so you must enforce types at the boundary. A Mongoose schema with `type: String` will reject the object, but don't rely on that alone: `$where`, `$regex` ReDoS, and aggregation pipeline injection sidestep casting.

---

## Q4: How do you manage database credentials securely in Node.js?

**Answer:**
Never hardcode credentials. Use environment variables or secret management.

```javascript
// ❌ NEVER — hardcoded credentials
const pool = new Pool({
  host: 'mydb.example.com',
  user: 'admin',
  password: 'super_secret_123',
});

// ✅ Environment variables
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ✅ Connection URI (simplest)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

**On TLS — a trap worth knowing:** you will see `ssl: { rejectUnauthorized: false }` all over tutorials and Stack Overflow. It encrypts the connection but **disables certificate verification**, so it does not protect against a man-in-the-middle: an attacker who can redirect your traffic presents any certificate and you accept it. That defeats most of the point of TLS.

```javascript
// ❌ Encrypted but unauthenticated — MITM-vulnerable
ssl: { rejectUnauthorized: false }

// ✅ Verify the server against its CA
ssl: {
  rejectUnauthorized: true,
  ca: fs.readFileSync('/etc/ssl/certs/rds-global-bundle.pem').toString(),
}
```

People reach for `rejectUnauthorized: false` because managed providers (RDS, Heroku, Supabase) use certificates signed by their own CA, which isn't in Node's default trust store — the fix is to supply that CA, not to stop checking.

**Best practices:**
- Use a `.env` file (gitignored) for local development only
- In production prefer a secrets manager (AWS Secrets Manager, Vault, GCP Secret Manager) over plain env vars — env vars leak into crash dumps, `/proc`, child processes, and logs
- Rotate credentials regularly; short-lived IAM auth tokens (RDS IAM auth) beat static passwords
- Use separate DB users per application with minimal privileges
- Never log connection strings — scrub them in your logger's serializers

---

## Q5: What is Row Level Security (RLS) and when would you use it?

**Answer:**
RLS restricts which rows a user can access based on their database role. It enforces security at the database level, not just the application level.

```sql
-- Enable RLS on a table
ALTER TABLE tenant_data ENABLE ROW LEVEL SECURITY;
-- Also force it for the table's OWNER (see gotcha below)
ALTER TABLE tenant_data FORCE ROW LEVEL SECURITY;

-- Policy: users can only see their own tenant's data.
-- The `true` second arg makes current_setting return NULL instead of erroring
-- when the setting is missing — NULL fails the comparison, so it fails CLOSED.
CREATE POLICY tenant_isolation ON tenant_data
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::int);

-- Policy: only admins can delete
CREATE POLICY admin_delete ON tenant_data
  FOR DELETE
  USING (current_setting('app.user_role', true) = 'admin');
```

```javascript
// ❌ THIS DOES NOT WORK — SET does not accept bind parameters.
//    Fails with: syntax error at or near "$1"
await client.query('SET app.current_tenant = $1', [tenantId]);

// ✅ Use set_config(), which is a normal function call and takes parameters.
//    Third arg `true` = local to the current transaction.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', String(tenantId)]);
  await client.query('SELECT set_config($1, $2, true)', ['app.user_role', userRole]);

  const { rows } = await client.query('SELECT * FROM tenant_data'); // only this tenant's rows
  await client.query('COMMIT');
} finally {
  client.release();
}
```

**Three gotchas that make RLS silently useless:**

1. **`SET` can't be parameterized.** The workaround people reach for is string interpolation — which reintroduces SQL injection *into the security mechanism itself*. Use `set_config()`.
2. **The table owner bypasses RLS by default.** If your app connects as the user that owns the tables (very common), every policy is ignored and you'll see all rows while believing you're protected. `FORCE ROW LEVEL SECURITY` closes this. Superusers and `BYPASSRLS` roles ignore policies unconditionally.
3. **Connection reuse leaks context.** With `set_config(..., false)` the setting persists on the pooled connection after `release()`, so the *next* request can inherit the previous tenant's ID. Always scope it to a transaction (`true`), which resets on COMMIT/ROLLBACK.

**When to use:**
- Multi-tenant SaaS applications
- Applications where data isolation is critical
- Defense in depth (app-level + DB-level security)

**Cost:** policies are appended to every query's WHERE clause and can change plans. Index the column your policy filters on (`tenant_id`).

---

## Q6: How do you prevent mass assignment vulnerabilities?

**Answer:**
Never pass `req.body` directly to database update queries. Explicitly specify allowed fields.

```javascript
// ❌ DANGER — mass assignment. Whatever keys the client sends become columns,
//    so POST { "role": "admin" } or { "is_verified": true } escalates privileges.
const keys = Object.keys(req.body);
const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
await pool.query(
  `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1}`,
  [...Object.values(req.body), userId]
);
// It's also an injection hole: a key of `role = 'admin', email` is interpolated raw.

// ✅ SAFE — whitelist allowed fields
const ALLOWED_FIELDS = ['email', 'first_name', 'last_name', 'avatar_url'];
const updates = {};
for (const field of ALLOWED_FIELDS) {
  if (req.body[field] !== undefined) {
    updates[field] = req.body[field];
  }
}

// Build query with allowed fields only
const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
const values = Object.values(updates);
if (values.length === 0) return; // nothing to update — avoids invalid `SET  WHERE`

await pool.query(
  `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length + 1}`,
  [...values, userId]
);
```

The interpolation on the last query is safe **only because** the keys come from `ALLOWED_FIELDS`, a constant we control — never from `Object.keys(req.body)`.

**With ORM:** every ORM has an explicit-fields escape hatch — use it.

```javascript
// Sequelize
await user.update(req.body, { fields: ['email', 'first_name', 'last_name'] });

// Prisma — construct the data object explicitly; never spread req.body
await prisma.user.update({
  where: { id: userId },
  data: { email: req.body.email, firstName: req.body.firstName },
});
```

**Key point:** The vulnerability is *shape*, not content — validation that checks whether `email` is well-formed won't notice an extra `role` key. Whitelist keys, don't just validate values.

---

## Q7: What database user permissions should a Node.js app have?

**Answer:**
Principle of least privilege. The app user should have only what it needs.

```sql
-- Create a dedicated app role (CREATE USER = CREATE ROLE ... WITH LOGIN)
CREATE USER app_user WITH PASSWORD '...';

-- Grant only necessary permissions
GRANT CONNECT ON DATABASE mydb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Read/write on specific tables
GRANT SELECT, INSERT, UPDATE ON TABLE users TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sessions TO app_user;

-- Read-only on reference data
GRANT SELECT ON TABLE countries, currencies TO app_user;

-- Sequence access — required for SERIAL/nextval() inserts, easy to forget
GRANT USAGE, SELECT ON SEQUENCE users_id_seq TO app_user;

-- Tables created LATER by the migration user are not covered by the grants above.
-- Default privileges fix that going forward:
ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- On PG 15+, PUBLIC no longer gets CREATE on the public schema.
-- On PG 14 and earlier, revoke it explicitly:
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Note that `DROP` and `ALTER` are not grantable privileges in PostgreSQL — they're reserved to the object's **owner**. So the real protection is that `app_user` doesn't own anything; the migration role does.

**Separate the roles by job:**

| Role | Privileges | Used by |
|---|---|---|
| `app_user` | DML only (SELECT/INSERT/UPDATE/DELETE) | The running application |
| `migration_user` | Owns the schema, can DDL | Migrations in CI/CD only |
| `readonly_user` | SELECT only | Analytics, BI tools, read replicas |
| `backup_user` | SELECT + `pg_read_all_data` | `pg_dump` |

**Key point:** Never run your application as `postgres` (superuser) — superusers bypass RLS and all permission checks. Splitting the app role from the migration role means a SQL injection bug in the app can't drop a table, and it's the single highest-leverage privilege change most teams can make.
