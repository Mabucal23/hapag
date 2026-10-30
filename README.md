# Hapag Kainan POS — Vercel + PostgreSQL

Restaurant: Hapag Kainan — L. Joson Street, Zone 3, Socorro, Oriental Mindoro.

This version runs as a Vercel-hosted Express app and uses a **hosted PostgreSQL database** rather than local SQLite. Existing menu, food illustrations, kitchen view, reports, inventory, and print receipts are included.

## Deploy from GitHub to Vercel

1. Create a hosted **PostgreSQL** database in Supabase or Neon. In Supabase choose **Connect → Transaction pooler** and copy the PostgreSQL URI. Keep the password private.
2. Push the contents of **this folder** (including `package.json` and `server.js` at the repository root) to a GitHub repository. Don't commit `.env` or credentials.
3. In Vercel choose **Add New → Project → Import Git Repository**. Select your repository. Framework preset: **Other** (or auto-detected Express). Root directory: repository root. No custom build command or output directory required.
4. Under **Environment Variables**, add:
   - `DATABASE_URL` = full PostgreSQL connection string (use transaction pooler for Supabase). Alternatively `POSTGRES_URL` works.
   - `ADMIN_PIN` = a **long private PIN** of at least eight characters (do not use 1234).
   Configure both for Production (and Preview if you need working preview builds).
5. Deploy or **Redeploy** after adding variables. On the first visit to `/api/menu`, tables and the starter menu are created automatically.
6. Check `https://YOUR-PROJECT.vercel.app/api/health`: expect `{ "ok": true, "database": "connected" }`. Open the root website, log in from Kitchen, Inventory, Dashboard or checkout, and test an order and printing.

## Local development

- Install Node.js 22.
- `npm install`
- Set `DATABASE_URL` and `ADMIN_PIN` in your local shell, or use an `.env` file with a tool that loads environment variables (Node: `node --env-file=.env server.js`).
- `npm start` then open http://localhost:3000

## Important notes

- **Existing SQLite data is not automatically migrated.** The first PostgreSQL deployment seeds the starter menu when the products table is empty; any SQLite-only orders will remain in the old database.
- Menu prices and inventory defaults are sample values; verify before accepting payments.
- Cash/Card/Digital Pay records are internal bookkeeping only; this app does not process bank/card charges or verify digital payments.
- Print uses the browser print dialog; thermal printer support depends on the device driver, print width, and browser settings.
- This generates a sales receipt **not a BIR-registered invoice**.
- Built for a prototype. Before real-world operations, implement staff accounts/roles, audit logs, verified payments, backups, end-to-end tests, business tax requirements, and secure operational processes.
- Database URL and admin PIN are **server environment variables**, never pasted into client JavaScript.

## API

`GET /api/health`, `GET /api/menu`, `POST /api/login`, `POST /api/orders` (admin token), `GET /api/orders` (admin), `GET/PATCH /api/orders/:id` (admin), `GET /api/dashboard` (admin), `GET/POST /api/products` (admin), `PATCH /api/products/:id` (admin).
