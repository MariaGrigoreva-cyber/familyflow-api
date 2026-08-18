const { sendTelegramMessage, telegramConfigured } = require('../lib/telegram');

const realFetch = global.fetch;
const { TELEGRAM_BOT_TOKEN: origToken, TELEGRAM_CHAT_ID: origChat } = process.env;
afterEach(() => {
  global.fetch = realFetch;
  if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = origToken;
  if (origChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = origChat;
});

describe('telegramConfigured', () => {
  test('без токена/chat id — false', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(telegramConfigured()).toBe(false);
  });

  test('с обеими переменными — true', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    expect(telegramConfigured()).toBe(true);
  });
});

describe('sendTelegramMessage', () => {
  test('без конфигурации — бросает ошибку, fetch не вызывается', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    global.fetch = jest.fn();
    await expect(sendTelegramMessage('привет')).rejects.toThrow('telegram not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('успешная отправка — POST на api.telegram.org с текстом и chat_id', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await sendTelegramMessage('новый отзыв');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-token/sendMessage',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ chat_id: '12345', text: 'новый отзыв' });
  });

  test('Telegram отвечает ok:false — бросает ошибку с описанием', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'chat not found' }),
    });
    await expect(sendTelegramMessage('привет')).rejects.toThrow('chat not found');
  });

  test('HTTP-ошибка — бросает', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(sendTelegramMessage('привет')).rejects.toThrow('telegram: 500');
  });
});
