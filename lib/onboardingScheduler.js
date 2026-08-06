// Онбординг-письма 2-4 — перенос воронки из n8n. Письмо 1 (Welcome) шлётся сразу
// при регистрации (routes/auth.js), это письмо тут не трогаем. Тайминг считаем
// от users.created_at, повторяя схему из n8n (Wait 2 Days → Check Plan Status →
// true/false → Wait 5 Days → Email 3 → Wait 7 Days → Email 4):
//   день 2  — если план ещё не создан (family_states.data.onboarded !== true),
//             письмо 2 «Как спланировать»; если план уже создан — письмо
//             пропускается, как в false/true-развилке n8n.
//   день 7  (2+5 по схеме n8n) — письмо 3, всегда, независимо от плана.
//   день 14 (7+7 по схеме n8n) — письмо 4, всегда.
// Планировщик живёт в основном процессе, как lib/scheduler.js и lib/pushScheduler.js —
// отдельного cron на хостинге нет.
const db = require('../db');
const { sendMail, mailConfigured, renderTemplate, unsubscribeUrl } = require('./mail');
const { decryptJSON } = require('./crypto');

const APP_URL = (process.env.CORS_ORIGIN || '').split(',')[0].trim() || 'https://myfamilyflow.ru';

// Тексты писем — в lib/emails/*.html + .txt. Шаблон рендерится на каждого
// получателя отдельно (не один раз при старте) — ссылка отписки персональная.
const SUBJECT2 = 'Начнём с одной строчки';
const SUBJECT3 = 'Бюджет, к которому хочется возвращаться';
const SUBJECT4 = 'Экономить, ничего себе не запрещая';

// family_states хранится зашифрованным (см. lib/crypto.js) — читаем сырой блок
// и расшифровываем в JS, как это уже делает lib/pushScheduler.js.
async function isPlanCreated(userId) {
  const r = await db.query(`
    SELECT fs.data, fs.data_enc
      FROM family_members m
      JOIN family_states fs ON fs.family_id = m.family_id
     WHERE m.user_id = $1
  `, [userId]);
  if (!r.rows.length) return false;
  const row = r.rows[0];
  try {
    const data = row.data_enc ? decryptJSON(row.data_enc) : row.data;
    return data?.onboarded === true;
  } catch (e) {
    console.error('onboarding scheduler decrypt:', e.message);
    return false;
  }
}

async function sendEmail2() {
  const { rows } = await db.query(`
    SELECT id, email FROM users
     WHERE onboarding_email2_sent_at IS NULL
       AND unsubscribed_at IS NULL
       AND created_at <= now() - interval '2 days'
  `);
  for (const row of rows) {
    // Отмечаем шаг пройденным независимо от результата проверки плана — как
    // true/false-развилка в n8n, письмо 2 могло быть пропущено осознанно.
    await db.query('UPDATE users SET onboarding_email2_sent_at=now() WHERE id=$1', [row.id]);
    if (await isPlanCreated(row.id)) continue;
    const mail = renderTemplate('2-reactivation-day1', { APP_URL, UNSUBSCRIBE_URL: unsubscribeUrl(row.id) });
    sendMail(row.email, SUBJECT2, mail.text, mail.html)
      .catch(e => console.error('onboarding email2:', row.email, e.message));
  }
}

async function sendEmail3() {
  const { rows } = await db.query(`
    SELECT id, email FROM users
     WHERE onboarding_email3_sent_at IS NULL
       AND unsubscribed_at IS NULL
       AND created_at <= now() - interval '7 days'
  `);
  for (const row of rows) {
    await db.query('UPDATE users SET onboarding_email3_sent_at=now() WHERE id=$1', [row.id]);
    const mail = renderTemplate('3-budget-rules', { APP_URL, UNSUBSCRIBE_URL: unsubscribeUrl(row.id) });
    sendMail(row.email, SUBJECT3, mail.text, mail.html)
      .catch(e => console.error('onboarding email3:', row.email, e.message));
  }
}

async function sendEmail4() {
  const { rows } = await db.query(`
    SELECT id, email FROM users
     WHERE onboarding_email4_sent_at IS NULL
       AND unsubscribed_at IS NULL
       AND created_at <= now() - interval '14 days'
  `);
  for (const row of rows) {
    await db.query('UPDATE users SET onboarding_email4_sent_at=now() WHERE id=$1', [row.id]);
    const mail = renderTemplate('4-saving', { APP_URL, UNSUBSCRIBE_URL: unsubscribeUrl(row.id) });
    sendMail(row.email, SUBJECT4, mail.text, mail.html)
      .catch(e => console.error('onboarding email4:', row.email, e.message));
  }
}

function start() {
  if (!mailConfigured()) {
    console.log('onboarding scheduler: почта не настроена, письма 2-4 отключены');
    return;
  }
  const run = () => {
    sendEmail2().catch(e => console.error('onboarding email2 batch:', e.message));
    sendEmail3().catch(e => console.error('onboarding email3 batch:', e.message));
    sendEmail4().catch(e => console.error('onboarding email4 batch:', e.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, SUBJECT2, SUBJECT3, SUBJECT4, isPlanCreated };
