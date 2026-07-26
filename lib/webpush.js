// Обёртка над web-push: рассылка конкретному пользователю по всем его подпискам
// (может быть несколько устройств), с автоочисткой отписавшихся подписок.
const webpush = require('web-push');
const db = require('../db');

const configured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (configured()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@myfamilyflow.ru',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Возвращает {ok:true}, если доставлять было некуда/некому (нет подписок, все
// протухшие 404/410) или хотя бы одна подписка приняла уведомление, и
// {ok:false} при временном сбое доставки (5xx, сеть и т.п.) — вызывающий код
// использует это, чтобы не считать напоминание отправленным и попробовать
// снова на следующем прогоне планировщика, а не терять его безвозвратно.
async function sendToUser(userId, payload) {
  if (!configured()) return { ok: true };
  const { rows } = await db.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1', [userId]
  );
  if (!rows.length) return { ok: true };

  let delivered = false;
  let transientFailure = false;
  await Promise.all(rows.map(async row => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload)
      );
      delivered = true;
    } catch (e) {
      // 404/410 — подписка больше не существует (юзер отписался, сменил браузер и т.п.)
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id=$1', [row.id]);
      } else {
        console.error('push send failed:', e.message);
        transientFailure = true;
      }
    }
  }));
  return { ok: delivered || !transientFailure };
}

module.exports = { sendToUser, configured };
