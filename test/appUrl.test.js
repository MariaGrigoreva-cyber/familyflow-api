// Публичный адрес веб-приложения (lib/appUrl.js).
//
// Раньше он брался как первый элемент CORS_ORIGIN — списка разрешённых origin.
// Дописать туда новый origin в начало значило увести платёж, письма и токен
// входа через Яндекс ID на чужой адрес, и заметить это было нечем. Теперь
// адрес задаётся своей переменной; здесь закреплено и это, и путь
// совместимости, без которого выкатка сломала бы стенды без новой переменной.
const fs = require('fs');
const path = require('path');
const { appPublicUrl, appPublicUrlConfigured, DEFAULT_APP_URL } = require('../lib/appUrl');

const ENV = ['APP_PUBLIC_URL', 'CORS_ORIGIN'];
const saved = {};
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const withEnv = (env, fn) => {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  return fn();
};

describe('приоритет источников', () => {
  test('APP_PUBLIC_URL важнее CORS_ORIGIN', () => {
    const url = withEnv(
      { APP_PUBLIC_URL: 'https://app.example', CORS_ORIGIN: 'https://other.example,https://localhost' },
      appPublicUrl);
    expect(url).toBe('https://app.example');
  });

  test('порядок в CORS_ORIGIN больше ни на что не влияет', () => {
    // Главное, ради чего всё затевалось: даже если мобильный origin окажется
    // первым, адрес приложения остаётся прежним.
    const url = withEnv(
      { APP_PUBLIC_URL: 'https://app.myfamilyflow.ru', CORS_ORIGIN: 'https://localhost,https://app.myfamilyflow.ru' },
      appPublicUrl);
    expect(url).toBe('https://app.myfamilyflow.ru');
    expect(url).not.toBe('https://localhost');
  });

  test('без своей переменной берётся первый origin — так было раньше', () => {
    const url = withEnv({ CORS_ORIGIN: 'https://app.example,https://localhost' }, appPublicUrl);
    expect(url).toBe('https://app.example');
  });

  test('не задано ничего — адрес приложения, а не лендинга', () => {
    expect(withEnv({}, appPublicUrl)).toBe(DEFAULT_APP_URL);
    expect(DEFAULT_APP_URL).toBe('https://app.myfamilyflow.ru');
  });

  test('звёздочка в CORS_ORIGIN адресом не считается', () => {
    expect(withEnv({ CORS_ORIGIN: '*' }, appPublicUrl)).toBe(DEFAULT_APP_URL);
  });

  test('пустые значения не выигрывают у следующего источника', () => {
    expect(withEnv({ APP_PUBLIC_URL: '', CORS_ORIGIN: 'https://app.example' }, appPublicUrl))
      .toBe('https://app.example');
    expect(withEnv({ APP_PUBLIC_URL: '   ', CORS_ORIGIN: 'https://app.example' }, appPublicUrl))
      .toBe('https://app.example');
  });
});

describe('нормализация', () => {
  test('хвостовой слэш срезается — иначе получится //#yandex_token=', () => {
    // routes/auth.js дописывает к адресу `/#yandex_token=…`.
    expect(withEnv({ APP_PUBLIC_URL: 'https://app.example/' }, appPublicUrl)).toBe('https://app.example');
    expect(withEnv({ APP_PUBLIC_URL: 'https://app.example///' }, appPublicUrl)).toBe('https://app.example');
  });

  test('пробелы по краям срезаются', () => {
    expect(withEnv({ APP_PUBLIC_URL: '  https://app.example  ' }, appPublicUrl)).toBe('https://app.example');
    expect(withEnv({ CORS_ORIGIN: ' https://app.example , https://localhost' }, appPublicUrl))
      .toBe('https://app.example');
  });
});

describe('признак «адрес настроен»', () => {
  // Нужен /auth/verify-email: на ненастроенном стенде оно не редиректит, а
  // показывает страницу подтверждения. Без этого признака отличить настоящее
  // значение от дефолта было бы нечем.
  test('задано явно или через CORS_ORIGIN — настроено', () => {
    expect(withEnv({ APP_PUBLIC_URL: 'https://app.example' }, appPublicUrlConfigured)).toBe(true);
    expect(withEnv({ CORS_ORIGIN: 'https://app.example' }, appPublicUrlConfigured)).toBe(true);
  });

  test('не задано ничего либо только звёздочка — не настроено', () => {
    expect(withEnv({}, appPublicUrlConfigured)).toBe(false);
    expect(withEnv({ CORS_ORIGIN: '*' }, appPublicUrlConfigured)).toBe(false);
    expect(withEnv({ CORS_ORIGIN: '' }, appPublicUrlConfigured)).toBe(false);
  });
});

describe('единственный источник', () => {
  const CONSUMERS = [
    'routes/auth.js',
    'routes/billing.js',
    'lib/onboardingScheduler.js',
    'lib/trialScheduler.js',
  ];

  test('потребители берут адрес из общего модуля', () => {
    for (const file of CONSUMERS) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(src).toMatch(/require\('\.\.?\/(lib\/)?appUrl'\)/);
    }
  });

  test('своих копий разбора CORS_ORIGIN больше нет', () => {
    // Комментарии вырезаем: в них переменная упоминается как объяснение, чем
    // было раньше, и тест иначе падал бы от собственного текста.
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
    });

    const root = path.join(__dirname, '..');
    const offenders = ['lib', 'routes', 'middleware']
      .flatMap(d => walk(path.join(root, d)))
      .filter(f => strip(fs.readFileSync(f, 'utf8')).includes('CORS_ORIGIN'))
      .map(f => path.relative(root, f));

    // Переменную вправе читать только модуль совместимости. server.js сюда не
    // попадает — он лежит в корне, а не в этих каталогах.
    expect(offenders).toEqual(['lib/appUrl.js']);
  });

  test('в примере окружения переменная описана', () => {
    const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    expect(example).toMatch(/^APP_PUBLIC_URL=/m);
  });
});
