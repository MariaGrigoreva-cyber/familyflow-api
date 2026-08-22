// Повтор с экспоненциальным backoff для операций, где временный сбой (таймаут,
// 5xx, перегрузка) не должен приводить к тем же последствиям, что и постоянный
// отказ (например, невалидный запрос или отклонённая карта). Что считать
// временным сбоем решает вызывающий код через isRetryable — по умолчанию
// повторяется всё, что бросили, это осознанно небезопасный дефолт, чтобы
// заставить вызывающего явно подумать.
async function withRetry(fn, { attempts = 3, baseDelayMs = 500, isRetryable = () => true } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isRetryable(e)) throw e;
      const delay = baseDelayMs * 2 ** i + Math.random() * baseDelayMs;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
