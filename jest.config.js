module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/globalSetup.js',
  // Тесты делят одну тестовую БД — не запускаем файлы параллельно, чтобы
  // resetDb() одного файла не сносил данные, на которых в этот момент
  // работает другой.
  maxWorkers: 1,
  testTimeout: 15000,
};
