import { MongoClient, Db } from 'mongodb';
import { getConfig } from './env.js';

let clientSingleton: MongoClient | null = null;
let dbSingleton: Db | null = null;

/**
 * Lazily retrieves the MongoDB connection and database instance
 */
export async function getDb(): Promise<Db> {
  if (dbSingleton) {
    return dbSingleton;
  }

  const config = getConfig();
  const { uri, dbName } = config.database;

  console.error(`[Database] Connecting to ${uri} (Database: ${dbName})`);

  try {
    const client = new MongoClient(uri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000
    });
    
    await client.connect();
    
    clientSingleton = client;
    dbSingleton = client.db(dbName);
    
    console.error(`[Database] Successfully connected to MongoDB`);
    return dbSingleton;
  } catch (error) {
    console.error(`[Database] Failed to connect to MongoDB at ${uri}:`, error);
    throw error;
  }
}

/**
 * Closes the active database connection if it exists
 */
export async function closeDb(): Promise<void> {
  if (clientSingleton) {
    console.error('[Database] Closing MongoDB connection');
    await clientSingleton.close();
    clientSingleton = null;
    dbSingleton = null;
  }
}
