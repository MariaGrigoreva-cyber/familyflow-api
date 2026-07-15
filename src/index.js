// FamilyFlow API · фаза 0
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { router: authRouter } = require('./auth');
const { router: stateRouter } = require('./state');
const { router: familyRouter } = require('./family');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean), credentials: false }));

// Анти-брутфорс на аутентификацию
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_, res) => res.json({ ok: true }));
app.use('/auth', authRouter);
app.use('/state', stateRouter);
app.use('/family', familyRouter);

// Единый обработчик ошибок — без стека наружу
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`familyflow-api on :${PORT}`));
