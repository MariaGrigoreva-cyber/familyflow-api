// Пул подключений PostgreSQL. DATABASE_URL берётся из переменных окружения Timeweb.
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});
module.exports = pool;
