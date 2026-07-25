// Шифрование бюджетных данных семьи перед хранением в БД (AES-256-GCM).
// Ключ живёт только в переменной окружения — на сервере он расшифровывается
// (без этого нельзя было бы читать данные семьи для расчётов/писем/пуш-планировщика),
// но в самой базе данных всегда лежит только шифротекст, а не JSON бюджета.
//
// DATA_ENC_KEY — 32 байта в hex (64 символа). Сгенерировать: node -e
// "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// ВАЖНО: потеря этого ключа делает все сохранённые бюджеты нечитаемыми навсегда —
// храните резервную копию переменной отдельно от сервера (например, в менеджере паролей).
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.DATA_ENC_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('DATA_ENC_KEY должен быть 32 байта в hex (64 символа)');
  return key;
}

const configured = () => !!getKey();

// Возвращает Buffer: [iv(12)][authTag(16)][ciphertext] — удобно хранить одним bytea.
function encryptJSON(obj) {
  const key = getKey();
  if (!key) throw new Error('DATA_ENC_KEY не задан — шифрование недоступно');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decryptJSON(buf) {
  const key = getKey();
  if (!key) throw new Error('DATA_ENC_KEY не задан — расшифровка недоступна');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptJSON, decryptJSON, configured };
