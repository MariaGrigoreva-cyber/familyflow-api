// POST /state/reset (routes/state.js) не стирает предыдущий бюджет сразу — переносит
// его в reset_backup(_enc) с отметкой reset_at, давая пользователю окно на
// восстановление через POST /state/restore-backup после случайного нажатия
// «Сбросить все данные». Здесь, спустя грейс-период, забытую резервную копию
// стираем по-настоящему — тот же принцип отложенного удаления, что и у
// accountPurgeScheduler.js, только для содержимого бюджета, а не самого аккаунта.
const db = require('../db');

const GRACE_DAYS = Number(process.env.STATE_RESET_GRACE_DAYS || 90);

async function purgeStateResetBackups() {
  const { rows } = await db.query(
    `UPDATE family_states SET reset_backup=NULL, reset_backup_enc=NULL, reset_at=NULL
     WHERE reset_at IS NOT NULL AND reset_at < now() - ($1 * interval '1 day')
     RETURNING family_id`,
    [GRACE_DAYS]
  );
  if (rows.length) console.log(`state reset purge: очищено ${rows.length} резервных копий сброса старше ${GRACE_DAYS} дн.`);
}

function start() {
  const run = () => purgeStateResetBackups().catch(e => console.error('state reset purge:', e.message));
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, purgeStateResetBackups };
