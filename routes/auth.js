// Регистрация и вход. При регистрации сразу создаётся семья и пустой state.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const ah = require('../middleware/asyncHandler');
const authMw = require('../middleware/auth');
const { sendMail, mailConfigured, renderTemplate, unsubscribeUrl, verifyUnsubscribeToken, hasMxRecord } = require('../lib/mail');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema, changePasswordSchema, resetRequestSchema, resetConfirmSchema } = require('../lib/schemas');
const { trialIntervalParam } = require('../lib/entitlement');

// tv (token_version) — см. middleware/auth.js: смена/сброс пароля увеличивает
// версию в БД и тем самым отзывает все ранее выданные токены.
const sign = (uid, tv) => jwt.sign({ uid, tv }, process.env.JWT_SECRET, { expiresIn: '90d' });

// Атрибуция клика по рекламе, присланная фронтендом (см. familyflow-web/src/lib/metrika.js
// и familyflow-landing/public/script.js) — тело запроса не проверено, поэтому
// пишем в БД только заведомо известные поля, а не объект как есть.
const ATTRIBUTION_KEYS = ['yclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
function sanitizeAttribution(attribution) {
  if (!attribution || typeof attribution !== 'object') return null;
  const out = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = attribution[key];
    if (typeof v === 'string' && v) out[key] = v.slice(0, 200);
  }
  if (typeof attribution.ts === 'number') out.ts = attribution.ts;
  return Object.keys(out).length > 0 ? out : null;
}

// Строже общего лимита на /auth — это конкретно подбор пароля и подбор
// 6-значного кода сброса, самые ценные цели для брутфорса.
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  // Счётчик общий на все тесты файла (не сбрасывается между test()) — без skip
  // достаточно длинный тестовый файл сам себя рано или поздно рейт-лимитит,
  // без всякой связи с тем, что тесты реально проверяют.
  skip: () => process.env.NODE_ENV === 'test',
});

router.post('/register', validate(registerSchema), ah(async (req, res) => {
  const { email, password, familyName, pdnConsent, attribution } = req.body || {};
  // Опечатка в домене (gmial.com, yandex.ry) — самый частый случай, который
  // Unisender ниже не ловит (см. lib/mail.js). Проверяем ДО подключения к БД —
  // ни аккаунт, ни семья ещё не созданы.
  if (!(await hasMxRecord(email))) {
    console.error('register bad_email: no MX record for', email);
    return res.status(400).json({ error: 'bad_email' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const u = await client.query(
      'INSERT INTO users(email, pass_hash, pdn_consent_at, pdn_consent_ip, attribution) VALUES(lower($1), $2, now(), $3, $4) RETURNING id',
      [email, hash, req.ip, sanitizeAttribution(attribution)]
    );
    const f = await client.query(
      // Срок триала — единый для обоих потоков регистрации (см. lib/entitlement.js).
      // Подставляется параметром, а не литералом в тексте запроса: раньше здесь
      // и в Яндекс-потоке ниже стояли два независимых `interval '30 days'`, и их
      // легко было развести по значению.
      `INSERT INTO families(name, trial_ends_at) VALUES($1, now() + ($2 || ' days')::interval) RETURNING id`,
      [familyName || 'Моя семья', trialIntervalParam()]
    );
    await client.query(
      "INSERT INTO family_members(family_id, user_id, role) VALUES($1, $2, 'owner')",
      [f.rows[0].id, u.rows[0].id]
    );
    await client.query(
      'INSERT INTO family_states(family_id, data, updated_by) VALUES($1, $2, $3)',
      [f.rows[0].id, '{}', u.rows[0].id]
    );
    // Токен подтверждения email — обычная случайная строка, не хеш: как invite_code,
    // не нуждается в bcrypt (не пароль, разово используемая ссылка с ограничением по сроку).
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      `UPDATE users SET verify_token=$1, verify_expires=now() + interval '24 hours' WHERE id=$2`,
      [verifyToken, u.rows[0].id]
    );

    // Письмо шлём ДО коммита: Unisender синхронно, в том же ответе, сообщает
    // про невалидный адрес (failed_emails: "invalid" — опечатка типа gmial.com)
    // — успеваем откатить создание аккаунта, а не молча потерять человека,
    // который никогда не увидит письмо и не поймёт почему.
    let mailSent = false;
    if (mailConfigured()) {
      const verifyLink = `${req.protocol}://${req.get('host')}/auth/verify-email?token=${verifyToken}`;
      const unsubUrl = unsubscribeUrl(u.rows[0].id);
      const mail = renderTemplate('1-welcome', {
        VERIFY_URL: verifyLink,
        UNSUBSCRIBE_URL: unsubUrl,
      });
      try {
        await sendMail(email, 'Осталось одно дело — и можно начинать', mail.text, mail.html, unsubUrl);
        mailSent = true;
      } catch (e) {
        if (e.rejectedReason === 'invalid') {
          console.error('register bad_email: Unisender rejected as invalid', email);
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'bad_email' });
        }
        // Другие причины (временная недоступность почтового сервера, дубликат
        // и т.п.) не должны блокировать регистрацию — логируем и продолжаем.
        console.error('welcome mail:', e.message);
      }
    }

    await client.query('COMMIT');
    if (mailSent) console.log('welcome mail: sent to', email);

    res.json({ token: sign(u.rows[0].id, 1), familyId: f.rows[0].id, emailVerified: false });
  } catch (e) {
    // ROLLBACK сам может упасть, если соединение уже разорвано исходной ошибкой —
    // тогда это была бы вторая необработанная ошибка внутри catch.
    try { await client.query('ROLLBACK'); } catch {}
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
}));

router.post('/login', strictLimiter, validate(loginSchema), ah(async (req, res) => {
  const { email, password } = req.body || {};
  // Мягко удалённый аккаунт (deleted_at) для логина не отличается от «нет такого
  // пользователя» — не раскрываем сам факт удаления попыткой входа.
  const r = await db.query('SELECT id, pass_hash, token_version FROM users WHERE email = lower($1) AND deleted_at IS NULL', [email]);
  if (!r.rows.length) return res.status(401).json({ error: 'bad_credentials' });
  const ok = await bcrypt.compare(password, r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  res.json({ token: sign(r.rows[0].id, r.rows[0].token_version) });
}));


// ── Смена пароля (для залогиненных) ────────────────────────────────────────
router.post('/change-password', authMw, validate(changePasswordSchema), ah(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const r = await db.query('SELECT pass_hash FROM users WHERE id=$1', [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_user' });
  const ok = await bcrypt.compare(oldPassword || '', r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  const hash = await bcrypt.hash(newPassword, 10);
  // Инвалидируем все ранее выданные токены (в т.ч. потенциально украденные) —
  // и сразу выдаём новый, чтобы не разлогинить текущую сессию её же действием.
  const v = await db.query(
    'UPDATE users SET pass_hash=$1, token_version=token_version+1 WHERE id=$2 RETURNING token_version',
    [hash, req.user.uid]
  );
  res.json({ ok: true, token: sign(req.user.uid, v.rows[0].token_version) });
}));

// ── Удаление аккаунта (152-ФЗ: право на отзыв согласия и уничтожение ПДн) ──
router.post('/delete-account', authMw, strictLimiter, ah(async (req, res) => {
  const { password } = req.body || {};
  const u = await db.query('SELECT pass_hash FROM users WHERE id=$1', [req.user.uid]);
  if (!u.rows.length) return res.status(404).json({ error: 'no_user' });
  const ok = await bcrypt.compare(password || '', u.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const m = await client.query(
      'SELECT family_id, role FROM family_members WHERE user_id=$1 FOR UPDATE', [req.user.uid]
    );
    if (m.rows.length) {
      const { family_id: fid, role } = m.rows[0];
      const others = await client.query(
        'SELECT user_id FROM family_members WHERE family_id=$1 AND user_id<>$2 ORDER BY joined_at ASC',
        [fid, req.user.uid]
      );
      if (!others.rows.length) {
        // Единственный участник семьи — удаляем семью целиком: бюджет и платежи
        // уходят вместе с ней (payments ссылается на families с ON DELETE CASCADE).
        await client.query('DELETE FROM family_states WHERE family_id=$1', [fid]);
        await client.query('DELETE FROM families WHERE id=$1', [fid]);
      } else if (role === 'owner') {
        // Передаём владение самому давнему из оставшихся — семья и общий бюджет
        // остаются доступны другим участникам.
        await client.query(
          "UPDATE family_members SET role='owner' WHERE family_id=$1 AND user_id=$2",
          [fid, others.rows[0].user_id]
        );
      }
    }
    // Раньше DELETE FROM users каскадно сносил и family_members, и push_subscriptions —
    // теперь строку users не удаляем сразу (мягкое удаление, см. schema.sql), поэтому
    // убираем обе записи явно.
    await client.query('DELETE FROM family_members WHERE user_id=$1', [req.user.uid]);
    await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.uid]);
    // deleted_at запрещает и логин, и повторную выдачу токена; token_version+1 отзывает
    // все уже выданные. Настоящее стирание строки (право на удаление по 152-ФЗ) делает
    // lib/accountPurgeScheduler.js спустя грейс-период — на случай ошибочного удаления.
    await client.query(
      'UPDATE users SET deleted_at=now(), token_version=token_version+1 WHERE id=$1',
      [req.user.uid]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
}));

router.post('/reset-request', validate(resetRequestSchema), ah(async (req, res) => {
  const { email } = req.body || {};
  if (!mailConfigured()) return res.status(503).json({ error: 'mail_unavailable' });
  const u = await db.query('SELECT id FROM users WHERE email=lower($1)', [email]);
  // Не раскрываем, существует ли аккаунт — отвечаем одинаково
  if (u.rows.length) {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 цифр
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      `UPDATE users SET reset_hash=$1, reset_expires=now() + interval '15 minutes' WHERE id=$2`,
      [hash, u.rows[0].id]);
    // Письмо шлём асинхронно: HTTP-ответ не ждёт SMTP, зависший SMTP не вешает API.
    // 10-секундный таймаут, чтобы битые соединения не копились.
    sendMail(
      email,
      'Код восстановления пароля «Семейный поток»',
      `Ваш код: ${code}\nДействует 15 минут. Если вы не запрашивали сброс — просто игнорируйте письмо.`
    ).then(
      () => console.log('mail: sent to', email),
      e => console.error('mail:', e.message)
    );
  }
  res.json({ ok: true });
}));

router.post('/reset-confirm', strictLimiter, validate(resetConfirmSchema), ah(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  const u = await db.query(
    `SELECT id, reset_hash FROM users
      WHERE email=lower($1) AND reset_hash IS NOT NULL AND reset_expires > now()`, [email]);
  if (!u.rows.length) return res.status(400).json({ error: 'code_invalid' });
  const ok = await bcrypt.compare(String(code), u.rows[0].reset_hash);
  if (!ok) return res.status(400).json({ error: 'code_invalid' });
  const hash = await bcrypt.hash(newPassword, 10);
  // token_version+1 — сброс пароля обычно означает «я мог потерять контроль над
  // аккаунтом», поэтому заодно отзываем все ранее выданные токены.
  const v = await db.query(
    'UPDATE users SET pass_hash=$1, reset_hash=NULL, reset_expires=NULL, token_version=token_version+1 WHERE id=$2 RETURNING token_version',
    [hash, u.rows[0].id]
  );
  res.json({ token: sign(u.rows[0].id, v.rows[0].token_version) });
}));

// ── Подтверждение email ─────────────────────────────────────────────────────
router.get('/me', authMw, ah(async (req, res) => {
  const r = await db.query('SELECT email, email_verified_at, pdn_consent_at FROM users WHERE id=$1', [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_user' });
  res.json({
    email: r.rows[0].email,
    emailVerified: !!r.rows[0].email_verified_at,
    pdnConsentAt: r.rows[0].pdn_consent_at,
  });
}));

// Переход по ссылке из письма — обычная браузерная навигация, не JSON-запрос.
router.get('/verify-email', ah(async (req, res) => {
  const token = String(req.query.token || '');
  const frontendUrl = (process.env.CORS_ORIGIN || '').split(',')[0].trim();
  const redirectOk = frontendUrl && frontendUrl !== '*';
  if (!token) return res.status(400).send('Ссылка недействительна.');
  const u = await db.query(
    `UPDATE users SET email_verified_at=now(), verify_token=NULL, verify_expires=NULL
      WHERE verify_token=$1 AND verify_expires > now() AND email_verified_at IS NULL
      RETURNING id`, [token]);
  if (!u.rows.length) {
    return res.status(400).send('Ссылка для подтверждения email недействительна или уже устарела.');
  }
  if (redirectOk) return res.redirect(302, frontendUrl);
  res.send('Email подтверждён! Можно закрыть эту страницу и вернуться в приложение.');
}));

// Отписка от онбординг-рассылки (письма 2-4, см. lib/emails/) — ссылка из
// письма, обычная браузерная навигация. Токен не одноразовый и не истекает
// (см. lib/mail.js), поэтому не нужно ничего искать/чистить в БД для проверки.
router.get('/unsubscribe', ah(async (req, res) => {
  const uid = String(req.query.uid || '');
  const token = String(req.query.token || '');
  if (!uid || !verifyUnsubscribeToken(uid, token)) {
    return res.status(400).send('Ссылка недействительна.');
  }
  await db.query('UPDATE users SET unsubscribed_at=now() WHERE id=$1', [uid]);
  res.send('Вы отписаны от рассылки «Семейный поток». Письма о вашем аккаунте (подтверждение почты, сброс пароля, оплата) продолжат приходить.');
}));

// ── Вход через Яндекс ID ─────────────────────────────────────────────────
// Отдельного /auth/yandex/start нет: client_id не секретен, фронтенд сам
// ссылается на oauth.yandex.ru/authorize с redirect_uri сюда. Секрет нужен
// только здесь — при обмене code на access_token на сервере.
router.get('/yandex/callback', ah(async (req, res) => {
  const frontendUrl = (process.env.CORS_ORIGIN || '').split(',')[0].trim();
  const fail = reason => res.redirect(302, `${frontendUrl}/#yandex_error=${encodeURIComponent(reason)}`);

  const code = String(req.query.code || '');
  if (!code) return fail('no_code');
  if (!process.env.YANDEX_CLIENT_ID || !process.env.YANDEX_CLIENT_SECRET) {
    console.error('Yandex OAuth: YANDEX_CLIENT_ID/YANDEX_CLIENT_SECRET не заданы');
    return fail('not_configured');
  }

  let accessToken;
  try {
    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.YANDEX_CLIENT_ID,
        client_secret: process.env.YANDEX_CLIENT_SECRET,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'token_exchange_failed');
    accessToken = tokenData.access_token;
  } catch (e) {
    console.error('Yandex OAuth token exchange:', e.message);
    return fail('yandex_unavailable');
  }

  let email;
  try {
    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!infoRes.ok) throw new Error(`login.yandex.ru: ${infoRes.status}`);
    const info = await infoRes.json();
    email = String(info.default_email || (info.emails && info.emails[0]) || '').toLowerCase();
  } catch (e) {
    console.error('Yandex OAuth user info:', e.message);
    return fail('yandex_unavailable');
  }
  if (!email) return fail('no_email'); // пользователь не выдал доступ к почте на экране согласия Яндекса

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, token_version FROM users WHERE email=$1 AND deleted_at IS NULL', [email]
    );
    let userId, tokenVersion;
    if (existing.rows.length) {
      // Уже есть аккаунт с этим email (неважно, заведён паролем или Яндексом
      // раньше) — просто входим в него, отдельного «связывания» не делаем.
      ({ id: userId, token_version: tokenVersion } = existing.rows[0]);
    } else {
      // pass_hash обязателен схемой, но пароль осознанно никому не известен —
      // войти можно только через Яндекс, пока пользователь сам не задаст пароль
      // через «Забыли пароль». Email Яндекс уже проверил на своей стороне,
      // поэтому сразу считаем его подтверждённым и не шлём письмо с подтверждением.
      const unusablePass = crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(unusablePass, 10);
      const u = await client.query(
        `INSERT INTO users(email, pass_hash, email_verified_at, pdn_consent_at, pdn_consent_ip, auth_provider)
         VALUES($1, $2, now(), now(), $3, 'yandex') RETURNING id, token_version`,
        [email, hash, req.ip]
      );
      ({ id: userId, token_version: tokenVersion } = u.rows[0]);
      const f = await client.query(
        // Тот же срок, что и при обычной регистрации — см. lib/entitlement.js.
        `INSERT INTO families(name, trial_ends_at) VALUES($1, now() + ($2 || ' days')::interval) RETURNING id`,
        ['Моя семья', trialIntervalParam()]
      );
      await client.query(
        "INSERT INTO family_members(family_id, user_id, role) VALUES($1, $2, 'owner')",
        [f.rows[0].id, userId]
      );
      await client.query(
        'INSERT INTO family_states(family_id, data, updated_by) VALUES($1, $2, $3)',
        [f.rows[0].id, '{}', userId]
      );
    }
    await client.query('COMMIT');
    // Токен — во фрагменте (#), не в query: не попадает в access-логи сервера
    // и в заголовок Referer при переходе дальше.
    res.redirect(302, `${frontendUrl}/#yandex_token=${sign(userId, tokenVersion)}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Yandex OAuth account:', e);
    fail('server');
  } finally {
    client.release();
  }
}));

router.post('/resend-verification', authMw, ah(async (req, res) => {
  const u = await db.query('SELECT email, email_verified_at FROM users WHERE id=$1', [req.user.uid]);
  if (!u.rows.length) return res.status(404).json({ error: 'no_user' });
  if (u.rows[0].email_verified_at) return res.json({ ok: true, already: true });
  if (!mailConfigured()) return res.status(503).json({ error: 'mail_unavailable' });
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `UPDATE users SET verify_token=$1, verify_expires=now() + interval '24 hours' WHERE id=$2`,
    [token, req.user.uid]
  );
  const verifyLink = `${req.protocol}://${req.get('host')}/auth/verify-email?token=${token}`;
  sendMail(
    u.rows[0].email,
    'Подтвердите email в «Семейный поток»',
    `Подтвердите email: ${verifyLink}`,
    `<p><a href="${verifyLink}">Подтвердите свой email</a>, чтобы не потерять доступ при восстановлении пароля.</p>`
  ).then(
    () => console.log('verify mail: sent to', u.rows[0].email),
    e => console.error('verify mail:', e.message)
  );
  res.json({ ok: true });
}));

module.exports = router;
