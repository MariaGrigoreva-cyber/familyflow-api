// Раз в час: (1) по понедельникам напоминает раз в неделю свериться с бюджетом,
// (2) в день фактической зарплаты/аванса (с учётом переноса из-за праздников и
// выходных — см. getActualPayDate ниже, повторяет логику src/lib/core.js на
// фронтенде) напоминает отметить выплату как полученную.
const db = require('../db');
const webpush = require('./webpush');

const WEEKLY_PUSH_HOUR_UTC = Number(process.env.WEEKLY_PUSH_HOUR_UTC || 7); // 7:00 UTC ≈ 10:00 МСК

// ── Перенос даты выплаты на ближайший будний нерабочий день назад ──────────
// ВАЖНО: список праздников должен совпадать со src/lib/core.js (RU_HOLIDAYS) —
// при обновлении на одной стороне обновить и на другой.
const MONTH_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const DAYS_RU = ['вс','пн','вт','ср','чт','пт','сб'];
const RU_HOLIDAYS = new Set(['2025-12-31','2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-02-23','2026-03-09','2026-05-01','2026-05-04','2026-05-05','2026-05-09','2026-06-12','2026-11-04','2026-12-31','2027-01-01','2027-01-02','2027-01-03','2027-01-04','2027-01-05','2027-01-06','2027-01-07','2027-01-08','2027-02-22','2027-03-08','2027-05-01','2027-05-10','2027-06-12','2027-11-04','2027-11-05','2027-12-31','2028-01-01','2028-01-02','2028-01-03','2028-01-04','2028-01-05','2028-01-06','2028-01-07','2028-01-08','2028-02-23','2028-03-08','2028-05-01','2028-05-09','2028-06-12','2028-11-04']);

const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const getActualPayDate = (year, month, day) => {
  let d = new Date(year, month - 1, day);
  for (let i = 0; i < 20; i++) {
    const dow = d.getDay(), ds = localDateStr(d);
    if (dow !== 0 && dow !== 6 && !RU_HOLIDAYS.has(ds)) break;
    d = new Date(d.getTime() - 86400000);
  }
  return d;
};
const sameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Платёж дня X может из-за переноса сдвинуться только НАЗАД (getActualPayDate
// всегда идёт в прошлое) — поэтому чтобы поймать сдвиг через границу месяца,
// проверяем числа текущего и следующего месяца, спроецированные на сегодня.
function findTodaysPayDays(daysArr, today) {
  const hits = [];
  for (const monthOffset of [0, 1]) {
    const probe = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const year = probe.getFullYear(), month = probe.getMonth() + 1;
    const daysInM = new Date(year, month, 0).getDate();
    for (const d of (daysArr || [])) {
      const actual = getActualPayDate(year, month, Math.min(d, daysInM));
      if (sameDate(actual, today)) hits.push(actual);
    }
  }
  return hits;
}

async function sendPaydayReminders() {
  const { rows } = await db.query(`
    SELECT f.id AS family_id,
           fs.data->'appState'->'incomes' AS incomes,
           fs.data->'appState'->'members' AS members,
           m.user_id
      FROM families f
      JOIN family_states fs ON fs.family_id = f.id
      JOIN family_members m ON m.family_id = f.id
  `);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  for (const row of rows) {
    const incomes = Array.isArray(row.incomes) ? row.incomes : [];
    const members = Array.isArray(row.members) ? row.members : [];
    for (const inc of incomes) {
      const memberName = members.find(m => m.id === inc.memberId)?.name || '';
      for (const [kind, days, label] of [['salary', inc.salaryDays, 'Зарплата'], ['advance', inc.advanceDays, 'Аванс']]) {
        if (!findTodaysPayDays(days, today).length) continue;
        const ins = await db.query(
          `INSERT INTO push_payment_reminders_sent(family_id, planned_id, due_date, kind)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`,
          [row.family_id, String(inc.id), todayStr, kind]
        );
        if (!ins.rows.length) continue; // уже отправляли сегодня
        await webpush.sendToUser(row.user_id, {
          title: `${label} сегодня`,
          body: memberName ? `${memberName} · отметьте в приложении, когда получите` : 'Отметьте в приложении, когда получите',
          tag: `payday-${inc.id}-${kind}-${todayStr}`,
        });
      }
    }
  }
}

async function sendWeeklyReminders() {
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== WEEKLY_PUSH_HOUR_UTC) return; // только по понедельникам, в свой час
  const today = now.toISOString().slice(0, 10);
  const { rows } = await db.query(`
    SELECT DISTINCT u.id FROM users u
    JOIN push_subscriptions ps ON ps.user_id = u.id
    WHERE u.last_weekly_push_at IS NULL OR u.last_weekly_push_at < $1
  `, [today]);
  for (const row of rows) {
    await webpush.sendToUser(row.id, {
      title: 'Загляните в бюджет',
      body: 'Пора свериться с планом — обычно это занимает 10 минут.',
      tag: 'weekly-reminder',
    });
    await db.query('UPDATE users SET last_weekly_push_at=$1 WHERE id=$2', [today, row.id]);
  }
}

function start() {
  if (!webpush.configured()) {
    console.log('push scheduler: VAPID-ключи не заданы, push-уведомления отключены');
    return;
  }
  const run = () => {
    sendWeeklyReminders().catch(e => console.error('weekly push:', e.message));
    sendPaydayReminders().catch(e => console.error('payday push:', e.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start };
