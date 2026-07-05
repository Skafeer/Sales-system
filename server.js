/* ============================================================
   سيرفر نظام إدارة المبيعات - ورشة أبو أحمد للدراجات الهوائية
   Node.js + Express + PostgreSQL (مصمم للنشر على Railway)
   ============================================================ */

const express = require('express');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

/* ------------------------------------------------------------
   الاتصال بقاعدة البيانات
   Railway يوفر متغير DATABASE_URL تلقائياً عند ربط خدمة Postgres
   ------------------------------------------------------------ */
if (!process.env.DATABASE_URL) {
  console.warn('تحذير: متغير DATABASE_URL غير موجود. أضف قاعدة بيانات PostgreSQL في Railway وربطها بهذا السيرفر.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sale_price INTEGER NOT NULL,
      cost_price INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      sale_price INTEGER NOT NULL,
      cost_price INTEGER NOT NULL,
      profit INTEGER NOT NULL,
      sale_date TEXT NOT NULL,
      sale_time TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (sale_date);`);
}

/* ------------------------------------------------------------
   حماية النظام: النظام خاص بالمتجر وليس عاماً.
   إذا حددت APP_USER و APP_PASSWORD في متغيرات البيئة على Railway
   سيُطلب اسم مستخدم وكلمة مرور لفتح النظام من أي متصفح.
   إذا لم تحددهما، يبقى النظام بدون حماية (غير مستحسن للاستخدام الفعلي).
   ------------------------------------------------------------ */
if (process.env.APP_USER && process.env.APP_PASSWORD) {
  app.use(basicAuth({
    users: { [process.env.APP_USER]: process.env.APP_PASSWORD },
    challenge: true,
    realm: 'ورشة أبو أحمد'
  }));
} else {
  console.warn('تحذير: النظام مفتوح بدون حماية. أضف APP_USER و APP_PASSWORD في متغيرات البيئة لحمايته.');
}

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------
   المنتجات
   ------------------------------------------------------------ */
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY name ASC');
    res.json(rows.map(r => ({ id: r.id, name: r.name, salePrice: r.sale_price, costPrice: r.cost_price })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل تحميل المنتجات' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, salePrice, costPrice } = req.body;
    if (!name || !salePrice || !costPrice) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    const { rows } = await pool.query(
      'INSERT INTO products (name, sale_price, cost_price) VALUES ($1,$2,$3) RETURNING *',
      [name, salePrice, costPrice]
    );
    const r = rows[0];
    res.json({ id: r.id, name: r.name, salePrice: r.sale_price, costPrice: r.cost_price });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل حفظ المنتج' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل حذف المنتج' });
  }
});

/* ------------------------------------------------------------
   المبيعات
   ------------------------------------------------------------ */
function mapSale(r) {
  return {
    id: r.id,
    productId: r.product_id,
    productName: r.product_name,
    salePrice: r.sale_price,
    costPrice: r.cost_price,
    profit: r.profit,
    date: r.sale_date,
    time: r.sale_time,
    timestamp: r.created_at
  };
}

app.get('/api/sales', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    let rows;
    if (date) {
      ({ rows } = await pool.query('SELECT * FROM sales WHERE sale_date=$1 ORDER BY created_at ASC', [date]));
    } else if (from && to) {
      ({ rows } = await pool.query('SELECT * FROM sales WHERE sale_date BETWEEN $1 AND $2 ORDER BY created_at ASC', [from, to]));
    } else {
      ({ rows } = await pool.query('SELECT * FROM sales ORDER BY created_at DESC LIMIT 1000'));
    }
    res.json(rows.map(mapSale));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل تحميل المبيعات' });
  }
});

app.post('/api/sales', async (req, res) => {
  try {
    const { productId, productName, salePrice, costPrice, profit, date, time } = req.body;
    if (!productName || salePrice == null || costPrice == null || profit == null || !date || !time) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sales (product_id, product_name, sale_price, cost_price, profit, sale_date, sale_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId || null, productName, salePrice, costPrice, profit, date, time]
    );
    res.json(mapSale(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل تسجيل البيع' });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sales WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل حذف المبيعة' });
  }
});

/* ------------------------------------------------------------
   الإحصائيات العامة (كل تاريخ العمل)
   ------------------------------------------------------------ */
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sale_date, SUM(sale_price)::bigint AS revenue, SUM(profit)::bigint AS profit, COUNT(*)::int AS orders
      FROM sales GROUP BY sale_date
    `);
    const totalDays = rows.length;
    const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);
    const totalProfit = rows.reduce((s, r) => s + Number(r.profit), 0);
    const avgDaily = totalDays ? Math.round(totalRevenue / totalDays) : 0;
    res.json({ totalRevenue, totalProfit, totalDays, avgDaily });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'فشل تحميل الإحصائيات' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log('السيرفر يعمل على المنفذ ' + PORT));
  })
  .catch(err => {
    console.error('فشل الاتصال بقاعدة البيانات عند بدء التشغيل:', err);
    process.exit(1);
  });
