# Bite & Sip — College Café Ordering

Students scan the QR on their table, order and pay from their phone, and the food is brought to that table (orders from the counter QR are collected at the counter). The owner runs the whole café from one login: the live orders board and payments, menu and costs, stock, expenses, profit & loss, an audit log, UPI and table QR codes. Cooks don't need an account.

**Stack:** React 19 · Vite · Tailwind CSS v4 · Supabase (Postgres, Auth, Realtime, Storage) · Vercel.

## Features
- **Students (no sign-up):**
  - QR table entry with a brand intro
  - menu with real photos, search, categories and add-ons
  - one-page checkout (name + mobile), cash or UPI (QR + deep link)
  - live order tracking, self-cancel before preparation, "My orders" on the device
- **Owner, at the counter:**
  - live board (New → Preparing → Ready) with a sound alert, ticket timers and today's takings
  - UPI payment checks, cash collection at handover, cancellations with reasons
  - one-tap open / close for orders, sold-out switches
- **Owner, running the business:**
  - menu editing (photos, prices, add-ons, categories) with the cost to make each item and live margins
  - **Raw materials:** any ingredient name (milk, maida, tea powder…) with a unit (g, kg, ml, L, pieces, dozen, packets); record bought (with price, optionally added to Expenses), used, wasted and counted; low-stock warnings, stock value and full history
  - **Recipes (optional):** e.g. Masala Chai = 100 ml milk + 4 g tea powder + 10 g sugar. Every sale uses them up automatically, cancellations put them back, and the recipe gives the cost per item. Low ingredient stock never blocks a sale
  - **Ready-made items:** track batch items (samosas, sandwiches); orders reduce stock, cancellations return it, items sell out by themselves at zero
  - **Expenses:** log wages, rent, gas, ingredients… by category
  - **Profit & loss:** sales − food cost = gross profit − running costs − waste = net profit, with margins, previous-period comparison, per-item profit and CSV export. Food cost comes from item costs *or* ingredient purchases — never both, so nothing is counted twice
  - **Audit log:** every change to prices, costs, stock, payments, staff and settings, who made it and when; append-only, CSV export
  - sales reports that reconcile cash, confirmed UPI and unpaid amounts; café open/closed, UPI ID with ₹1 test QR, tables and printable QR codes
- **Security:**
  - prices calculated in the database
  - Row Level Security on every table
  - per-order device secrets for anonymous tracking
  - order and payment state machine enforced by triggers
  - only staff can mark orders paid
  - costs, expenses, profit and the audit log are owner-only (kitchen logins never see them)

## Try it in 30 seconds (no accounts)
```bash
git clone https://github.com/saipranav2004/Bite-and-sip.git
cd Bite-and-sip
npm install
npm run dev:demo
```
- Student: <http://localhost:5173/t/T12>
- Staff: <http://localhost:5173/staff>. The demo accounts are shown on the login page.

Demo mode keeps data in the browser and is labelled on every screen.

## Run with a local Supabase (needs Docker)
```bash
npx supabase start            # applies supabase/migrations and supabase/seed.sql
npx supabase status           # copy API URL + publishable key into .env.local (see .env.example)
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret key> \
  node scripts/create-staff.mjs --email owner@example.com --name "Owner" --role owner --password '<password>'
npm run dev
```

## Deploy
### Supabase
1. Create a project (Mumbai region recommended).
2. Push the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
3. Optional: run `supabase/seed.sql` in the SQL editor for the starter menu. Then set your real UPI ID in Settings.
4. Authentication: turn **off** "Allow new users to sign up" and set the Site URL to your Vercel URL.
5. Create the owner account from your computer (the secret key never goes into Vercel or git). Change its password later from **Settings → Your login**.
   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
     node scripts/create-staff.mjs --email admin@bite.local --name "Owner" --role owner
   ```
   Staff can sign in with just the username (`admin`), or with a full email address.

### Vercel
1. **Add New → Project →** import `saipranav2004/Bite-and-sip` (default settings; `vercel.json` handles routing and security headers).
2. Add the environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then deploy. Without them the site runs in demo mode.
3. Sign in at `/staff/login`. Set the UPI ID and test it with ₹1, then print the table QR codes from Settings.

### Go-live checklist
- Only the publishable key is in Vercel. No secret key anywhere in the repo or browser.
- Public sign-up is off. Only real staff have accounts.
- A real UPI ID is set and tested on a phone.
- QR codes are printed from the final domain.

## Scripts
| Command | Does |
|---|---|
| `npm run dev` / `dev:demo` | Dev server (Supabase from `.env.local` / in-browser demo) |
| `npm run check` | Lint, typecheck, unit + component tests, build |
| `npm run test:db` | Database security and business-rule tests against local Supabase |
| `npm run test:e2e` / `test:e2e:supabase` | Playwright journeys (demo / local Supabase) |
| `npm run staff:create -- --email … --name … --role owner\|kitchen` | Create or update a staff account |
| `npm run seed:generate` | Regenerate `supabase/seed.sql` from `src/data/catalog.json` |
| `npm run seed:sample-history` | Local only: add a week of sample orders for reports |

## Project layout
```
src/
  backend/      Backend interface + Supabase and demo implementations
  components/   UI kit, icons, food art, QR, intro, celebrations
  data/         Menu catalog
  hooks/        Live order tracking (student) and live board (staff)
  lib/          Pricing, order rules, stock, profit & loss, audit wording, UPI, validation, reports
  pages/        student/ and staff/ screens
  state/        Cart, device secrets, menu data, staff session
supabase/       config, migrations (schema, security, business rules), seed
scripts/        staff accounts, seeds, walkthrough video tooling
tests/          db/ (security, local Supabase) and e2e/ (Playwright)
```
