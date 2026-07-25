// Разовый перенос уже сохранённых бюджетов семей в зашифрованный вид.
// Срабатывает при каждом старте сервера, но реально что-то делает только для
// строк, которые ещё не зашифрованы (data_enc IS NULL) — так что повторные
// запуски безопасны. Если DATA_ENC_KEY не задан — ничего не делает.
const db = require('../db');
const { encryptJSON, configured } = require('./crypto');

async function run() {
  if (!configured()) return;
  const { rows } = await db.query(
    `SELECT family_id, data FROM family_states WHERE data_enc IS NULL AND data IS NOT NULL AND data::text <> '{}'`
  );
  for (const row of rows) {
    const enc = encryptJSON(row.data);
    await db.query(`UPDATE family_states SET data_enc=$1, data='{}'::jsonb WHERE family_id=$2`, [enc, row.family_id]);
  }
  if (rows.length) console.log(`шифрование бюджетов: перенесено семей — ${rows.length}`);
}

module.exports = { run };
