// FamilyFlow API · Фаза 0
// Аккаунты + облачный снапшот бюджета + приглашения в семью.
const Sentry = require('@sentry/node');
// Пока SENTRY_DSN не задан в переменных окружения — SDK молча ничего не делает,
// деплой безопасен и без него. DSN указываем на свой GlitchTip (152-ФЗ: данные
// об ошибках не должны уходить за пределы РФ), не на облачный Sentry.io.
Sentry.init({ dsn: process.env.SENTRY_DSN || '', enabled: !!process.env.SENTRY_DSN });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '3mb' }));

const origins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({ origin: origins.includes('*') ? true : origins }));

// Общий анти-брутфорс на весь /auth — конкретные точки риска (вход, код сброса
// пароля) дополнительно ограничены строже прямо в routes/auth.js.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

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

app.use('/auth', authLimiter, require('./routes/auth'));
app.use('/state', require('./routes/state'));
app.use('/family', require('./routes/family'));
app.use('/billing', require('./routes/billing'));
app.use('/push', require('./routes/push'));

require('./lib/scheduler').start();
require('./lib/pushScheduler').start();

// Ловит необработанные ошибки из роутов и шлёт в GlitchTip (если DSN настроен),
// затем отвечает клиенту JSON-ом, а не HTML-страницей Express по умолчанию.
Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('FamilyFlow API on :' + PORT));
