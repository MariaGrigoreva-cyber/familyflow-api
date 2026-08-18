// Приглашения: owner генерирует код, второй супруг вводит его и присоединяется.
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const { computePlan } = require('../lib/billingLogic');
const validate = require('../middleware/validate');
const { familyJoinSchema } = require('../lib/schemas');

const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих символов
const genCode = () => Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');

// Общий бюджет на нескольких участников — фича Pro (см. Settings.jsx на фронте).
// На free-тарифе семья остаётся в составе одного владельца; уже добавленных
// участников при истечении подписки не выгоняем — ограничиваем только новые
// приглашения/присоединения.
const FREE_MEMBER_LIMIT = 1;

router.get('/me', auth, ah(async (req, res) => {
  const r = await db.query(
    `SELECT f.id, f.name, f.invite_code, m.role, u.email, u.created_at AS user_created_at, u.feedback_status,
            (SELECT count(*) FROM family_members WHERE family_id=f.id)::int AS members
       FROM family_members m JOIN families f ON f.id=m.family_id JOIN users u ON u.id=m.user_id
      WHERE m.user_id=$1`, [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_family' });
  const { id, name, invite_code, role, email, user_created_at, feedback_status, members } = r.rows[0];
  // Попап обратной связи: 14+ дней с регистрации и пользователь ещё не ответил
  // (не оставил отзыв и не отказался) — см. routes/feedback.js и schema.sql.
  const daysSinceRegistration = (Date.now() - new Date(user_created_at).getTime()) / 86400000;
  const showFeedbackPrompt = feedback_status === 'pending' && daysSinceRegistration >= 14;
  res.json({ id, name, invite_code, role, email, members, showFeedbackPrompt });
}));

router.post('/invite', auth, ah(async (req, res) => {
  const m = await db.query(
    "SELECT f.trial_ends_at, f.pro_until, m.family_id FROM family_members m JOIN families f ON f.id=m.family_id WHERE m.user_id=$1 AND m.role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  if (computePlan(m.rows[0]) === 'free') return res.status(403).json({ error: 'pro_required' });
  const code = genCode();
  await db.query('UPDATE families SET invite_code=$1 WHERE id=$2', [code, m.rows[0].family_id]);
  res.json({ code });
}));

router.post('/join', auth, validate(familyJoinSchema), ah(async (req, res) => {
  const { code } = req.body;
  const f = await db.query('SELECT id FROM families WHERE invite_code=$1', [code]);
  if (!f.rows.length) return res.status(404).json({ error: 'code_not_found' });
  const fid = f.rows[0].id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Покидаем прежнюю семью (упрощение фазы 0: один пользователь — одна семья).
    // Если пользователь был единственным участником — его старая семья удаляется целиком.
    const old = await client.query('SELECT family_id FROM family_members WHERE user_id=$1', [req.user.uid]);
    if (old.rows.length) {
      const oldFid = old.rows[0].family_id;
      if (oldFid === fid) { await client.query('ROLLBACK'); return res.json({ ok: true, familyId: fid, already: true }); }
    }

    // Лимит участников на free-тарифе целевой семьи — общий бюджет на нескольких
    // участников это Pro-фича (см. FREE_MEMBER_LIMIT выше). FOR UPDATE блокирует
    // строку семьи на время транзакции — без этого два одновременных /join на одну
    // free-семью могли оба пройти проверку count до того, как любой из них закоммитится,
    // и превысить лимит.
    const target = await client.query('SELECT trial_ends_at, pro_until FROM families WHERE id=$1 FOR UPDATE', [fid]);
    if (computePlan(target.rows[0] || {}) === 'free') {
      const cnt = await client.query('SELECT count(*)::int AS c FROM family_members WHERE family_id=$1', [fid]);
      if (cnt.rows[0].c >= FREE_MEMBER_LIMIT) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'pro_required' });
      }
    }

    if (old.rows.length) {
      await client.query('DELETE FROM family_members WHERE user_id=$1', [req.user.uid]);
      const left = await client.query('SELECT 1 FROM family_members WHERE family_id=$1 LIMIT 1', [old.rows[0].family_id]);
      if (!left.rows.length) await client.query('DELETE FROM families WHERE id=$1', [old.rows[0].family_id]);
    }
    await client.query(
      "INSERT INTO family_members(family_id, user_id, role) VALUES($1, $2, 'member')", [fid, req.user.uid]);
    await client.query('COMMIT');
    const st = await db.query('SELECT data, updated_at FROM family_states WHERE family_id=$1', [fid]);
    res.json({ ok: true, familyId: fid, data: st.rows[0]?.data || {}, updatedAt: st.rows[0]?.updated_at || null });
  } catch (e) {
    // ROLLBACK сам может упасть, если соединение уже разорвано исходной ошибкой —
    // тогда это была бы вторая необработанная ошибка внутри catch.
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
}));

module.exports = router;
