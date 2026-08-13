# ORMs and Query Builders

## Q1: When would you use an ORM vs raw SQL in Node.js?

**Answer:**

| Factor | ORM (Sequelize, Prisma, TypeORM) | Raw SQL (pg, knex) |
|---|---|---|
| Development speed | Fast — auto-generates queries | Slower — write SQL manually |
| Type safety | Good (Prisma, TypeORM) | None (pg) / Some (TypeORM) |
| Complex queries | Hard — ORM limitations | Full SQL power |
| Performance | Extra overhead | Direct, no abstraction |
| Database portability | Switch DB with config changes | SQL dialect differences |
| Learning curve | ORM API to learn | SQL to know |
| Debugging | Generated SQL may be opaque | You wrote the SQL |

**Decision framework:**
- **Use ORM when:** CRUD-heavy app, team is new to SQL, rapid prototyping, need type safety
- **Use raw SQL when:** Complex analytics, performance-critical queries, full control needed, stored procedures
- **Hybrid approach:** ORM for CRUD + raw SQL for complex queries (most production apps)

```javascript
// Prisma — type-safe ORM
const user = await prisma.user.findUnique({ where: { id }, include: { posts: true } });

// Raw SQL for complex query
const { rows } = await pool.query(`
  SELECT u.name, count(p.id) as post_count, avg(p.score) as avg_score
  FROM users u
  LEFT JOIN posts p ON p.user_id = u.id
  GROUP BY u.id
  HAVING avg(p.score) > $1
`, [threshold]);
```

---

## Q2: What are the tradeoffs of using Prisma vs Sequelize vs TypeORM?

**Answer:**

| Feature | Prisma | Sequelize | TypeORM |
|---|---|---|---|
| Type safety | Excellent (generated types) | Moderate (decorators) | Good (decorators) |
| Migration system | Built-in, reliable | sequelize-cli | Built-in |
| Query builder | Type-safe | Chainable API | Chainable + decorators |
| Performance | Good | Good | Moderate |
| Learning curve | Low | Moderate | High |
| Community | Growing fast | Mature | Mature |
| Database support | PG, MySQL, SQLite, SQL Server | Many dialects | Many dialects |

**Prisma strengths:** Auto-generated types, excellent DX, type-safe queries.
**Sequelize strengths:** Mature, flexible, large ecosystem.
**TypeORM strengths:** Decorator-based, active record + data mapper patterns.

---

## Q3: What is the "impedance mismatch" between SQL and JavaScript?

**Answer:**
SQL works with sets of rows. JavaScript works with objects and references. The mismatch occurs when mapping between the two.

```javascript
// SQL returns flat rows
// SELECT u.name, p.title FROM users u JOIN posts p ON p.user_id = u.id
// Result: [{ name: 'Alice', title: 'Post 1' }, { name: 'Alice', title: 'Post 2' }]

// JavaScript expects nested objects
// { name: 'Alice', posts: [{ title: 'Post 1' }, { title: 'Post 2' }] }

// ORM handles this transformation automatically
const user = await User.findOne({ where: { id: 1 }, include: [Post] });
// Result: { name: 'Alice', posts: [{ title: 'Post 1' }, { title: 'Post 2' }] }
```

**Key point:** ORMs solve the impedance mismatch but add abstraction cost. Know when the cost is worth it.

---

## Q4: How do database migrations work in Node.js?

**Answer:**
Migrations are version-controlled SQL or code files that modify the database schema. They ensure all environments have the same schema.

```javascript
// Knex migration example
// migrations/20240101_create_users.js
exports.up = function (knex) {
  return knex.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('email').notNullable().unique();
    table.string('password_hash').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('users');
};
```

Note `notNullable()` — not `notNull()`, which doesn't exist on the Knex column builder and fails at runtime.

```bash
# Run all pending migrations
npx knex migrate:latest

# Roll back the last BATCH of migrations
npx knex migrate:rollback

# Roll back a single migration
npx knex migrate:down

# Check status
npx knex migrate:status
```

`rollback` and `down` are not the same: `migrate:latest` applies every pending migration as one **batch**, and `rollback` reverts the whole batch. If you deployed three migrations together, `rollback` undoes all three while `migrate:down` undoes only the last one.

**Key principles:**
- Migrations run in filename order and are tracked in the `knex_migrations` table
- Always write the `down` function for rollback
- Never modify a migration that has already been applied to production — write a new one
- Test migrations on a copy of production data before deploying
- **Beware locks.** In PostgreSQL, DDL takes an `ACCESS EXCLUSIVE` lock. `ALTER TABLE ... ADD COLUMN` with a non-volatile default is instant since PG 11, but adding a `NOT NULL` constraint or an index without `CONCURRENTLY` rewrites/blocks the table. Worse, a migration that can't get the lock **queues behind a long-running query and blocks every subsequent query** on that table. Set `lock_timeout` so it fails fast instead of taking the site down:
  ```sql
  SET lock_timeout = '5s';
  CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
  ```
  `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so it needs a migration with transactions disabled (`config.transaction = false` in Knex).

---

## Q5: What is database seeding and how do you do it?

**Answer:**
Seeding populates the database with initial or test data.

```javascript
// Knex seed example
// seeds/01_users.js
exports.seed = async function (knex) {
  await knex('users').del(); // clear existing
  await knex('users').insert([
    { email: 'admin@example.com', password_hash: '$2b$10$...', role: 'admin' },
    { email: 'user@example.com', password_hash: '$2b$10$...', role: 'user' },
  ]);
};
```

```bash
npx knex seed:run
```

**Best practices:**
- Use seeds for reference data (countries, roles, categories)
- Never seed production with real user data
- Keep seeds idempotent (safe to run multiple times)
- Use factories for test data generation

---

## Q6: How do you handle database schema changes without downtime?

**Answer:**
The **expand/contract** pattern. The constraint driving it: during a rolling deploy, old and new application code run **at the same time** against **one** database. So every intermediate state must be readable and writable by both versions.

Splitting `name_first`/`name_last` into a single `name_full` takes four steps, each independently deployable and reversible:

**Step 1 — Expand the schema.** Additive only; old code ignores the new column.
```sql
ALTER TABLE users ADD COLUMN name_full VARCHAR(200); -- nullable, no default
```

**Step 2 — Dual-write.** Deploy code that writes both, still reads the old columns.
```javascript
await pool.query(
  'INSERT INTO users (email, name_first, name_last, name_full) VALUES ($1, $2, $3, $4)',
  [email, first, last, `${first} ${last}`]
);
```

**Step 3 — Backfill,** in batches so you don't lock the table or bloat WAL:
```sql
UPDATE users SET name_full = name_first || ' ' || name_last
WHERE name_full IS NULL AND id IN (
  SELECT id FROM users WHERE name_full IS NULL LIMIT 10000
);
-- repeat until 0 rows affected
```
Then deploy code that **reads** `name_full`. Only now can you add `NOT NULL`.

**Step 4 — Contract,** after the read-new code is fully rolled out and you're confident you won't roll back:
```sql
ALTER TABLE users DROP COLUMN name_first, DROP COLUMN name_last;
```

**Key point:** The original single "backfill then drop in one migration" is the trap — between the `UPDATE` and the `DROP`, old instances are still writing `name_first` with no `name_full`, so you silently lose those names. Backfill and drop must be separated by a deploy.

**Rule of thumb:** a rename is never a rename. It's add → dual-write → backfill → switch reads → drop.

---

## Q7: What is an anemic domain model and why is it a concern with ORMs?

**Answer:**
An anemic domain model is when entities are just data containers with no behavior — all business logic lives in services or controllers.

```javascript
// ❌ Anemic — logic in controller
app.post('/users', async (req, res) => {
  const { email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({ email, password_hash: hashed });
  await sendWelcomeEmail(user.email);
  res.json(user);
});

// ✅ Rich domain — logic in entity
class User {
  static async createWithPassword(email, password) {
    const hashed = await bcrypt.hash(password, 10);
    const user = await this.create({ email, password_hash: hashed });
    await sendWelcomeEmail(user.email);
    return user;
  }
}
```

**Key point:** ORMs encourage anemic models. Be intentional about where business logic lives.

---

## Q8: How do you debug slow ORM-generated queries?

**Answer:**
Enable query logging and inspect the generated SQL.

```javascript
// Sequelize — (uri, options) or (database, username, password, options)
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  logging: (sql, timingMs) => console.log('[SQL]', timingMs, sql),
  benchmark: true, // makes the timing arg available
});

// Prisma
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

// Knex — the option is `debug`, not `logging`
const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  debug: true, // logs SQL and bindings
});

// Inspect one Knex query without enabling global debug
console.log(knex('users').where('id', 1).toSQL().toNative());
```

Once you have the SQL, run it through `EXPLAIN ANALYZE` yourself — the ORM's timing tells you a query is slow, but only the plan tells you why.

**Common ORM performance issues:**
- N+1 queries (see `05_performance_and_indexing.md` Q3)
- Loading all columns instead of needed ones
- Missing indexes on foreign keys
- Inefficient joins generated by the ORM

---

## Q9: When should you use a data access layer (DAL) pattern?

**Answer:**
A DAL separates database logic from business logic, making code testable and maintainable.

```javascript
// repositories/userRepository.js
class UserRepository {
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0];
  }

  async findByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0];
  }

  async create(data) {
    const { rows } = await pool.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
      [data.email, data.name]
    );
    return rows[0];
  }
}

// services/userService.js
class UserService {
  constructor(userRepo) {
    this.userRepo = userRepo;
  }

  async register(email, name) {
    const existing = await this.userRepo.findByEmail(email);
    if (existing) throw new Error('Email already registered');
    return this.userRepo.create({ email, name });
  }
}
```

**Benefits:**
- Easy to mock in tests
- Database logic is centralized
- Can swap implementations (e.g., for testing)
