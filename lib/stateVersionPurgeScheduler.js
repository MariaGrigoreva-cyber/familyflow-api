// Чистка истории версий снапшота (family_state_versions).
//
// История нужна ровно для одного: найти общую базу при трёхстороннем слиянии в
// PUT /state (см. lib/stateMerge.js). Ценность версии быстро падает — она
// полезна, пока какое-то устройство всё ещё держит её как baseUpdatedAt, то
// есть дни, а не месяцы. Поэтому здесь не архив: старое удаляется целиком, в
// том числе последняя оставшаяся версия семьи. Текущее состояние живёт в
// family_states и этой чисткой не затрагивается.
//
// Если база всё-таки не найдена, PUT не теряет данные, а отвечает 409
// (BASE_NOT_FOUND) — клиент получает актуальное состояние и решает сам.
const db = require('../db');
const { withSchedulerLock } = require('./schedulerLock');

// Сколько версий на семью держим независимо от возраста — потолок на объём при
// очень активном редактировании (каждое сохранение это версия).
const MAX_VERSIONS = Number(process.env.STATE_VERSION_MAX_PER_FAMILY || 20);
const RETENTION_DAYS = Number(process.env.STATE_VERSION_RETENTION_DAYS || 30);

async function purgeStateVersions() {
  const { rowCount } = await db.query(
    `DELETE FROM family_state_versions v
      USING (
        SELECT family_id, updated_at, created_at,
               row_number() OVER (PARTITION BY family_id ORDER BY updated_at DESC) AS rn
          FROM family_state_versions
      ) r
      WHERE v.family_id = r.family_id AND v.updated_at = r.updated_at
        AND (r.rn > $1 OR r.created_at < now() - ($2 * interval '1 day'))`,
    [MAX_VERSIONS, RETENTION_DAYS]
  );
  if (rowCount) console.log(`state version purge: удалено ${rowCount} версий (лимит ${MAX_VERSIONS} на семью, срок ${RETENTION_DAYS} дн.)`);
}

function start() {
  const run = () => withSchedulerLock('state-version-purge-scheduler', purgeStateVersions)
    .catch(e => console.error('state version purge:', e.message));
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, purgeStateVersions };
