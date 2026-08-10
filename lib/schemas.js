// Zod-схемы тел запросов — раньше проверки были россыпью последовательных if()
// прямо в роутах. Схемы централизуют их в одном месте, но намеренно сохраняют
// тот же порядок проверок и те же коды ошибок (message у каждого issue — это и
// есть `error` в ответе), чтобы не менять контракт для уже существующих клиентов.
// Поля объявлены нестрого типизированными (z.any()/optional) — вся содержательная
// проверка идёт через superRefine с тем же if/else-if, что было раньше: так первым
// (и единственным) issue всегда оказывается нужный код, а не служебное сообщение
// zod о несовпадении типа.
const { z } = require('zod');

const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const registerSchema = z.object({
  email: z.any().optional(),
  password: z.any().optional(),
  familyName: z.any().optional(),
  pdnConsent: z.any().optional(),
  attribution: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email)) return ctx.addIssue({ code: 'custom', message: 'bad_email', path: ['email'] });
  if (!val.password || val.password.length < 6) return ctx.addIssue({ code: 'custom', message: 'short_password', path: ['password'] });
  if (val.pdnConsent !== true) return ctx.addIssue({ code: 'custom', message: 'pdn_consent_required', path: ['pdnConsent'] });
});

const loginSchema = z.object({
  email: z.any().optional(),
  password: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email) || !val.password) ctx.addIssue({ code: 'custom', message: 'bad_credentials', path: ['email'] });
});

const changePasswordSchema = z.object({
  oldPassword: z.any().optional(),
  newPassword: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!val.newPassword || val.newPassword.length < 6) ctx.addIssue({ code: 'custom', message: 'short_password', path: ['newPassword'] });
});

const resetRequestSchema = z.object({
  email: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email)) ctx.addIssue({ code: 'custom', message: 'bad_email', path: ['email'] });
});

const resetConfirmSchema = z.object({
  email: z.any().optional(),
  code: z.any().optional(),
  newPassword: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email) || !val.code) return ctx.addIssue({ code: 'custom', message: 'bad_request', path: ['email'] });
  if (!val.newPassword || val.newPassword.length < 6) return ctx.addIssue({ code: 'custom', message: 'short_password', path: ['newPassword'] });
});

const stateSchema = z.object({
  data: z.any().optional(),
  baseUpdatedAt: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.data !== 'object' || val.data === null) ctx.addIssue({ code: 'custom', message: 'bad_data', path: ['data'] });
});

// code приходит в свободном виде (пробелы, строчные буквы) — нормализуем перед
// проверкой длины, как раньше делал сам роут.
const familyJoinSchema = z.object({
  code: z.any().optional(),
}).transform((val, ctx) => {
  const code = String(val.code || '').trim().toUpperCase();
  if (code.length !== 6) { ctx.addIssue({ code: 'custom', message: 'bad_code', path: ['code'] }); return z.NEVER; }
  return { code };
});

const billingCheckoutSchema = z.object({
  period: z.any().optional(),
  autoChargeConsent: z.any().optional(),
}).superRefine((val, ctx) => {
  if (val.period !== 'monthly' && val.period !== 'yearly') return ctx.addIssue({ code: 'custom', message: 'bad_period', path: ['period'] });
  if (val.autoChargeConsent !== true) return ctx.addIssue({ code: 'custom', message: 'auto_charge_consent_required', path: ['autoChargeConsent'] });
});

const pushSubscribeSchema = z.object({
  endpoint: z.any().optional(),
  keys: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!val.endpoint || !val.keys?.p256dh || !val.keys?.auth) ctx.addIssue({ code: 'custom', message: 'bad_subscription', path: ['endpoint'] });
});

module.exports = {
  registerSchema, loginSchema, changePasswordSchema, resetRequestSchema, resetConfirmSchema,
  stateSchema, familyJoinSchema, billingCheckoutSchema, pushSubscribeSchema,
};
