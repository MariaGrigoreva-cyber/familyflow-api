// Единая точка валидации тела запроса по zod-схеме (см. lib/schemas.js).
// Схемы сами кодируют коды ошибок через message у каждой проверки — так формат
// ответа (`{error: 'bad_email'}` и т.п.) не меняется для существующих клиентов,
// а порядок проверок в schema.superRefine() воспроизводит прежний порядок
// последовательных if() в роутах (первая же проблема — тот же код, что раньше).
module.exports = schema => (req, res, next) => {
  const result = schema.safeParse(req.body || {});
  if (!result.success) {
    const code = result.error.issues[0]?.message || 'bad_request';
    return res.status(400).json({ error: code });
  }
  req.body = result.data;
  next();
};
