const jwt = require('jsonwebtoken');
const db = require('../db');

// Сверяем tv (token_version) из токена с текущим значением в БД — смена/сброс
// пароля увеличивает версию и тем самым отзывает все ранее выданные токены,
// даже до истечения их 90-дневного срока (см. schema.sql).
module.exports = async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'bad_token' });
  }
  try {
    const r = await db.query('SELECT token_version FROM users WHERE id=$1', [payload.uid]);
    if (!r.rows.length || r.rows[0].token_version !== payload.tv) {
      return res.status(401).json({ error: 'token_revoked' });
    }
  } catch (e) {
    console.error('auth token_version check:', e.message);
    return res.status(500).json({ error: 'server' });
  }
  req.user = payload;
  next();
};
