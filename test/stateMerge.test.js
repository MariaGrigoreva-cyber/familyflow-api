// Юнит-тесты трёхстороннего слияния (lib/stateMerge.js). Без БД и HTTP:
// проверяется только сама алгебра слияния.
//
// Имена веток здесь те же, что в модуле: base — общий предок, mine — то, что
// прислал клиент, theirs — то, что уже лежит на сервере.
const { mergeStates } = require('../lib/stateMerge');

// Компактный конструктор снапшота в том виде, в каком его шлёт клиент.
const snap = appState => ({ consented: true, onboarded: true, appState });

describe('слияние отметок — исходный баг с «остатком на руках»', () => {
  // Сценарий из жалобы: на телефоне отмечена полученная зарплата, на сервере
  // лежит версия без этой отметки. Раньше снапшот десктопа затирал отметку
  // целиком, и доход переставал считаться (core.js → unmarkedPayments).
  test('отметка «зарплата получена» с телефона переживает запись десктопа', () => {
    const base = snap({ payments: {}, streak: 3 });
    const phone = snap({ payments: { 'salary-2026-09-25': { isDone: true } }, streak: 3 });
    const desktop = snap({ payments: {}, streak: 4 });

    const merged = mergeStates(base.appState, phone.appState, desktop.appState);

    expect(merged.payments['salary-2026-09-25']).toEqual({ isDone: true });
    expect(merged.streak).toBe(4); // десктоп менял streak, телефон — нет
  });

  test('два устройства отметили разные платежи — обе отметки на месте', () => {
    const base = { payments: {} };
    const mine = { payments: { a: { isDone: true } } };
    const theirs = { payments: { b: { isDone: true } } };

    expect(mergeStates(base, mine, theirs).payments).toEqual({
      a: { isDone: true }, b: { isDone: true },
    });
  });

  test('снятая отметка не воскресает: явное false побеждает старое true', () => {
    const base = { payments: { a: { isDone: true } } };
    const mine = { payments: { a: { isDone: false } } }; // сняли галочку
    const theirs = { payments: { a: { isDone: true } } }; // сервер не трогал

    expect(mergeStates(base, mine, theirs).payments.a.isDone).toBe(false);
  });
});

describe('weekItems — отметки по неделям', () => {
  test('отметки в одной неделе с разных устройств складываются', () => {
    const base = { weekItems: { '2026-W36': [
      { id: 'p1-2026-W36', isDone: false, amount: 100 },
      { id: 'p2-2026-W36', isDone: false, amount: 200 },
    ] } };
    const mine = { weekItems: { '2026-W36': [
      { id: 'p1-2026-W36', isDone: true, amount: 100 },
      { id: 'p2-2026-W36', isDone: false, amount: 200 },
    ] } };
    const theirs = { weekItems: { '2026-W36': [
      { id: 'p1-2026-W36', isDone: false, amount: 100 },
      { id: 'p2-2026-W36', isDone: true, amount: 200 },
    ] } };

    const items = mergeStates(base, mine, theirs).weekItems['2026-W36'];
    expect(items.find(i => i.id === 'p1-2026-W36').isDone).toBe(true);
    expect(items.find(i => i.id === 'p2-2026-W36').isDone).toBe(true);
  });

  test('неделя, которой нет у одной стороны, не считается удалённой', () => {
    // generateAllWeeks строит скользящее окно в 104 недели: отсутствие недели
    // значит «окно уехало», а не «неделю удалили».
    const base = {};
    const mine = { weekItems: { '2026-W36': [{ id: 'a', isDone: true }] } };
    const theirs = { weekItems: { '2027-W40': [{ id: 'b', isDone: true }] } };

    const merged = mergeStates(base, mine, theirs).weekItems;
    expect(Object.keys(merged).sort()).toEqual(['2026-W36', '2027-W40']);
  });

  test('позиция, пропавшая у одной стороны, сохраняется (regen пересоберёт)', () => {
    const base = { weekItems: { w: [{ id: 'a', isDone: true }] } };
    const mine = { weekItems: { w: [] } };
    const theirs = { weekItems: { w: [{ id: 'a', isDone: true }] } };

    expect(mergeStates(base, mine, theirs).weekItems.w).toEqual([{ id: 'a', isDone: true }]);
  });
});

describe('transactions — объединение и удаления', () => {
  test('записи, добавленные на разных устройствах, складываются', () => {
    const base = { transactions: [{ id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' }] };
    const mine = { transactions: [
      { id: 'm', amount: 50, date: '2026-09-03T00:00:00.000Z' },
      { id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' },
    ] };
    const theirs = { transactions: [
      { id: 't', amount: 70, date: '2026-09-02T00:00:00.000Z' },
      { id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' },
    ] };

    const tx = mergeStates(base, mine, theirs).transactions;
    expect(tx.map(t => t.id)).toEqual(['m', 't', 'x']); // новые сверху, по дате
  });

  test('удалённая на клиенте запись действительно удаляется', () => {
    const base = { transactions: [{ id: 'x', amount: 10 }] };
    const mine = { transactions: [] };                    // удалили
    const theirs = { transactions: [{ id: 'x', amount: 10 }] }; // сервер не трогал

    expect(mergeStates(base, mine, theirs).transactions).toEqual([]);
  });

  test('удаление против правки — правка выигрывает, запись не теряется', () => {
    const base = { transactions: [{ id: 'x', amount: 10 }] };
    const mine = { transactions: [{ id: 'x', amount: 999 }] }; // изменили сумму
    const theirs = { transactions: [] };                        // а там удалили

    expect(mergeStates(base, mine, theirs).transactions).toEqual([{ id: 'x', amount: 999 }]);
  });

  test('запись, удалённая обеими сторонами, не возвращается', () => {
    const base = { transactions: [{ id: 'x', amount: 10 }] };
    expect(mergeStates(base, { transactions: [] }, { transactions: [] }).transactions).toEqual([]);
  });
});

describe('правки настроек', () => {
  test('правка суммы на одной стороне и добавление категории на другой уживаются', () => {
    const base = { planned: [{ id: 'p1', name: 'Ипотека', amount: 50000 }] };
    const mine = { planned: [{ id: 'p1', name: 'Ипотека', amount: 55000 }] };
    const theirs = { planned: [
      { id: 'p1', name: 'Ипотека', amount: 50000 },
      { id: 'p2', name: 'Спорт', amount: 3000 },
    ] };

    const planned = mergeStates(base, mine, theirs).planned;
    expect(planned.find(p => p.id === 'p1').amount).toBe(55000);
    expect(planned.find(p => p.id === 'p2')).toBeTruthy();
  });

  test('конфликт одного поля разрешается в пользу входящей записи', () => {
    const base = { planned: [{ id: 'p1', amount: 100 }] };
    const mine = { planned: [{ id: 'p1', amount: 200 }] };
    const theirs = { planned: [{ id: 'p1', amount: 300 }] };

    expect(mergeStates(base, mine, theirs).planned[0].amount).toBe(200);
  });

  test('разные поля одной записи правились независимо — обе правки на месте', () => {
    const base = { planned: [{ id: 'p1', name: 'Еда', amount: 100 }] };
    const mine = { planned: [{ id: 'p1', name: 'Продукты', amount: 100 }] };
    const theirs = { planned: [{ id: 'p1', name: 'Еда', amount: 150 }] };

    expect(mergeStates(base, mine, theirs).planned[0]).toEqual({
      id: 'p1', name: 'Продукты', amount: 150,
    });
  });
});

describe('устойчивость', () => {
  test('незнакомый серверу ключ не теряется', () => {
    const merged = mergeStates({}, { новоеПоле: { a: 1 } }, { другое: 2 });
    expect(merged).toEqual({ новоеПоле: { a: 1 }, другое: 2 });
  });

  test('порядок ключей не считается изменением', () => {
    const base = { appState: { a: 1, b: 2 } };
    const mine = { appState: { b: 2, a: 1 } };
    const theirs = { appState: { a: 1, b: 2 } };
    expect(mergeStates(base, mine, theirs).appState).toEqual({ a: 1, b: 2 });
  });

  test('пустая база (версия не найдена) не роняет слияние', () => {
    const mine = { transactions: [{ id: 'm', amount: 1 }] };
    const theirs = { transactions: [{ id: 't', amount: 2 }] };
    const tx = mergeStates({}, mine, theirs).transactions;
    expect(tx.map(t => t.id).sort()).toEqual(['m', 't']);
  });

  test('не-объекты на входе не приводят к падению', () => {
    expect(mergeStates(null, null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeStates(null, { a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeStates(null, null, null)).toEqual({});
  });

  test('слияние идемпотентно: повторный прогон ничего не меняет', () => {
    const base = { transactions: [{ id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' }] };
    const mine = { transactions: [
      { id: 'm', amount: 50, date: '2026-09-03T00:00:00.000Z' },
      { id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' },
    ] };
    const theirs = { transactions: [
      { id: 't', amount: 70, date: '2026-09-02T00:00:00.000Z' },
      { id: 'x', amount: 10, date: '2026-09-01T00:00:00.000Z' },
    ] };

    const once = mergeStates(base, mine, theirs);
    expect(mergeStates(base, once, once)).toEqual(once);
  });
});
