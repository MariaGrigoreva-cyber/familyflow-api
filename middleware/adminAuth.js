const crypto = require('crypto');

// Единственный админ-эндпоинт в проекте (просмотр отзывов) — общий секрет из
// окружения вместо полноценной ролевой модели с таблицей admins. timingSafeEqual
// защищает от тайминг-атаки на побайтовое сравнение секрета.
module.exports = (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'admin_not_configured' });
  const provided = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};
