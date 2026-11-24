'use strict';

require('dotenv').config();
const express = require('express');
const path = require('node:path');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { Telegraf, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Render Environment: ${name} is missing`);
  return value;
}

const TOKEN = required('BOT_TOKEN').trim();
required('DATABASE_URL');
const ADMIN_PASSWORD = required('ADMIN_PASSWORD');
if (ADMIN_PASSWORD.length < 16) {
  throw new Error('ADMIN_PASSWORD must contain at least 16 characters');
}

const site = new URL(required('RENDER_EXTERNAL_URL'));
if (site.protocol !== 'https:') throw new Error('HTTPS URL required');
const BASE = site.origin;
const PORT = Number(process.env.PORT || 10000);
const HOOK = '/telegram/webhook';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const webAppKey = hmac('WebAppData', TOKEN);
const hookSecret = hmac(TOKEN, 'pizza-bot/webhook/v1').toString('hex');
const adminHeader = 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64');

const db = new PrismaClient();
const bot = new Telegraf(TOKEN);
const app = express();
const page = name => path.join(__dirname, 'public', name);

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '128kb' }));

const route = fn => (req, res, next) =>
  Promise.resolve().then(() => fn(req, res)).catch(next);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { publicStatus: status });
}

function same(a, b) {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}

function text(value, min, max, label) {
  if (typeof value !== 'string') fail(`${label}: noto‘g‘ri qiymat.`);
  const s = value.trim();
  if (s.length < min || s.length > max) fail(`${label}: uzunligini tekshiring.`);
  return s;
}

function integer(value, min, max, label) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(`${label}: sonni tekshiring.`);
  }
  return n;
}

const idOf = value => integer(value, 1, 2147483647, 'ID');
const statuses = ['kutilmoqda', 'tayyorlanmoqda', 'yetkazildi'];

// Telegram Mini App: mijozning shaxsini serverda tekshirish.
function telegramOnly(req, res, next) {
  const deny = () => res.status(401).json({
    error: 'Mini App’ni Telegram bot ichidan qayta oching.'
  });

  try {
    const raw = req.get('X-Telegram-Init-Data');
    if (!raw || raw.length > 10000) return deny();

    const params = new URLSearchParams(raw);
    if (new Set(params.keys()).size !== Array.from(params).length) return deny();

    const hash = params.get('hash') || '';
    if (!/^[a-f0-9]{64}$/i.test(hash)) return deny();
    params.delete('hash');
    params.sort();

    const check = Array.from(params, ([k, v]) => `${k}=${v}`).join('\n');
    if (!timingSafeEqual(hmac(webAppKey, check), Buffer.from(hash, 'hex'))) {
      return deny();
    }

    const time = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(time) || time < now - 3600 || time > now + 30) {
      return deny();
    }

    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return deny();
    req.tgUser = user;
  } catch {
    return deny();
  }
  next();
}

// Admin sahifasi ham, admin API ham parol bilan himoyalangan.
function adminOnly(req, res, next) {
  res.set('X-Frame-Options', 'DENY');
  if (!same(req.get('Authorization'), adminHeader)) {
    res.set('WWW-Authenticate', 'Basic realm="Pizza Admin", charset="UTF-8"');
    return res.status(401).send('Admin login required.');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('Origin');
    if ((origin && origin !== BASE) || req.get('Sec-Fetch-Site') === 'cross-site') {
      return res.sendStatus(403);
    }
  }
  next();
}
app.use(['/admin', '/admin.html', '/api/admin'], adminOnly);

function saveUser(client, tg, extra = {}) {
  const telegramId = BigInt(tg.id);
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 120) || 'Mijoz';
  return client.user.upsert({
    where: { telegramId },
    create: { telegramId, name, ...extra },
    update: { name, ...extra }
  });
}

// Bot tillari. Yangi foydalanuvchining asosiy tili — o‘zbekcha.
const words = {
  uz: {
    hello: 'Assalomu alaykum! Qaysi pizzani tanlaysiz? 🍕',
    open: 'Pizzalarni tanlash 🍕', lang: '🌐 Tilni o‘zgartirish', pick: 'Tilni tanlang:',
    ok: "Buyurtmangiz muvaffaqiyatli qabul qilindi! Kuryerimiz tez orada bog'lanadi 🍕"
  },
  ug: {
    hello: 'ئەسسالامۇ ئەلەيكۇم! قايسى پىتسانى تاللايسىز؟ 🍕',
    open: 'پىتسا تاللاش 🍕', lang: '🌐 تىل ئالماشتۇرۇش', pick: 'تىلنى تاللاڭ:',
    ok: 'زاكازىڭىز قوبۇل قىلىندى! يەتكۈزگۈچىمىز پات ئارىدا سىز بىلەن ئالاقىلىشىدۇ 🍕'
  },
  ru: {
    hello: 'Здравствуйте! Какую пиццу вы хотите заказать? 🍕',
    open: 'Выбрать пиццу 🍕', lang: '🌐 Сменить язык', pick: 'Выберите язык:',
    ok: 'Ваш заказ принят! Наш курьер скоро свяжется с вами 🍕'
  },
  en: {
    hello: 'Welcome! Which pizza would you like to order? 🍕',
    open: 'Choose a pizza 🍕', lang: '🌐 Change language', pick: 'Choose your language:',
    ok: 'Your order has been accepted! Our courier will contact you soon 🍕'
  }
};
const tr = lang => Object.hasOwn(words, lang) ? words[lang] : words.uz;

const languages = Markup.inlineKeyboard([
  [Markup.button.callback('O‘zbekcha', 'set_lang_uz'),
   Markup.button.callback('ئۇيغۇرچە', 'set_lang_ug')],
  [Markup.button.callback('Русский', 'set_lang_ru'),
   Markup.button.callback('English', 'set_lang_en')]
]);

async function welcome(ctx, lang) {
  const user = await saveUser(db, ctx.from, lang ? { language: lang } : {});
  const t = tr(user.language);
  return ctx.reply(t.hello, Markup.inlineKeyboard([
    [Markup.button.webApp(t.open, BASE + '/')],
    [Markup.button.callback(t.lang, 'choose_lang')]
  ]));
}

async function chooseLanguage(ctx) {
  const user = await saveUser(db, ctx.from);
  return ctx.reply(tr(user.language).pick, languages);
}

bot.use((ctx, next) => ctx.chat?.type === 'private' ? next() : undefined);
bot.start(ctx => welcome(ctx));
bot.command('language', chooseLanguage);
bot.action('choose_lang', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  return chooseLanguage(ctx);
});
bot.action(/^set_lang_(uz|ug|ru|en)$/, async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  return welcome(ctx, ctx.match[1]);
});
bot.catch(err => { throw err; });

app.post(HOOK, route(async (req, res) => {
  if (!same(req.get('X-Telegram-Bot-Api-Secret-Token'), hookSecret)) {
    return res.sendStatus(403);
  }
  if (!Number.isSafeInteger(req.body?.update_id)) return res.sendStatus(400);
  await bot.handleUpdate(req.body);
  res.sendStatus(200);
}));

// Katalog bo‘sh bo‘lsa, to‘rtta pizza qo‘shiladi. Bor mahsulotlar o‘chirilmaydi.
const seedRows = [
  ['Margarita', '1574071318508-1cdbab80d002', 'Pomidor, mozzarella va yangi bazilik.',
    ['Mozzarella', 'Pomidor sousi', 'Bazilik'], 65000, 55000, 'Klassik'],
  ['Peperoni', '1628840042765-356cda07504e', 'Peperoni kolbasali, biroz achchiq pizza.',
    ['Peperoni', 'Mozzarella', 'Pomidor sousi'], 75000, 65000, 'Go‘shtli'],
  ['Qazi pizza', '1513104890138-7c749659a591', 'Qazi va qizil piyozli milliy pizza.',
    ['Qazi', 'Qizil piyoz', 'Mozzarella'], 95000, 85000, 'Milliy'],
  ['Pishloqli', '1548369937-47519962c11a', 'To‘rt xil pishloqli pizza.',
    ['Mozzarella', 'Parmezan', 'Cheddar', 'Dorblu'], 80000, 70000, 'Pishloqli']
].map(([name, photo, description, ingredients, oldPrice, newPrice, category]) => ({
  name, description, ingredients, oldPrice, newPrice, category,
  imageUrl: `https://images.unsplash.com/photo-${photo}?auto=format&fit=crop&w=720&q=80`
}));

async function seed() {
  try {
    await db.$transaction(async tx => {
      if (await tx.product.count() === 0) {
        await tx.product.createMany({ data: seedRows });
      }
    }, { isolationLevel: 'Serializable', timeout: 15000 });
  } catch (e) {
    if (e.code !== 'P2034' || await db.product.count() === 0) throw e;
  }
}

function productInput(b) {
  const name = text(b.name, 1, 100, 'Nomi');
  const description = text(b.description, 1, 1200, 'Ta’rif');
  const category = text(b.category, 1, 60, 'Kategoriya');
  const imageUrl = text(b.imageUrl, 1, 2000, 'Rasm URL');
  let url;
  try { url = new URL(imageUrl); } catch { fail('Rasm URL noto‘g‘ri.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('Rasm uchun HTTPS havola kiriting.');
  }

  const list = typeof b.ingredients === 'string'
    ? b.ingredients.split(',').map(s => s.trim()).filter(Boolean)
    : b.ingredients;
  if (!Array.isArray(list) || !list.length || list.length > 40) {
    fail('Tarkibni kiriting.');
  }

  const ingredients = list.map(s => text(s, 1, 100, 'Tarkib'));
  const newPrice = integer(b.newPrice, 1, 100000000, 'Yangi narx');
  const oldPrice = integer(b.oldPrice, newPrice, 100000000, 'Eski narx');
  return { name, description, category, imageUrl, ingredients, newPrice, oldPrice };
}

function orderView(o) {
  const snapshot = Array.isArray(o.items) ? {} : (o.items || {});
  return {
    id: o.id,
    items: Array.isArray(o.items) ? o.items : (snapshot.lines || []),
    totalAmount: o.totalAmount, location: o.location,
    status: o.status, createdAt: o.createdAt,
    user: {
      name: snapshot.name ?? o.user?.name ?? '',
      phone: snapshot.phone ?? o.user?.phone ?? ''
    }
  };
}

app.get(['/api/products', '/api/admin/products'], route(async (_req, res) => {
  res.json(await db.product.findMany({ orderBy: { id: 'asc' } }));
}));

app.get('/api/me', telegramOnly, route(async (req, res) => {
  const u = await saveUser(db, req.tgUser);
  const orders = await db.order.findMany({
    where: { userId: u.id }, orderBy: { createdAt: 'desc' }
  });
  res.json({
    telegramId: String(u.telegramId), name: u.name, phone: u.phone,
    language: u.language, orders: orders.map(orderView)
  });
}));

app.post('/api/orders', telegramOnly, route(async (req, res) => {
  const b = req.body || {};
  const phone = text(b.phone, 7, 32, 'Telefon').replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phone)) fail('Telefon raqamini tekshiring.');
  const location = text(b.location, 4, 500, 'Yetkazish manzili');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) {
    fail('Savatchani tekshiring.');
  }
  if (b.addCola !== undefined && typeof b.addCola !== 'boolean') {
    fail('Kola tanlovini tekshiring.');
  }

  const picks = b.items.map(i => ({
    id: idOf(i?.id), qty: integer(i?.qty, 1, 50, 'Soni')
  }));
  const ids = picks.map(i => i.id);
  if (new Set(ids).size !== ids.length) fail('Mahsulot ikki marta yuborilgan.');

  const requestId = b.requestId == null ? null : text(b.requestId, 8, 80, 'Buyurtma kaliti');

  const result = await db.$transaction(async tx => {
    const u = await saveUser(tx, req.tgUser, { phone });
    if (requestId) {
      const existing = await tx.order.findFirst({
        where: { userId: u.id, items: { path: ['requestId'], equals: requestId } }
      });
      if (existing) return { order: existing, lang: u.language, fresh: false };
    }

    const products = await tx.product.findMany({ where: { id: { in: ids } } });
    const byId = new Map(products.map(p => [p.id, p]));
    const lines = picks.map(({ id, qty }) => {
      const p = byId.get(id);
      if (!p) fail('Mahsulot mavjud emas. Katalogni yangilang.', 409);
      return { id, name: p.name, newPrice: p.newPrice, qty };
    });
    if (b.addCola) {
      lines.push({ id: null, kind: 'cola', name: 'Kola 0.5 L', newPrice: 5000, qty: 1 });
    }

    const totalAmount = lines.reduce((sum, i) => sum + i.newPrice * i.qty, 0);
    if (b.totalAmount != null && Number(b.totalAmount) !== totalAmount) {
      fail('Narx o‘zgargan. Katalogni yangilang.', 409);
    }

    const order = await tx.order.create({
      data: {
        userId: u.id, location, totalAmount, status: 'kutilmoqda',
        items: { lines, name: u.name, phone, requestId }
      }
    });
    return { order, lang: u.language, fresh: true };
  }, { maxWait: 10000, timeout: 15000 });

  res.status(result.fresh ? 201 : 200).json({ success: true, order: orderView(result.order) });
  if (result.fresh) {
    bot.telegram.sendMessage(String(req.tgUser.id), tr(result.lang).ok)
      .catch(() => console.warn('Order saved; Telegram confirmation was not delivered.'));
  }
}));

app.get('/api/admin/orders', route(async (_req, res) => {
  const orders = await db.order.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, phone: true } } }
  });
  res.json(orders.map(orderView));
}));

app.patch('/api/admin/orders/:id/status', route(async (req, res) => {
  const status = req.body?.status;
  if (!statuses.includes(status)) fail('Buyurtma holati noto‘g‘ri.');
  const order = await db.order.update({
    where: { id: idOf(req.params.id) }, data: { status }
  });
  res.json({ id: order.id, status: order.status });
}));

app.post('/api/admin/products', route(async (req, res) => {
  const data = productInput(req.body || {});
  res.status(201).json(await db.product.create({ data }));
}));

app.put('/api/admin/products/:id', route(async (req, res) => {
  const data = productInput(req.body || {});
  res.json(await db.product.update({ where: { id: idOf(req.params.id) }, data }));
}));

app.delete('/api/admin/products/:id', route(async (req, res) => {
  await db.product.delete({ where: { id: idOf(req.params.id) } });
  res.json({ success: true });
}));

app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.get(['/', '/index.html'], (_req, res) => res.sendFile(page('index.html')));
app.get(['/admin', '/admin.html'], (_req, res) => res.sendFile(page('admin.html')));
app.use((_req, res) => res.sendStatus(404));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.publicStatus) return res.status(err.publicStatus).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON noto‘g‘ri.' });
  if (err.type === 'entity.too.large') return res.sendStatus(413);
  if (err.code === 'P2025' || err.status === 404) {
    return res.status(404).json({ error: 'Topilmadi.' });
  }
  console.error('Request failed:', err.code || err.name);
  res.status(500).json({ error: 'Server xatosi. Keyinroq qayta urinib ko‘ring.' });
});

let server;

async function start() {
  await db.$connect();
  await seed();

  await new Promise((resolve, reject) => {
    server = app.listen(PORT, '0.0.0.0', resolve);
    server.once('error', reject);
  });

  await bot.telegram.setWebhook(BASE + HOOK, {
    secret_token: hookSecret,
    allowed_updates: ['message', 'callback_query']
  });
  console.log('Pizza bot and web service are ready.');
}

process.once('SIGTERM', () => {
  if (server) server.close(() => db.$disconnect().finally(() => process.exit(0)));
  else db.$disconnect().finally(() => process.exit(0));
});

start().catch(err => {
  console.error('Startup failed. Check Render Environment and build logs:', err.code || err.name);
  process.exit(1);
});
