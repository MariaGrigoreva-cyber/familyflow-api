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

async function sendToUser(userId, payload) {
  if (!configured()) return;
  const { rows } = await db.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1', [userId]
  );
  await Promise.all(rows.map(async row => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload)
      );
    } catch (e) {
      // 404/410 — подписка больше не существует (юзер отписался, сменил браузер и т.п.)
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id=$1', [row.id]);
      } else {
        console.error('push send failed:', e.message);
      }
    }
  }));
}

module.exports = { sendToUser, configured };
