// Просмотр отзывов, оставленных через попап (см. routes/feedback.js).
// Единственный админ-эндпоинт в проекте — см. middleware/adminAuth.js.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const ah = require('../middleware/asyncHandler');
const adminAuth = require('../middleware/adminAuth');

// Тот же порядок величин, что strictLimiter в routes/auth.js — секрет
// сравнивается timing-safe, но подбор всё равно стоит ограничить по частоте.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  skip: () => process.env.NODE_ENV === 'test',
});

router.get('/feedback', adminLimiter, adminAuth, ah(async (req, res) => {
  const r = await db.query(
    `SELECT uf.id, u.email, uf.text, uf.created_at
       FROM user_feedback uf JOIN users u ON u.id = uf.user_id
      ORDER BY uf.created_at DESC
      LIMIT 500`
  );
  res.json(r.rows.map(row => ({ id: row.id, email: row.email, text: row.text, createdAt: row.created_at })));
}));

module.exports = router;
