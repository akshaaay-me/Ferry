import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
  } catch (err) {
    if (/vector/i.test(err.message)) {
      console.warn('pgvector unavailable; creating schema without the embedding column');
      await pool.query(
        sql.replace('CREATE EXTENSION IF NOT EXISTS vector;', '')
           .replace('embedding     vector(1024),', '')
      );
    } else throw err;
  }
  console.log('schema ready');
}

if (process.argv.includes('--migrate')) {
  await migrate();
  await pool.end();
}
