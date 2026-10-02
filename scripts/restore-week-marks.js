#!/usr/bin/env node
// Разовое восстановление недельных отметок («оплачено», копилка, ручные правки
// сумм) одной семьи из истории версий снапшота (family_state_versions).
//
// ЗАЧЕМ. До familyflow-web 60e35748 сохранение дохода в Настройках пересобирало
// weekItems от текущей недели вперёд: все прошлые недели вместе с отметками
// пропадали, и «остаток на руках» вырастал на всё уже потраченное. Запись шла
// обычным PUT без отставания от сервера, поэтому слияние (lib/stateMerge.js) не
// включалось и урезанный снапшот просто перезаписал серверный.
//
// ЧТО ДЕЛАЕТ. Берёт из истории версию, где отметки ещё были, и возвращает в
// текущее состояние ТОЛЬКО недели, которых в нём сейчас нет. Недели, которые в
// текущем состоянии есть, не трогаются; доходы, выплаты, операции и всё прочее
// остаются как есть — это не откат бюджета к старой версии.
//
// ГРАНИЦЫ. Работает строго с одной семьёй — той, в которой состоит пользователь
// с указанным email: одна строка family_states и строки истории этой же семьи.
// Чужие данные не читаются и не меняются.
//
// ЗАПУСК (нужны DATABASE_URL и DATA_ENC_KEY боевого окружения):
//   node scripts/restore-week-marks.js --email user@example.com
//       только чтение: список версий и что именно будет восстановлено
//   node scripts/restore-week-marks.js --email user@example.com --apply
//       записать (из версии, выбранной автоматически)
//   ... --from 2026-10-02T08:15:30.123Z
//       взять конкретную версию из списка вместо автоматической
const db = require('../db');
const { encryptJSON, decryptJSON, configured } = require('../lib/crypto');

// Клиент хранит бюджет в двух формах: {consented, onboarded, appState} и легаси —
// сам appState в корне (см. lib/stateMerge.js).
const appOf = data => (data && typeof data === 'object' && data.appState ? data.appState : data) || {};

const hasMark = items => (items || []).some(i => i && (i.isDone || i.edited));

// Недели с отметками в снапшоте: {неделя: {spent, piggy, items}}.
function markedWeeks(data) {
  const out = {};
  for (const [wk, items] of Object.entries(appOf(data).weekItems || {})) {
    if (!hasMark(items)) continue;
    const done = items.filter(i => i.isDone);
    const sum = list => list.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    out[wk] = {
      spent: sum(done.filter(i => i.catId !== 'piggy')),
      piggy: sum(done.filter(i => i.catId === 'piggy')),
      items: items.length,
    };
  }
  return out;
}

// Какие недели вернуть: есть с отметками в источнике и отсутствуют в текущем.
function weeksToRestore(current, source) {
  const cur = appOf(current).weekItems || {};
  return Object.keys(markedWeeks(source)).filter(wk => !Object.hasOwn(cur, wk)).sort();
}

// Новое состояние: текущее + недостающие недели из источника. Ничего не мутирует.
function restoreWeeks(current, source) {
  const weeks = weeksToRestore(current, source);
  if (!weeks.length) return { data: current, weeks };
  const src = appOf(source).weekItems;
  const weekItems = { ...(appOf(current).weekItems || {}) };
  weeks.forEach(wk => { weekItems[wk] = src[wk]; });
  const data = current.appState
    ? { ...current, appState: { ...current.appState, weekItems } }
    : { ...current, weekItems };
  return { data, weeks };
}

// Источник по умолчанию: версия, из которой восстановится больше всего недель;
// при равенстве — самая свежая (versions приходят от новых к старым).
function pickSource(current, versions) {
  let best = null;
  for (const v of versions) {
    const n = weeksToRestore(current, v.data).length;
    if (n > 0 && (!best || n > best.n)) best = { ...v, n };
  }
  return best;
}

const readData = row => (row.data_enc ? decryptJSON(row.data_enc) : row.data || {});
const fmt = n => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };

async function main() {
  const email = arg('--email');
  const from = arg('--from');
  const apply = process.argv.includes('--apply');
  if (!email) throw new Error('Укажите --email');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');

  const fam = await db.query(
    `SELECT fm.family_id, (SELECT count(*) FROM family_members x WHERE x.family_id = fm.family_id) AS members
       FROM users u JOIN family_members fm ON fm.user_id = u.id
      WHERE lower(u.email) = lower($1)`, [email]);
  if (fam.rows.length !== 1) throw new Error(`Пользователь не найден или состоит не в одной семье (найдено: ${fam.rows.length})`);
  const fid = fam.rows[0].family_id;
  console.log(`Семья ${fid}, участников с доступом: ${fam.rows[0].members}`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE — чтобы сохранение из приложения не вклинилось между чтением и записью.
    const cur = await client.query(
      `SELECT data, data_enc, updated_at FROM family_states WHERE family_id=$1 FOR UPDATE`, [fid]);
    if (!cur.rows[0]) throw new Error('У семьи нет сохранённого состояния');
    if (cur.rows[0].data_enc && !configured()) throw new Error('Данные зашифрованы, а DATA_ENC_KEY не задан');
    const current = readData(cur.rows[0]);
    const currentAt = cur.rows[0].updated_at;

    const vers = await client.query(
      `SELECT data, data_enc, updated_at FROM family_state_versions
        WHERE family_id=$1 ORDER BY updated_at DESC`, [fid]);
    const versions = vers.rows.map(r => ({ updatedAt: r.updated_at, data: readData(r) }));

    console.log(`\nСейчас (${currentAt.toISOString()}): недель с отметками — ${Object.keys(markedWeeks(current)).length}`);
    console.log(`Версий в истории: ${versions.length}`);
    for (const v of versions) {
      const m = markedWeeks(v.data);
      const keys = Object.keys(m).sort();
      console.log(`  ${v.updatedAt.toISOString()}  недель с отметками: ${String(keys.length).padStart(2)}`
        + `  вернётся: ${String(weeksToRestore(current, v.data).length).padStart(2)}`
        + (keys.length ? `  (${keys[0]} … ${keys[keys.length - 1]})` : ''));
    }

    const source = from
      ? versions.find(v => v.updatedAt.toISOString() === new Date(from).toISOString())
      : pickSource(current, versions);
    if (!source) {
      console.log(from ? '\nВерсия с таким временем не найдена.' : '\nВ истории нет версии, из которой есть что вернуть.');
      await client.query('ROLLBACK');
      return;
    }

    const { data: next, weeks } = restoreWeeks(current, source.data);
    const m = markedWeeks(source.data);
    console.log(`\nИсточник: версия ${source.updatedAt.toISOString()}`);
    let spent = 0, piggy = 0;
    for (const wk of weeks) {
      spent += m[wk].spent; piggy += m[wk].piggy;
      console.log(`  ${wk}: расходы ${fmt(m[wk].spent)}, копилка ${fmt(m[wk].piggy)}`);
    }
    console.log(`Итого вернётся недель: ${weeks.length}; расходы ${fmt(spent)}, копилка ${fmt(piggy)}`);
    console.log(`«Остаток на руках» уменьшится на ${fmt(spent + piggy)}.`);

    if (!apply || !weeks.length) {
      await client.query('ROLLBACK');
      if (weeks.length) console.log('\nЭто был пробный прогон, ничего не записано. Для записи добавьте --apply.');
      return;
    }

    const useEnc = configured();
    const enc = v => (useEnc ? encryptJSON(v) : null);
    const plain = v => (useEnc ? {} : v);
    // Текущее состояние — в историю, как это делает PUT /state: это и точка
    // отката, и база для слияния у устройств, которые держат его на руках.
    await client.query(
      `INSERT INTO family_state_versions(family_id, updated_at, data, data_enc)
       VALUES($1,$2,$3,$4) ON CONFLICT (family_id, updated_at) DO NOTHING`,
      [fid, currentAt, plain(current), enc(current)]);
    const r = await client.query(
      `UPDATE family_states SET data=$2, data_enc=$3, updated_at=date_trunc('milliseconds', now())
        WHERE family_id=$1 RETURNING updated_at`,
      [fid, plain(next), enc(next)]);
    await client.query(
      `INSERT INTO family_state_versions(family_id, updated_at, data, data_enc)
       VALUES($1,$2,$3,$4) ON CONFLICT (family_id, updated_at) DO NOTHING`,
      [fid, r.rows[0].updated_at, plain(next), enc(next)]);
    await client.query('COMMIT');
    console.log(`\nЗаписано. Новая версия: ${r.rows[0].updated_at.toISOString()}`);
    console.log(`Состояние до восстановления сохранено в истории как ${currentAt.toISOString()}.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main().then(() => db.end()).catch(e => { console.error('Ошибка:', e.message); db.end().finally(() => process.exit(1)); });
}

module.exports = { markedWeeks, weeksToRestore, restoreWeeks, pickSource };
