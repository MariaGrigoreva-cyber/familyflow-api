// Подписка/отписка на push-уведомления. Публичный ключ отдаём без авторизации —
// он и не секретный (secret key никогда не покидает сервер).
const router = require('express').Router();
const db = require('../db');
const authMw = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');

router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

router.post('/subscribe', authMw, ah(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'bad_subscription' });
  await db.query(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4`,
    [req.user.uid, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ ok: true });
}));

router.post('/unsubscribe', authMw, ah(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
  res.json({ ok: true });
}));

module.exports = router;
