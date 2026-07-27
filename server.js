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

// Без явного CORS_ORIGIN не открываем всем (*) по умолчанию — небезопасный дефолт
// для API с деньгами и ПДн. Если переменная не задана, браузерные запросы с фронта
// будут отклонены (это сразу заметно в проде, а не тихая дыра в безопасности).
const originEnv = process.env.CORS_ORIGIN || '';
if (!originEnv) console.error('CORS_ORIGIN не задан — кросс-доменные запросы браузера будут отклонены');
const origins = originEnv.split(',').map(s => s.trim()).filter(Boolean);
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

app.get('/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

app.use('/auth', authLimiter, require('./routes/auth'));
app.use('/state', require('./routes/state'));
app.use('/family', require('./routes/family'));
app.use('/billing', require('./routes/billing'));
app.use('/push', require('./routes/push'));

// Ловит необработанные ошибки из роутов и шлёт в GlitchTip (если DSN настроен),
// затем отвечает клиенту JSON-ом, а не HTML-страницей Express по умолчанию.
Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server' });
});

// Всё, что открывает порт, поднимает планировщики и применяет схему БД, нужно
// только при реальном запуске (`node server.js`) — не при `require('./server')`
// из тестов. Тесты сами готовят тестовую БД (test/setupDb.js) и вызывают
// эндпоинты через supertest без HTTP-сервера и фоновых интервалов.
if (require.main === module) {
  // Без DATA_ENC_KEY бюджет семьи (реальные финансовые ПДн) пишется в БД в открытом
  // виде — см. lib/crypto.js. В боевом режиме отказываемся стартовать: слишком легко
  // забыть задать ключ на проде и не заметить это по логу. Для локальной разработки
  // без ключа — явный опт-аут через ALLOW_UNENCRYPTED_DATA=1 (см. .env.example).
  if (!process.env.DATA_ENC_KEY && process.env.ALLOW_UNENCRYPTED_DATA !== '1') {
    console.error('DATA_ENC_KEY не задан — отказываюсь стартовать, иначе бюджет семьи попадёт в БД в открытом виде. Локально можно обойти через ALLOW_UNENCRYPTED_DATA=1.');
    process.exit(1);
  }

  (async () => {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      console.log('schema OK');
      await require('./lib/migrateEncryption').run();
    } catch (e) {
      console.error('schema error:', e.message);
      process.exit(1);
    }
  })();

  require('./lib/scheduler').start();
  require('./lib/pushScheduler').start();

  const PORT = process.env.PORT || 3001;
  const server = app.listen(PORT, () => console.log('FamilyFlow API on :' + PORT));

  // При деплое/рестарте хостинг шлёт SIGTERM — даём in-flight запросам и пулу
  // соединений к БД завершиться штатно, а не обрубаем их на середине.
  const shutdown = signal => {
    console.log(`${signal} получен, завершаю работу...`);
    server.close(async () => {
      try { await db.end(); } catch {}
      process.exit(0);
    });
    // Если что-то зависло (например, долгий запрос) — не ждём вечно.
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
