import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from '../config/env';

const isLocalhost = env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1');

// Parse connection_limit from DATABASE_URL if present, otherwise default to 10
let connectionLimit = 10;
try {
  const urlObj = new URL(env.DATABASE_URL);
  const limit = urlObj.searchParams.get('connection_limit');
  if (limit) {
    connectionLimit = parseInt(limit, 10);
  }
} catch (e) {
  // Ignore URL parsing errors and stick to default
}

// Strip query parameters to prevent node-postgres from overriding constructor ssl options
const connectionString = env.DATABASE_URL.split('?')[0];

const pool = new Pool({
  connectionString,
  max: connectionLimit,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
  ssl: isLocalhost ? undefined : { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

export default prisma;
