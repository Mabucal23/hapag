require('dotenv').config();
'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { Pool, types } = require('pg');
types.setTypeParser(20, value => Number(value));
const categories = require('./menu-data');
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'100kb'}));
app.use(express.static('public', {index:'index.html'}));
const connectionString=process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool=connectionString ? new Pool({connectionString,max:2,connectionTimeoutMillis:9000,idleTimeoutMillis:20000,ssl:connectionString.includes('localhost')?false:{rejectUnauthorized:false}}):null;
const err=(status,message)=>Object.assign(new Error(message),{status});
const validImage=v=>{const s=String(v||'').trim();if(!s)return '';if(s.length>1200||!(/^https:\/\//i.test(s)||/^\/images\/[\w.-]+\.(svg|png|jpg|jpeg|webp)$/i.test(s)))throw err(400,'Image must be HTTPS or a local /images/ path');return s};
const money=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000000;
const pin=process.env.ADMIN_PIN;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
// SQL schema and initial menu are idempotent, safe across concurrent cold starts.
let ready;
async function init(){
 if(!pool)throw err(503,'Set DATABASE_URL in Vercel Environment Variables and redeploy');
 const c=await pool.connect();
 try{
  await c.query(`CREATE TABLE IF NOT EXISTS products(id BIGSERIAL PRIMARY KEY,category TEXT NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 100,low_stock INTEGER NOT NULL DEFAULT 5,active INTEGER NOT NULL DEFAULT 1,image_url TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),customer TEXT NOT NULL DEFAULT 'Walk-in',order_type TEXT NOT NULL DEFAULT 'Dine In',payment_method TEXT NOT NULL,subtotal INTEGER NOT NULL,discount INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,tendered INTEGER NOT NULL,change_due INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'Pending',notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS order_items(id BIGSERIAL PRIMARY KEY,order_id BIGINT NOT NULL REFERENCES orders(id),product_id BIGINT NOT NULL,product_name TEXT NOT NULL,quantity INTEGER NOT NULL,price INTEGER NOT NULL,line_total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);`);
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(29489110)');
  const count=await c.query('SELECT COUNT(*)::int n FROM products');
  if(count.rows[0].n===0){for(const [category,items] of Object.entries(categories)) for(const [name,price] of items)await c.query('INSERT INTO products(category,name,price) VALUES($1,$2,$3)',[category,name,price*100]);}
  await c.query('COMMIT');
 }catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}
}
app.use('/api',async(req,res,next)=>{try{if(!ready)ready=init().catch(e=>{ready=null;throw e});await ready;next()}catch(e){next(e)}});
function wrap(f){return (req,res,next)=>Promise.resolve(f(req,res)).catch(next)}
async function requireAdmin(req,res,next){try{const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!t)return next(err(401,'Administrator login required'));const r=await pool.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[hash(t)]);if(!r.rows.length||Number(r.rows[0].expires_at)<=Date.now())return next(err(401,'Administrator login required'));next()}catch(e){next(e)}}
async function detail(id,db=pool){const r=await db.query('SELECT * FROM orders WHERE id=$1',[id]);if(!r.rows.length)return null;const it=await db.query('SELECT product_id,product_name,quantity,price,line_total FROM order_items WHERE order_id=$1',[id]);return {...r.rows[0],items:it.rows}}
app.get('/api/health',wrap(async(req,res)=>{const r=await pool.query('SELECT 1 AS ok');res.json({ok:r.rows[0].ok===1,database:'connected'})}));
app.get('/api/menu',wrap(async(req,res)=>{const r=await pool.query('SELECT * FROM products WHERE active=1 ORDER BY category,name');res.json({products:r.rows,categories:Object.keys(categories)})}));
app.post('/api/login',wrap(async(req,res)=>{
 if(!pin||pin.length<8)throw err(503,'Configure ADMIN_PIN with at least 8 characters');
 const input=String(req.body?.pin||'');const a=Buffer.from(hash(input),'hex'),b=Buffer.from(hash(pin),'hex');if(!crypto.timingSafeEqual(a,b))throw err(401,'Invalid administrator PIN');
 const token=crypto.randomBytes(32).toString('hex');await pool.query('INSERT INTO sessions(token_hash,expires_at) VALUES($1,$2)',[hash(token),Date.now()+8*3600000]);res.json({token});
}));
app.post('/api/orders',requireAdmin,wrap(async(req,res)=>{
 const b=req.body||{};
 if(!Array.isArray(b.items)||b.items.length<1||b.items.length>100)throw err(400,'Add at least one item');
 if(!['Cash','Card','Digital Pay'].includes(b.payment_method)||!['Dine In','Takeout','Delivery'].includes(b.order_type))throw err(400,'Invalid payment method or order type');
 const quantities=new Map();for(const i of b.items){if(!Number.isSafeInteger(i.id)||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>99)throw err(400,'Invalid quantity');quantities.set(i.id,(quantities.get(i.id)||0)+i.quantity)}
 const client=await pool.connect();try{await client.query('BEGIN');const lines=[];let subtotal=0;
 for(const [id,qty] of [...quantities].sort((a,b)=>a[0]-b[0])){const r=await client.query('SELECT * FROM products WHERE id=$1 AND active=1 FOR UPDATE',[id]);const p=r.rows[0];if(!p)throw err(400,'Menu item unavailable');if(p.stock<qty)throw err(400,`${p.name}: only ${p.stock} remaining`);subtotal+=p.price*qty;lines.push({p,qty});}
 const discount=Number(b.discount||0);if(!money(discount)||discount>subtotal)throw err(400,'Invalid discount');const total=subtotal-discount;const tendered=b.payment_method==='Cash'?Number(b.tendered):total;if(!money(tendered)||tendered<total)throw err(400,'Insufficient cash payment');
 const customer=String(b.customer||'Walk-in').trim().slice(0,80)||'Walk-in',notes=String(b.notes||'').slice(0,500);
 const inserted=await client.query('INSERT INTO orders(customer,order_type,payment_method,subtotal,discount,total,tendered,change_due,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[customer,b.order_type,b.payment_method,subtotal,discount,total,tendered,tendered-total,notes]);const id=inserted.rows[0].id;
 for(const {p,qty} of lines){await client.query('INSERT INTO order_items(order_id,product_id,product_name,quantity,price,line_total) VALUES($1,$2,$3,$4,$5,$6)',[id,p.id,p.name,qty,p.price,p.price*qty]);await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[qty,p.id]);}
 const order=await detail(id,client);await client.query('COMMIT');res.status(201).json({order});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.get('/api/orders',requireAdmin,wrap(async(req,res)=>{const r=await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 200');res.json({orders:r.rows})}));
app.get('/api/orders/:id',requireAdmin,wrap(async(req,res)=>{const o=await detail(req.params.id);if(!o)throw err(404,'Order not found');res.json({order:o})}));
app.patch('/api/orders/:id',requireAdmin,wrap(async(req,res)=>{
 const status=req.body?.status;if(!['Pending','Preparing','Ready','Completed','Cancelled'].includes(status))throw err(400,'Invalid status');
 const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rows.length)throw err(404,'Order not found');const before=r.rows[0].status;if(before==='Cancelled'&&status!=='Cancelled')throw err(400,'Cancelled orders cannot be reopened');
 if(before!=='Cancelled'&&status==='Cancelled'){const items=await c.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1',[req.params.id]);for(const i of items.rows)await c.query('UPDATE products SET stock=stock+$1 WHERE id=$2',[i.quantity,i.product_id]);}
 await c.query('UPDATE orders SET status=$1 WHERE id=$2',[status,req.params.id]);const order=await detail(req.params.id,c);await c.query('COMMIT');res.json({order})
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.get('/api/dashboard',requireAdmin,wrap(async(req,res)=>{
 const date=req.query.date||new Date(Date.now()+8*3600000).toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw err(400,'Invalid date');
 const a=await pool.query("SELECT COUNT(*)::int orders,COALESCE(SUM(total),0)::int revenue FROM orders WHERE (created_at AT TIME ZONE 'Asia/Manila')::date=$1::date AND status!='Cancelled'",[date]);
 const top=await pool.query("SELECT i.product_name name,SUM(i.quantity)::int qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE (o.created_at AT TIME ZONE 'Asia/Manila')::date=$1::date AND o.status!='Cancelled' GROUP BY i.product_name ORDER BY qty DESC LIMIT 5",[date]);
 const low=await pool.query('SELECT id,name,stock,low_stock FROM products WHERE stock<=low_stock AND active=1 ORDER BY stock ASC');res.json({date,summary:a.rows[0],top:top.rows,low:low.rows});
}));
app.get('/api/products',requireAdmin,wrap(async(req,res)=>{const r=await pool.query('SELECT * FROM products ORDER BY category,name');res.json({products:r.rows})}));
function validateProduct(b){if(!String(b.name||'').trim()||!String(b.category||'').trim()||!money(b.price)||!money(b.stock)||!money(b.low_stock))throw err(400,'Invalid product details');return [String(b.name).trim().slice(0,100),String(b.category).trim().slice(0,60),b.price,b.stock,b.low_stock,validImage(b.image_url)]}
app.post('/api/products',requireAdmin,wrap(async(req,res)=>{const v=validateProduct(req.body||{});const r=await pool.query('INSERT INTO products(name,category,price,stock,low_stock,image_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',v);res.status(201).json({id:r.rows[0].id})}));
app.patch('/api/products/:id',requireAdmin,wrap(async(req,res)=>{const b=req.body||{};const v=validateProduct(b);if(![0,1].includes(b.active))throw err(400,'Invalid active setting');const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,stock=$4,low_stock=$5,image_url=$6,active=$7 WHERE id=$8',[...v,b.active,req.params.id]);if(!r.rowCount)throw err(404,'Product not found');res.json({ok:true})}));
app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found'}));
app.use((e,req,res,next)=>{if(e.type==='entity.too.large')return res.status(413).json({error:'Request too large'});if(e instanceof SyntaxError && 'body' in e)return res.status(400).json({error:'Invalid JSON'});if(e.code==='22P02')return res.status(400).json({error:'Invalid identifier'});console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Database or server error; check Vercel runtime logs'})});
module.exports=app;
if(require.main===module){const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`Hapag Kainan POS http://localhost:${port}`))}
