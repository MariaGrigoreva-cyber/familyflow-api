// FamilyFlow API · Фаза 0
// Аккаунты + облачный снапшот бюджета + приглашения в семью.
const express = require('express');
const cors = require('cors');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));

const origins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({ origin: origins.includes('*') ? true : origins }));

// Автоприменение схемы при старте — удобно для App Platform без ручного psql.
(async () => {
  try {
    await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('schema OK');
  } catch (e) { console.error('schema error:', e.message); }
})();

app.get('/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

app.use('/auth', require('./routes/auth'));
app.use('/state', require('./routes/state'));
app.use('/family', require('./routes/family'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('FamilyFlow API on :' + PORT));
