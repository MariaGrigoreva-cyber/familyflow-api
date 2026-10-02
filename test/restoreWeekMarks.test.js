// Восстановление недельных отметок из истории версий: возвращаются только
// пропавшие недели, всё остальное в текущем состоянии остаётся нетронутым.
const { markedWeeks, weeksToRestore, restoreWeeks, pickSource } = require('../scripts/restore-week-marks');

const item = (id, catId, amount, extra = {}) => ({ id, plannedId: id.split('-')[0], catId, name: catId, amount, isDone: true, ...extra });

// Версия до поломки: отметки за прошлые недели на месте.
const before = {
  consented: true, onboarded: true,
  appState: {
    incomes: [{ id: 'i1', gross: 371000 }],
    weekItems: {
      '2026-W33': [item('a-2026-W33', 'food', 20000)],
      '2026-W36': [item('p-2026-W36', 'piggy', 30000), item('a-2026-W36', 'food', 15000)],
      '2026-W40': [item('a-2026-W40', 'food', 20000, { isDone: false })],
    },
  },
};
// После: сохранение дохода стёрло прошлые недели, в текущей появилась отметка.
const after = {
  consented: true, onboarded: true,
  appState: {
    incomes: [{ id: 'i1', gross: 1 }],
    weekItems: { '2026-W40': [item('a-2026-W40', 'food', 20000)] },
  },
};

test('markedWeeks считает расходы и копилку отдельно и пропускает недели без отметок', () => {
  expect(markedWeeks(before)).toEqual({
    '2026-W33': { spent: 20000, piggy: 0, items: 1 },
    '2026-W36': { spent: 15000, piggy: 30000, items: 2 },
  });
});

test('возвращаются только недели, которых сейчас нет', () => {
  expect(weeksToRestore(after, before)).toEqual(['2026-W33', '2026-W36']);
  const { data, weeks } = restoreWeeks(after, before);
  expect(weeks).toEqual(['2026-W33', '2026-W36']);
  expect(data.appState.weekItems['2026-W33']).toEqual(before.appState.weekItems['2026-W33']);
  expect(data.appState.weekItems['2026-W36']).toEqual(before.appState.weekItems['2026-W36']);
});

test('существующая неделя и остальной бюджет не откатываются к старой версии', () => {
  const { data } = restoreWeeks(after, before);
  expect(data.appState.weekItems['2026-W40']).toEqual(after.appState.weekItems['2026-W40']);
  expect(data.appState.incomes).toEqual(after.appState.incomes);
  expect(data.consented).toBe(true);
});

test('исходные объекты не мутируются', () => {
  const snapshot = JSON.stringify(after);
  restoreWeeks(after, before);
  expect(JSON.stringify(after)).toBe(snapshot);
});

test('повторный запуск ничего не меняет', () => {
  const { data } = restoreWeeks(after, before);
  const again = restoreWeeks(data, before);
  expect(again.weeks).toEqual([]);
  expect(again.data).toBe(data);
});

test('легаси-снапшот (appState в корне) тоже восстанавливается', () => {
  const { data, weeks } = restoreWeeks(after.appState, before.appState);
  expect(weeks).toHaveLength(2);
  expect(data.weekItems['2026-W36']).toHaveLength(2);
  expect(data.appState).toBeUndefined();
});

test('pickSource берёт версию, из которой вернётся больше недель, а при равенстве — самую свежую', () => {
  const partial = { appState: { weekItems: { '2026-W36': before.appState.weekItems['2026-W36'] } } };
  const versions = [
    { updatedAt: new Date('2026-10-02T09:00:00Z'), data: after },   // уже сломанная
    { updatedAt: new Date('2026-10-02T08:00:00Z'), data: before },
    { updatedAt: new Date('2026-10-01T08:00:00Z'), data: before },
    { updatedAt: new Date('2026-09-30T08:00:00Z'), data: partial },
  ];
  expect(pickSource(after, versions).updatedAt.toISOString()).toBe('2026-10-02T08:00:00.000Z');
  expect(pickSource(after, [versions[0]])).toBeNull();
});
