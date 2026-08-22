// /auth/delete-account (routes/auth.js) только помечает аккаунт deleted_at — не
// пускает войти и отзывает токены, но саму строку не удаляет: так у пользователя,
// который передумал или чью сессию угнали и удалили за него, есть окно на
// восстановление через поддержку. Здесь, спустя грейс-период, доводим удаление
// до конца по-настоящему — это и есть право на удаление персональных данных
// по 152-ФЗ, просто с окном, а не мгновенной необратимостью.
const db = require('../db');
const { withSchedulerLock } = require('./schedulerLock');

const GRACE_DAYS = Number(process.env.ACCOUNT_PURGE_GRACE_DAYS || 30);

async function purgeDeletedAccounts() {
  // family_members и push_subscriptions уже убраны явно в момент /delete-account —
  // к моменту очистки на эту строку users ничего не ссылается, ON DELETE не нужен.
  const { rows } = await db.query(
    `DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 * interval '1 day') RETURNING id`,
    [GRACE_DAYS]
  );
  if (rows.length) console.log(`account purge: удалено ${rows.length} аккаунтов старше ${GRACE_DAYS} дн. после запроса на удаление`);
}

function start() {
  const run = () => withSchedulerLock('account-purge-scheduler', purgeDeletedAccounts)
    .catch(e => console.error('account purge:', e.message));
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, purgeDeletedAccounts };
