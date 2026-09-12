// CORS: кто имеет право обращаться к API из браузера.
//
// Ради чего файл существует. Приложение в RuStore — это тот же веб-код, упакованный
// Capacitor'ом, но WebView отдаёт ему origin `https://localhost`, а не адрес сайта.
// Пока в CORS_ORIGIN был только веб-origin, браузерный fetch из APK блокировался
// ещё до ответа сервера, и пользователь видел лишь «Ошибка сети» — по логам API
// при этом всё выглядело нормально, потому что до обработчика запрос не доходил.
// Диагностируется такое тяжело, а ломается от одной правки переменной окружения.
//
// Второе, что здесь закреплено, — ПОРЯДОК значений. CORS_ORIGIN работает не
// только как список разрешённых origin: пять мест в коде берут его ПЕРВЫЙ
// элемент как публичный адрес приложения (см. тест про порядок ниже).
const fs = require('fs');
const path = require('path');
const request = require('supertest');

// Боевое значение переменной. Тесты ниже опираются на него, чтобы расхождение
// между кодом и продом было видно здесь, а не в приложении у пользователя.
const WEB_ORIGIN = 'https://app.myfamilyflow.ru';
const TIMEWEB_ORIGIN = 'https://mariagrigoreva-cyber-familyflow-8dca.twc1.net';
const ANDROID_ORIGIN = 'https://localhost';
const PRODUCTION_CORS_ORIGIN = [WEB_ORIGIN, TIMEWEB_ORIGIN, ANDROID_ORIGIN].join(',');

// server.js читает CORS_ORIGIN один раз при загрузке модуля, поэтому каждый
// набор origin'ов требует свежего require. Иначе тесты проверяли бы значение,
// выставленное в test/globalSetup.js, а не то, что задано здесь.
// Каждый изолированный require('../server') поднимает и свой пул соединений к
// БД (db.js). Пул держит сокет открытым, и без явного закрытия jest после
// прогона не завершается. Собираем пулы и гасим их в afterAll.
//
// Экземпляры кешируем по строке origin'ов: набор конфигураций здесь небольшой,
// а поднимать сервер заново на каждую проверку — это лишние пулы и слушатели
// process (node начинает ругаться на их количество).
const pools = [];
const apps = new Map();

function appWithOrigins(corsOrigin) {
  if (apps.has(corsOrigin)) return apps.get(corsOrigin);
  let app;
  jest.isolateModules(() => {
    const saved = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = corsOrigin;
    // Пустая переменная — штатный сценарий одного из тестов; сервер честно
    // пишет об этом в лог, и в выводе прогона это только шум.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      app = require('../server');
      pools.push(require('../db'));
    } finally {
      quiet.mockRestore();
      if (saved === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = saved;
    }
  });
  apps.set(corsOrigin, app);
  return app;
}

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end().catch(() => {})));
});

const prodApp = () => appWithOrigins(PRODUCTION_CORS_ORIGIN);

// Браузер пускает ответ к JS только если сервер назвал origin в заголовке.
// Пакет cors на неразрешённый origin не отвечает ошибкой — он просто не ставит
// заголовок, и запрос блокирует уже браузер. Поэтому проверяем именно заголовок,
// а не код ответа.
const allowOrigin = res => res.headers['access-control-allow-origin'];

describe('разрешённые origin', () => {
  test('веб-приложение', async () => {
    const res = await request(prodApp()).get('/health').set('Origin', WEB_ORIGIN);
    expect(allowOrigin(res)).toBe(WEB_ORIGIN);
  });

  test('веб-приложение на домене Timeweb', async () => {
    const res = await request(prodApp()).get('/health').set('Origin', TIMEWEB_ORIGIN);
    expect(allowOrigin(res)).toBe(TIMEWEB_ORIGIN);
  });

  test('Android-приложение из RuStore — origin WebView, а не адрес сайта', async () => {
    // Именно этот случай и ломался: Capacitor отдаёт встроенным файлам
    // https://localhost, поэтому APK выглядит для API как чужой сайт.
    const res = await request(prodApp()).get('/health').set('Origin', ANDROID_ORIGIN);
    expect(allowOrigin(res)).toBe(ANDROID_ORIGIN);
  });
});

describe('посторонние origin отклоняются', () => {
  test('незнакомый сайт заголовка не получает', async () => {
    const res = await request(prodApp()).get('/health').set('Origin', 'https://evil.example');
    expect(allowOrigin(res)).toBeUndefined();
  });

  test('похожий домен не проходит — сравнение точное, а не по подстроке', async () => {
    for (const origin of [
      'https://app.myfamilyflow.ru.evil.example',   // наш адрес как префикс чужого
      'https://evil.example/app.myfamilyflow.ru',
      'http://app.myfamilyflow.ru',                 // та же строка, но без TLS
      'https://localhost:8080',                     // localhost, но с портом
      'http://localhost',                           // localhost без TLS
      'capacitor://localhost',                      // другая схема Capacitor
    ]) {
      const res = await request(prodApp()).get('/health').set('Origin', origin);
      expect(allowOrigin(res)).toBeUndefined();
    }
  });

  test('звёздочка не выдаётся никогда', async () => {
    for (const origin of [WEB_ORIGIN, ANDROID_ORIGIN, 'https://evil.example']) {
      const res = await request(prodApp()).get('/health').set('Origin', origin);
      expect(allowOrigin(res)).not.toBe('*');
    }
  });
});

describe('предварительный запрос OPTIONS', () => {
  // Браузер шлёт его перед POST/PUT с JSON и перед любым запросом с
  // Authorization. Если preflight не разрешён, основной запрос не уходит вовсе —
  // ровно так и выглядел сломанный вход в APK.
  const preflight = (app, { method, path, origin, headers }) =>
    request(app).options(path)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', headers);

  test('POST /auth/login проходит preflight со всех трёх origin', async () => {
    for (const origin of [WEB_ORIGIN, TIMEWEB_ORIGIN, ANDROID_ORIGIN]) {
      const res = await preflight(prodApp(), {
        method: 'POST', path: '/auth/login', origin, headers: 'content-type',
      });
      expect(res.status).toBeLessThan(400);
      expect(allowOrigin(res)).toBe(origin);
      expect(String(res.headers['access-control-allow-methods'] || '')).toContain('POST');
    }
  });

  test('запрос с Authorization разрешён — иначе не работает ни один личный экран', async () => {
    for (const origin of [WEB_ORIGIN, ANDROID_ORIGIN]) {
      const res = await preflight(prodApp(), {
        method: 'GET', path: '/billing/status', origin, headers: 'authorization',
      });
      expect(res.status).toBeLessThan(400);
      expect(allowOrigin(res)).toBe(origin);
      expect(String(res.headers['access-control-allow-headers'] || '').toLowerCase())
        .toContain('authorization');
    }
  });

  test('PUT /state проходит preflight — это сохранение бюджета', async () => {
    for (const origin of [WEB_ORIGIN, ANDROID_ORIGIN]) {
      const res = await preflight(prodApp(), {
        method: 'PUT', path: '/state', origin, headers: 'authorization,content-type',
      });
      expect(res.status).toBeLessThan(400);
      expect(allowOrigin(res)).toBe(origin);
      expect(String(res.headers['access-control-allow-methods'] || '')).toContain('PUT');
    }
  });

  test('preflight с чужого origin разрешения не получает', async () => {
    const res = await preflight(prodApp(), {
      method: 'POST', path: '/auth/login', origin: 'https://evil.example', headers: 'content-type',
    });
    expect(allowOrigin(res)).toBeUndefined();
  });
});

describe('разбор переменной окружения', () => {
  test('список делится по запятой и терпит пробелы вокруг значений', async () => {
    const app = appWithOrigins(` ${WEB_ORIGIN} , ${ANDROID_ORIGIN} `);
    for (const origin of [WEB_ORIGIN, ANDROID_ORIGIN]) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(allowOrigin(res)).toBe(origin);
    }
  });

  test('пустая переменная не превращается в «разрешить всем»', async () => {
    const res = await request(appWithOrigins('')).get('/health').set('Origin', WEB_ORIGIN);
    expect(allowOrigin(res)).toBeUndefined();
  });

  test('лишние запятые не создают пустой origin, разрешающий что попало', async () => {
    const app = appWithOrigins(`${WEB_ORIGIN},,`);
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(allowOrigin(res)).toBeUndefined();
  });
});

describe('пример окружения не расходится с реальностью', () => {
  // Сюда смотрят при переносе окружения на новый хостинг и при первой
  // настройке. Раньше в примере был ровно один origin — Timeweb, — и развернув
  // окружение по нему, вход в приложении из RuStore сломали бы снова, а письма
  // и возврат из оплаты повели бы человека не на веб-приложение.
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const line = example.split('\n').find(l => l.startsWith('CORS_ORIGIN='));

  test('строка CORS_ORIGIN в примере есть', () => {
    expect(line).toBeDefined();
  });

  test('перечислены все три origin, включая мобильный', () => {
    const value = line.slice('CORS_ORIGIN='.length);
    expect(value.split(',').map(s => s.trim())).toEqual([
      WEB_ORIGIN, TIMEWEB_ORIGIN, ANDROID_ORIGIN,
    ]);
  });

  test('объяснено, что https://localhost — это приложение из магазина, а не разработка', () => {
    expect(example).toMatch(/localhost[\s\S]{0,400}RuStore/);
  });
});

describe('порядок значений больше ничего не решает', () => {
  // Так было раньше: CORS_ORIGIN служил и списком origin, и — первым элементом —
  // публичным адресом приложения. Дописать новый origin в начало значило увести
  // туда платёж, письма и токен входа через Яндекс ID. Адрес вынесен в
  // APP_PUBLIC_URL (lib/appUrl.js), и здесь закреплено, что связи больше нет.
  const appUrlPath = path.join(__dirname, '..', 'lib', 'appUrl.js');

  test('перестановка origin не меняет адрес приложения', () => {
    const saved = [process.env.APP_PUBLIC_URL, process.env.CORS_ORIGIN];
    try {
      process.env.APP_PUBLIC_URL = WEB_ORIGIN;
      const { appPublicUrl } = require('../lib/appUrl');
      process.env.CORS_ORIGIN = [ANDROID_ORIGIN, WEB_ORIGIN].join(',');
      expect(appPublicUrl()).toBe(WEB_ORIGIN);
      process.env.CORS_ORIGIN = [WEB_ORIGIN, ANDROID_ORIGIN].join(',');
      expect(appPublicUrl()).toBe(WEB_ORIGIN);
    } finally {
      for (const [i, k] of ['APP_PUBLIC_URL', 'CORS_ORIGIN'].entries()) {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      }
    }
  });

  test('первый элемент читает только модуль совместимости', () => {
    // Он нужен, пока APP_PUBLIC_URL выставлена не на всех стендах: без него
    // выкатка молча сломала бы ссылки в письмах и возврат из оплаты.
    expect(fs.readFileSync(appUrlPath, 'utf8')).toMatch(/split\(','\)\[0\]/);
  });

  test('рекомендованный порядок в примере окружения сохранён', () => {
    // Для самого CORS порядок безразличен, но адрес приложения первым — это
    // ещё и подстраховка для стендов, где APP_PUBLIC_URL не выставили.
    const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    const line = example.split('\n').find(l => l.startsWith('CORS_ORIGIN='));
    expect(line.slice('CORS_ORIGIN='.length).split(',')[0].trim()).toBe(WEB_ORIGIN);
  });
});
