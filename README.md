# FamilyFlow API · Фаза 0

Аккаунты, облачное хранение бюджета, приглашения в семью.

## Эндпоинты
| Метод | Путь | Что делает |
|---|---|---|
| POST | /auth/register | {email, password, familyName} → token; создаёт семью и пустой state |
| POST | /auth/login | {email, password} → token |
| GET | /family/me | моя семья: имя, роль, invite_code, число участников |
| POST | /family/invite | (owner) генерирует 6-значный код приглашения |
| POST | /family/join | {code} → вступить в семью, вернёт её state |
| GET | /state | снапшот бюджета семьи + updatedAt |
| PUT | /state | {data, baseUpdatedAt} → сохранить; 409 при конфликте |
| GET | /health | проверка живости и БД |

Авторизация: заголовок `Authorization: Bearer <token>`.

## Деплой на Timeweb Cloud

1. **База**: панель → Базы данных → создать PostgreSQL (минимальный тариф).
   Скопируйте строку подключения (DATABASE_URL).
2. **Репозиторий**: создайте на GitHub `familyflow-api`, запушьте эту папку.
3. **Приложение**: панель → App Platform → создать приложение → Node.js →
   репозиторий familyflow-api, ветка main.
   - Build: `npm install`
   - Run: `npm start`
4. **Переменные окружения** приложения:
   - `DATABASE_URL` — из шага 1
   - `JWT_SECRET` — длинная случайная строка (например `openssl rand -hex 32`)
   - `CORS_ORIGIN` — https-адрес фронтенда
5. Деплой. Схема БД применится автоматически при первом старте.
6. Проверка: откройте `https://<api-домен>/health` → `{"ok":true}`.

## Локальный запуск
```bash
cp .env.example .env   # заполнить
npm install
node --env-file=.env server.js
```
