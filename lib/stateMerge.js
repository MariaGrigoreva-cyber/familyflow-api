// Трёхстороннее слияние снапшотов бюджета.
//
// ЗАЧЕМ. Раньше PUT /state был last-write-wins по всему снапшоту: клиент
// присылал состояние целиком, и оно затирало серверное. Оптимистичная блокировка
// по baseUpdatedAt только ОТКАЗЫВАЛА в записи (409), но не умела соединить две
// ветки — а клиент на 409 принимал серверную версию и молча выбрасывал свои
// правки. Реальный сценарий потери: на телефоне отмечена полученная зарплата,
// на компьютере открыт снапшот без этой отметки — и «остаток на руках» падает
// на всю зарплату, потому что доход считается только по отметкам isDone
// (familyflow-web/src/lib/core.js, computeBalances → unmarkedPayments).
//
// Отметки — это ОПЕРАЦИИ, а не состояние: два устройства, отметившие разные
// платежи, не конфликтуют, их правки обязаны сложиться. Трёхстороннее слияние
// (общая база → две ветки) как раз это и даёт, и заодно корректно разбирает
// удаления без надгробий: удалено то, что было в базе и исчезло в ветке.
//
// ГДЕ БЕРЁТСЯ БАЗА. Сервер хранит недавние версии снапшота (family_state_versions),
// и по baseUpdatedAt из запроса достаёт ровно ту, которую клиент видел последней.
// Поэтому слияние работает и для уже опубликованного клиента RuStore, который
// про слияние ничего не знает: он и так шлёт {data, baseUpdatedAt}.
//
// ЦЕНА РЕШЕНИЯ. Этот модуль — единственное место в API, которое знает структуру
// бюджета; в остальном data остаётся непрозрачной (schema.js держит её z.any()).
// Поэтому правила ниже заданы таблицей, а всё незнакомое обрабатывается
// консервативным значением по умолчанию — новый ключ на клиенте не требует
// правки сервера и не теряется.

// ── Канонический JSON для сравнения ──────────────────────────────────────────
// JSON.stringify сравнивать нельзя: у объектов с одинаковым содержимым порядок
// ключей может отличаться (разные ветки кода собирают объект по-разному), и
// такие значения ошибочно считались бы изменёнными. Сортируем ключи рекурсивно.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

const eq = (a, b) => canonical(a) === canonical(b);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Базовый выбор значения ───────────────────────────────────────────────────
// Классические правила трёхстороннего слияния. Настоящий конфликт (обе стороны
// изменили одно поле по-разному) разрешается в пользу входящей записи: она
// происходит сейчас, серверное значение записано раньше. Это last-write-wins,
// но ТОЛЬКО на честно конфликтующем поле — а не на всём снапшоте, как было.
function pick(base, mine, theirs) {
  if (eq(mine, theirs)) return mine;   // обе стороны пришли к одному
  if (eq(mine, base)) return theirs;   // изменил только сервер
  if (eq(theirs, base)) return mine;   // изменил только клиент
  return mine;                         // конфликт
}

// ── Правила по ключам снапшота ───────────────────────────────────────────────
// Правило ищется по ИМЕНИ ключа, а не по полному пути, и это принципиально:
// клиент хранит бюджет в двух формах. Новая — {consented, onboarded, appState},
// легаси — сам appState в корне (familyflow-web/src/App.jsx умеет читать обе).
// Привязка к пути 'appState.weekItems' на легаси-снапшоте просто не нашла бы
// правил, и слияние молча выродилось бы в перезапись целиком — ровно ту, от
// которой мы уходим. Имена ключей внутри записей (planned, incomes,
// extraPayments и т.д.) с этими не пересекаются, так что ложных совпадений нет.
//
// deletable:false у weekItems — не перестраховка, а следствие того, как клиент
// их строит. generateAllWeeks() пересобирает 104 недели СКОЛЬЗЯЩИМ окном от
// сегодняшнего дня, поэтому неделя, отсутствующая в чужом снапшоте, чаще всего
// значит «окно уехало», а не «неделю удалили». Трактовать это как удаление —
// значит терять отметки. Мусорные позиции безопасны: regenWeeksKeepDone на
// клиенте всё равно пересоберёт недели из planned при следующем запуске.
const RULES = {
  weekItems:     { kind: 'weekMap' },
  payments:      { kind: 'keyedMap', deletable: true },
  transactions:  { kind: 'idList', deletable: true, sortBy: 'date' },
  extraPayments: { kind: 'idList', deletable: true },
  planned:       { kind: 'idList', deletable: true },
  incomes:       { kind: 'idList', deletable: true },
  members:       { kind: 'idList', deletable: true },
  customCats:    { kind: 'idList', deletable: true },
};

// Сегмент '*' обозначает «элемент коллекции»: внутри записи правила коллекций
// применяться не должны, иначе поле записи со случайно совпавшим именем поехало
// бы по чужому правилу.
const ruleFor = path => {
  const leaf = path.slice(path.lastIndexOf('.') + 1);
  return leaf === '*' ? undefined : RULES[leaf];
};

// ── Слияние коллекции с идентичностью ────────────────────────────────────────
// Общий движок для списков по id и для объектов-карт: разница только в том,
// откуда берётся ключ и как собирается результат.
//
// Ключевая асимметрия — «изменение против удаления». Если одна сторона запись
// удалила, а другая изменила, мы ОСТАВЛЯЕМ изменённую. Для финансовых записей
// потерять правку молча хуже, чем показать лишнюю строку: лишнюю человек увидит
// и удалит сам, пропавшую — не заметит.
function mergeEntries(baseMap, mineMap, theirsMap, deletable, path) {
  const ids = new Set([...Object.keys(theirsMap), ...Object.keys(mineMap), ...Object.keys(baseMap)]);
  const out = {};

  for (const id of ids) {
    const inBase = Object.hasOwn(baseMap, id);
    const inMine = Object.hasOwn(mineMap, id);
    const inTheirs = Object.hasOwn(theirsMap, id);
    const b = baseMap[id], m = mineMap[id], t = theirsMap[id];

    if (inMine && inTheirs) {
      out[id] = mergeValue(`${path}.*`, inBase ? b : undefined, m, t);
      continue;
    }
    if (!inMine && !inTheirs) continue;                    // удалили обе стороны

    if (!deletable) { out[id] = inMine ? m : t; continue; } // отсутствие ≠ удаление

    if (inMine) {                                          // сервер удалил
      if (inBase && eq(m, b)) continue;                    // клиент не трогал — удаление в силе
      out[id] = m;                                         // клиент изменил — сохраняем правку
    } else {                                               // клиент удалил
      if (inBase && eq(t, b)) continue;                    // сервер не трогал — удаление в силе
      out[id] = t;
    }
  }
  return out;
}

const byId = (list, key = 'id') => {
  const map = {};
  (Array.isArray(list) ? list : []).forEach((item, i) => {
    // Запись без id сливать не по чему — оставляем её под позиционным ключом,
    // чтобы она хотя бы не исчезла. Так ведут себя только очень старые данные:
    // весь клиентский код создаёт записи через uid() (core.js).
    const k = item && item[key] != null ? String(item[key]) : `#${i}`;
    map[k] = item;
  });
  return map;
};

// Порядок результата: сначала в порядке серверной версии (её видят все
// устройства), затем добавленное клиентом. Для транзакций дополнительно
// восстанавливаем инвариант «новые сверху» — клиент кладёт их через unshift.
function orderedList(merged, mineList, theirsList, rule) {
  const seen = new Set();
  const out = [];
  const push = list => (Array.isArray(list) ? list : []).forEach((item, i) => {
    const k = item && item.id != null ? String(item.id) : `#${i}`;
    if (seen.has(k) || !Object.hasOwn(merged, k)) return;
    seen.add(k);
    out.push(merged[k]);
  });
  push(theirsList);
  push(mineList);
  // Записи, которых нет ни в одном исходном списке, появиться не могут, но
  // страхуемся: ничего не теряем молча.
  Object.keys(merged).forEach(k => { if (!seen.has(k)) out.push(merged[k]); });

  if (rule.sortBy) {
    const ts = x => { const d = Date.parse(x?.[rule.sortBy]); return Number.isNaN(d) ? null : d; };
    if (out.every(x => ts(x) !== null)) out.sort((a, b) => ts(b) - ts(a));
  }
  return out;
}

// ── Слияние одного значения по пути ──────────────────────────────────────────
function mergeValue(path, base, mine, theirs) {
  if (eq(mine, theirs)) return mine;
  if (mine === undefined) return theirs;
  if (theirs === undefined) return mine;

  const rule = ruleFor(path);

  if (rule?.kind === 'idList') {
    const merged = mergeEntries(byId(base), byId(mine), byId(theirs), rule.deletable, path);
    return orderedList(merged, mine, theirs, rule);
  }

  if (rule?.kind === 'keyedMap') {
    return mergeEntries(
      isPlainObject(base) ? base : {},
      isPlainObject(mine) ? mine : {},
      isPlainObject(theirs) ? theirs : {},
      rule.deletable, path);
  }

  if (rule?.kind === 'weekMap') {
    // Карта недель: {'2026-W36': [позиции]}. Сливаем понедельно, внутри недели —
    // по id позиции, без удалений (см. комментарий у RULES).
    const weeks = new Set([
      ...Object.keys(isPlainObject(theirs) ? theirs : {}),
      ...Object.keys(isPlainObject(mine) ? mine : {}),
    ]);
    const out = {};
    for (const wk of weeks) {
      const b = isPlainObject(base) ? base[wk] : undefined;
      const m = isPlainObject(mine) ? mine[wk] : undefined;
      const t = isPlainObject(theirs) ? theirs[wk] : undefined;
      if (m === undefined) { out[wk] = t; continue; }
      if (t === undefined) { out[wk] = m; continue; }
      const merged = mergeEntries(byId(b), byId(m), byId(t), false, `${path}.*`);
      out[wk] = orderedList(merged, m, t, {});
    }
    return out;
  }

  // По умолчанию: объекты сливаем рекурсивно по ключам (так новый вложенный
  // ключ клиента не требует правки этой таблицы и не теряется), всё остальное —
  // скаляры, массивы без объявленной идентичности — обычным трёхсторонним
  // выбором целиком.
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(b)])) {
      const inMine = Object.hasOwn(mine, k), inTheirs = Object.hasOwn(theirs, k);
      if (inMine && inTheirs) { out[k] = mergeValue(path ? `${path}.${k}` : k, b[k], mine[k], theirs[k]); continue; }
      if (!inMine && !inTheirs) continue;
      const inBase = Object.hasOwn(b, k);
      if (inMine) { if (inBase && eq(mine[k], b[k])) continue; out[k] = mine[k]; }
      else { if (inBase && eq(theirs[k], b[k])) continue; out[k] = theirs[k]; }
    }
    return out;
  }

  return pick(base, mine, theirs);
}

/**
 * Сливает входящий снапшот клиента с текущим серверным относительно общей базы.
 *
 * @param {object} base   снапшот, который клиент видел последним (версия baseUpdatedAt)
 * @param {object} mine   что прислал клиент
 * @param {object} theirs что сейчас лежит на сервере
 * @returns {object} слитый снапшот
 */
function mergeStates(base, mine, theirs) {
  if (!isPlainObject(mine)) return isPlainObject(theirs) ? theirs : {};
  if (!isPlainObject(theirs)) return mine;
  return mergeValue('', isPlainObject(base) ? base : {}, mine, theirs);
}

module.exports = { mergeStates, canonical, eq };
