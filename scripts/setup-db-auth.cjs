/**
 * setup-db-auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONCE before enabling --auth on MongoDB.
 * It creates:
 *   1. A MongoDB admin superuser (for container management only)
 *   2. Three app users per database with least-privilege collection grants:
 *        app_student  → read marks only
 *        app_teacher  → read marks/classes/users, write marks
 *        app_admin    → full access, EXCEPT no delete on classes in production
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { MongoClient } = require('mongodb');

// ── Credentials ───────────────────────────────────────────────────────────────
// These will be written into environments.yaml after this script runs.
// Change them to strong passwords before deploying.
const MONGO_ADMIN    = { user: 'mongo_root',   password: 'rootPass#2025!' };
const APP_STUDENT    = { user: 'app_student',  password: 'StudentPass#2025!' };
const APP_TEACHER    = { user: 'app_teacher',  password: 'TeacherPass#2025!' };
const APP_ADMIN_STG  = { user: 'app_admin',    password: 'AdminPass#2025!' };
const APP_ADMIN_PROD = { user: 'app_admin',    password: 'AdminProdPass#2025!' };

// ── Environments ──────────────────────────────────────────────────────────────
const ENVS = [
  { label: 'STAGING',    uri: 'mongodb://localhost:27117', dbName: 'school_staging',    isProduction: false },
  { label: 'PRODUCTION', uri: 'mongodb://localhost:27118', dbName: 'school_production',  isProduction: true  },
];

async function setupEnvironment({ label, uri, dbName, isProduction }) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Setting up ${label} (${uri} / ${dbName})`);
  console.log(`${'═'.repeat(60)}`);

  const client = new MongoClient(uri);
  await client.connect();

  const adminDb = client.db('admin');
  const appDb   = client.db(dbName);

  // ── 1. Create MongoDB root admin (idempotent) ──────────────────────────────
  await upsertUser(adminDb, {
    user: MONGO_ADMIN.user,
    pwd:  MONGO_ADMIN.password,
    roles: [{ role: 'root', db: 'admin' }],
  });
  console.log(`✅ Root admin user "${MONGO_ADMIN.user}" ready`);

  // ── 2. app_student ────────────────────────────────────────────────────────
  // Can only find documents in the marks collection.
  // No access to classes, users, or any write operations.
  await upsertUser(appDb, {
    user: APP_STUDENT.user,
    pwd:  APP_STUDENT.password,
    roles: [{
      role: await ensureCustomRole(appDb, 'studentRole', [
        { resource: { db: dbName, collection: 'marks'   }, actions: ['find'] },
      ]),
      db: dbName,
    }],
  });
  console.log(`✅ app_student ready  → find on marks`);

  // ── 3. app_teacher ────────────────────────────────────────────────────────
  // Read marks, classes, users (no password projection handled in app layer).
  // Write (insert/update) marks only. No delete anywhere.
  await upsertUser(appDb, {
    user: APP_TEACHER.user,
    pwd:  APP_TEACHER.password,
    roles: [{
      role: await ensureCustomRole(appDb, 'teacherRole', [
        { resource: { db: dbName, collection: 'marks'   }, actions: ['find', 'update', 'insert'] },
        { resource: { db: dbName, collection: 'classes' }, actions: ['find'] },
        { resource: { db: dbName, collection: 'users'   }, actions: ['find'] },
      ]),
      db: dbName,
    }],
  });
  console.log(`✅ app_teacher ready  → find classes/users/marks, write marks`);

  // ── 4. app_admin ──────────────────────────────────────────────────────────
  // Staging: full CRUD on all collections including delete on classes.
  // Production: same but NO delete on classes — enforced at DB level.
  const classActions = isProduction
    ? ['find', 'insert', 'update']          // no 'remove' in production
    : ['find', 'insert', 'update', 'remove'];

  const adminCreds = isProduction ? APP_ADMIN_PROD : APP_ADMIN_STG;

  await upsertUser(appDb, {
    user: adminCreds.user,
    pwd:  adminCreds.password,
    roles: [{
      role: await ensureCustomRole(appDb, 'adminRole', [
        { resource: { db: dbName, collection: 'marks'   }, actions: ['find', 'insert', 'update', 'remove'] },
        { resource: { db: dbName, collection: 'classes' }, actions: classActions },
        { resource: { db: dbName, collection: 'users'   }, actions: ['find', 'insert', 'update', 'remove'] },
      ]),
      db: dbName,
    }],
  });

  const classPerms = isProduction ? 'find/insert/update (NO delete)' : 'full CRUD';
  console.log(`✅ app_admin ready    → full marks/users, classes: ${classPerms}`);

  await client.close();
  console.log(`\n✅ ${label} setup complete.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a custom role if it doesn't exist, or updates it if it does.
 * Returns the role name for chaining.
 */
async function ensureCustomRole(db, roleName, privileges) {
  try {
    await db.command({ createRole: roleName, privileges, roles: [] });
    console.log(`   Created role: ${roleName}`);
  } catch (err) {
    if (err.code === 51002 || err.codeName === 'DuplicateKey' || err.message?.includes('already exists')) {
      await db.command({ updateRole: roleName, privileges, roles: [] });
      console.log(`   Updated role: ${roleName}`);
    } else {
      throw err;
    }
  }
  return roleName;
}

/**
 * Creates a user if they don't exist, or updates their password + roles if they do.
 */
async function upsertUser(db, { user, pwd, roles }) {
  try {
    await db.command({ createUser: user, pwd, roles });
  } catch (err) {
    if (err.code === 51003 || err.message?.includes('already exists')) {
      await db.command({ updateUser: user, pwd, roles });
    } else {
      throw err;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('School MCP — MongoDB Auth Setup');
  console.log('Running BEFORE --auth is enabled on both containers.\n');

  for (const env of ENVS) {
    await setupEnvironment(env);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  ALL DONE. Next steps:');
  console.log('  1. Run: docker compose down');
  console.log('  2. Run: docker compose up -d');
  console.log('     (docker-compose.yaml already updated with --auth)');
  console.log('  3. Update environments.yaml with the credentials below:');
  console.log('');
  console.log('  STAGING:');
  console.log(`    student: { user: "${APP_STUDENT.user}",   password: "${APP_STUDENT.password}" }`);
  console.log(`    teacher: { user: "${APP_TEACHER.user}",   password: "${APP_TEACHER.password}" }`);
  console.log(`    admin:   { user: "${APP_ADMIN_STG.user}", password: "${APP_ADMIN_STG.password}" }`);
  console.log('');
  console.log('  PRODUCTION:');
  console.log(`    student: { user: "${APP_STUDENT.user}",    password: "${APP_STUDENT.password}" }`);
  console.log(`    teacher: { user: "${APP_TEACHER.user}",    password: "${APP_TEACHER.password}" }`);
  console.log(`    admin:   { user: "${APP_ADMIN_PROD.user}", password: "${APP_ADMIN_PROD.password}" }`);
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
