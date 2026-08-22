// Гарантирует, что часовой прогон планировщика (lib/scheduler.js, pushScheduler.js
// и т.д.) выполняется только одним инстансом одновременно — на случай если
// приложение когда-нибудь запустят в нескольких копиях (сейчас это один процесс,
// но планировщики живут прямо в нём, см. server.js). Без этого два инстанса
// одновременно отправили бы одни и те же письма/push и, что хуже, дважды
// списали бы автопродление подписки.
//
// Postgres advisory lock: session-scoped, поэтому лочим и разлочиваем на одном
// и том же клиенте, а не через общий pool.query — там каждый запрос может уйти
// на другое соединение пула. pg_try_advisory_lock не блокирует и не ждёт: если
// лок занят другим инстансом, эта попытка просто тихо пропускает прогон —
// он и так повторится через час.
const db = require('../db');

async function withSchedulerLock(name, fn) {
  const client = await db.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [name]);
    if (!rows[0].locked) return false;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]);
    }
    return true;
  } finally {
    client.release();
  }
}

module.exports = { withSchedulerLock };
