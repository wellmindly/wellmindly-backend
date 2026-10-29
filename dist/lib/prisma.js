"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
const client_1 = require("../generated/prisma/client");
const env_1 = require("../config/env");
const isLocalhost = env_1.env.DATABASE_URL.includes('localhost') || env_1.env.DATABASE_URL.includes('127.0.0.1');
// Parse connection_limit from DATABASE_URL if present, otherwise default to 10
let connectionLimit = 10;
try {
    const urlObj = new URL(env_1.env.DATABASE_URL);
    const limit = urlObj.searchParams.get('connection_limit');
    if (limit) {
        connectionLimit = parseInt(limit, 10);
    }
}
catch (e) {
    // Ignore URL parsing errors and stick to default
}
// Strip query parameters to prevent node-postgres from overriding constructor ssl options
const connectionString = env_1.env.DATABASE_URL.split('?')[0];
const pool = new pg_1.Pool({
    connectionString,
    max: connectionLimit,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    ssl: isLocalhost ? undefined : { rejectUnauthorized: false }
});
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
exports.default = prisma;
