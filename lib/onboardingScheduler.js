// Онбординг-письма 2-4 — перенос воронки из n8n. Письмо 1 (Welcome) шлётся сразу
// при регистрации (routes/auth.js), это письмо тут не трогаем. Тайминг считаем
// от users.created_at, повторяя схему из n8n (Wait 2 Days → Check Plan Status →
// true/false → Wait 5 Days → Email 3 → Wait 7 Days → Email 4):
//   день 3  — если план ещё не создан (family_states.data.onboarded !== true),
//             письмо 2 «Как спланировать»; если план уже создан — письмо
//             пропускается, как в false/true-развилке n8n.
//   день 7  — письмо 3, всегда, независимо от плана.
//   письмо 4 — 14-й день при длинном триале (30 дней) и 9-й при коротком (14):
//             день зависит от длины триала конкретного человека, см.
//             EMAIL4_DELAY_SQL ниже.
//
// РАСПИСАНИЕ СДВИНУТО ПОД КОРОТКИЙ ТРИАЛ. Раньше было 2 / 7 / 14 дней — схема
// из n8n, рассчитанная на 30-дневный пробный период. При 14-дневном триале
// письмо 4 приходило БЫ на 14-й день, то есть ровно тогда, когда Pro уже
// закончился, — советы по экономии в момент, когда половина функций только что
// закрылась, выглядят издевательством.
//
// Но день письма 4 сдвинут НЕ ГЛОБАЛЬНО: у тех, кто уже живёт с 30-дневным
// триалом, он остаётся прежним. Иначе при выкатке они все разом получили бы
// письмо, которое ещё не должны были получить.
//
// Письмо об окончании пробного периода живёт НЕ здесь, а в lib/scheduler.js:
// оно считается от фактического trial_ends_at, а не от даты регистрации, —
// иначе оно приходило бы не в срок тем, у кого триал 30-дневный.
// Планировщик живёт в основном процессе, как lib/scheduler.js и lib/pushScheduler.js —
// отдельного cron на хостинге нет.
const db = require('../db');
const { sendMail, mailConfigured, renderTemplate, unsubscribeUrl } = require('./mail');
const { decryptJSON } = require('./crypto');
const { withSchedulerLock } = require('./schedulerLock');

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
       AND created_at <= now() - interval '3 days'
  `);
  for (const row of rows) {
    // Отмечаем шаг пройденным независимо от результата проверки плана — как
    // true/false-развилка в n8n, письмо 2 могло быть пропущено осознанно.
    await db.query('UPDATE users SET onboarding_email2_sent_at=now() WHERE id=$1', [row.id]);
    if (await isPlanCreated(row.id)) continue;
    const unsubUrl = unsubscribeUrl(row.id);
    const mail = renderTemplate('2-reactivation-day1', { APP_URL, UNSUBSCRIBE_URL: unsubUrl });
    sendMail(row.email, SUBJECT2, mail.text, mail.html, unsubUrl)
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
    const unsubUrl = unsubscribeUrl(row.id);
    const mail = renderTemplate('3-budget-rules', { APP_URL, UNSUBSCRIBE_URL: unsubUrl });
    sendMail(row.email, SUBJECT3, mail.text, mail.html, unsubUrl)
      .catch(e => console.error('onboarding email3:', row.email, e.message));
  }
}

// День отправки письма 4 зависит от ДЛИНЫ триала конкретного человека, а не от
// глобальной настройки. Причина простая: если просто сдвинуть день с 14-го на
// 9-й, то все, кто сейчас старше 9 дней и письма ещё не получил, получат его
// одной пачкой на первом же прогоне планировщика — массовая рассылка, которую
// никто не заказывал.
//
// Поэтому:
//   • длинный триал (30 дней, старая когорта) — прежний 14-й день, ничего не
//     меняется и никакого catch-up не происходит;
//   • короткий триал (14 дней, будущая когорта) — 9-й день, чтобы письмо
//     успело прийти до окончания Pro.
//
// Порог в 20 дней — просто «сильно больше 14 и сильно меньше 30», любая точка
// между ними разводит когорты одинаково. Если длину определить нельзя (нет
// семьи или trial_ends_at), считаем триал длинным: отправить позже безопаснее,
// чем разослать раньше срока.
const EMAIL4_DELAY_SQL = `
  CASE WHEN f.trial_ends_at IS NOT NULL
        AND f.trial_ends_at - u.created_at < interval '20 days'
       THEN interval '9 days'
       ELSE interval '14 days'
  END`;

async function sendEmail4() {
  const { rows } = await db.query(`
    SELECT u.id, u.email FROM users u
      LEFT JOIN family_members m ON m.user_id = u.id
      LEFT JOIN families f ON f.id = m.family_id
     WHERE u.onboarding_email4_sent_at IS NULL
       AND u.unsubscribed_at IS NULL
       AND u.created_at <= now() - (${EMAIL4_DELAY_SQL})
  `);
  for (const row of rows) {
    await db.query('UPDATE users SET onboarding_email4_sent_at=now() WHERE id=$1', [row.id]);
    const unsubUrl = unsubscribeUrl(row.id);
    const mail = renderTemplate('4-saving', { APP_URL, UNSUBSCRIBE_URL: unsubUrl });
    sendMail(row.email, SUBJECT4, mail.text, mail.html, unsubUrl)
      .catch(e => console.error('onboarding email4:', row.email, e.message));
  }
}

function start() {
  if (!mailConfigured()) {
    console.log('onboarding scheduler: почта не настроена, письма 2-4 отключены');
    return;
  }
  const run = () => {
    withSchedulerLock('onboarding-scheduler', async () => {
      await Promise.all([
        sendEmail2().catch(e => console.error('onboarding email2 batch:', e.message)),
        sendEmail3().catch(e => console.error('onboarding email3 batch:', e.message)),
        sendEmail4().catch(e => console.error('onboarding email4 batch:', e.message)),
      ]);
    }).catch(e => console.error('onboarding scheduler lock:', e.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, SUBJECT2, SUBJECT3, SUBJECT4, isPlanCreated, EMAIL4_DELAY_SQL, sendEmail4 };
