// Попап сбора обратной связи (14+ дней с регистрации) — условие показа считает
// GET /family/me (см. routes/family.js), здесь только приём результата.
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const { feedbackSchema } = require('../lib/schemas');
const { sendTelegramMessage, telegramConfigured } = require('../lib/telegram');

router.post('/', auth, validate(feedbackSchema), ah(async (req, res) => {
  const trimmed = req.body.text.trim();
  await db.query('INSERT INTO user_feedback(user_id, text) VALUES($1,$2)', [req.user.uid, trimmed]);
  const u = await db.query(
    "UPDATE users SET feedback_status='submitted', feedback_responded_at=now() WHERE id=$1 RETURNING email",
    [req.user.uid]
  );
  res.json({ ok: true });

  // После ответа клиенту — сетевой запрос к Telegram не должен задерживать
  // сохранение отзыва (тот же принцип, что sendMail в routes/auth.js).
  if (telegramConfigured()) {
    sendTelegramMessage(`📝 Новый отзыв от ${u.rows[0].email}:\n\n${trimmed}`)
      .catch(e => console.error('telegram feedback notify:', e.message));
  }
}));

router.post('/decline', auth, ah(async (req, res) => {
  await db.query(
    "UPDATE users SET feedback_status='declined', feedback_responded_at=now() WHERE id=$1",
    [req.user.uid]
  );
  res.json({ ok: true });
}));

module.exports = router;
