import { MongoClient, Db } from 'mongodb';
import { getConfig } from './env.js';
import { UserRole } from '../types/index.js';

/**
 * One connection pool per role.
 * Each pool uses a dedicated MongoDB user with minimum required privileges:
 *   student → find on marks only
 *   teacher → find on marks/classes/users, write marks
 *   admin   → full access (staging) or no class delete (production)
 */
const pools: Partial<Record<UserRole, { client: MongoClient; db: Db }>> = {};

function buildUri(baseUri: string, username: string, password: string, dbName: string): string {
  // Insert credentials into the URI: mongodb://user:pass@host:port/dbName
  const url = new URL(baseUri);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Returns the authenticated MongoDB Db instance scoped to the given role.
 * Lazily initialises and caches one MongoClient per role.
 */
export async function getDb(role: UserRole = 'admin'): Promise<Db> {
  if (pools[role]) {
    return pools[role]!.db;
  }

  const config = getConfig();
  const { uri, dbName, users } = config.database;
  const creds = users[role];

  if (!creds) {
    throw new Error(`No database credentials configured for role "${role}".`);
  }

  const authedUri = buildUri(uri, creds.username, creds.password, dbName);
  console.error(`[Database] Connecting as ${creds.username} (role: ${role}) → ${dbName}`);

  try {
    const client = new MongoClient(authedUri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    const db = client.db(dbName);

    pools[role] = { client, db };
    console.error(`[Database] Connected as ${creds.username}`);
    return db;
  } catch (error) {
    console.error(`[Database] Failed to connect as ${creds.username}:`, error);
    throw error;
  }
}

/**
 * Closes all open role-scoped connections.
 */
export async function closeDb(): Promise<void> {
  for (const [role, pool] of Object.entries(pools)) {
    if (pool) {
      console.error(`[Database] Closing connection for role: ${role}`);
      await pool.client.close();
      delete pools[role as UserRole];
    }
  }
}
