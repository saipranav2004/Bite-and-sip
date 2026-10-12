# Bite & Sip — Project State

_Last updated: 13 Oct 2026 (IST)._

## Current phase
**Live on Vercel + Supabase. Iteration 5 adds offers, pre-orders, push alerts, the kitchen screen, cash closing, shopping list, insights, feedback and Hindi/Telugu.**

## Completed
- Research (reference projects, Supabase/UPI primary docs, yellow-and-black UI/UX research with contrast measurements).
- Product spec, user flows, design review (16 contradictions resolved), design system, mockup plan.
- Database: 2 migrations covering schema, RLS, least-privilege grants, state-machine trigger, kitchen/owner guards, customer RPCs, owner reporting, storage bucket and policies, realtime publication. Seed generated from the shared dataset.
- Frontend:
  - Student: QR table entry, menu (search, categories, popular, sold out), item sheet, cart + checkout, cash/UPI, live tracking, self-cancel, my orders.
  - Staff: login, role-aware nav, live board (chime, timers, conflict handling), UPI verification, cash at handover, cancellations, menu CRUD with photos and add-ons, categories, availability, reports + CSV, settings (open/closed, UPI + test QR, tables, printable QR, staff access).
- Demo backend for interactive mockups and previews (labelled "Demo mode").
- Vercel config with SPA rewrites and security headers (CSP verified in a browser).
- **Iteration 2:**
  - brand intro from the café logo (once per session, skippable, reduced-motion aware, doubles as the loader)
  - 14 real food photos
  - view transitions, staggered reveals, fly-to-cart, order-placed and ready celebrations, kitchen new-order highlight
  - "How it works" footer
  - fixes: toasts blocking taps, nested link/button
  - dev-only sample-history seed
  - scripted walkthrough video

- **Iteration 3:**
  - item and add-on costs (owner-only), snapshotted per order line so later changes never rewrite past profit
  - inventory for batch items: automatic deduction, return on cancel, sold out at zero, received / waste / recount / correction, history, low-stock badge
  - expenses by category; profit & loss (gross, net, margins, prime cost, previous period, per-item profit, CSV) with one food-cost method at a time so ingredients are never counted twice
  - append-only audit log written by database triggers (prices, costs, stock, payments, cancellations, staff, settings, expenses)
  - staff console redesign: sidebar / icon rail / bottom tabs, page headers, period picker, KPI cards with deltas, data tables, drawers
  - single-operator console: the owner handles orders, payments and everything else from one login (cooks don't use the site); one-tap open/close in the header, today's takings on the board, sound prompt, own password change in Settings

- **Iteration 4:**
  - raw materials with free-text names and unit dropdowns (stored in base units g/ml/pcs/packet), purchases that can post to Expenses, usage/waste/counts, history
  - optional recipes per menu item: automatic deduction on sale (one statement-level trigger per order, rows locked in id order), returned on cancel, never blocks ordering; recipe cost → "Use as cost"
  - table service: table QR orders are served at the table (big table label on the board, "Served at T5"), counter QR orders are collected

- **Iteration 5:**
  - offers (percent off, items, days, hours, dates) priced in SQL; `p_expected_total` refuses an order whose total changed since the student looked
  - pre-orders (`scheduled_for`, 15–720 minutes ahead, same café day); board "later" strip; kitchen timing from the due time
  - wait-time estimate (`kitchen_eta`: median time to ready over 14 days + queue)
  - call staff from the table (`service_requests`, de-duplicated, rate-limited, live on the board)
  - feedback after serving (`order_feedback`), owner Feedback page; Order again
  - web push: dependency-free VAPID + aes128gcm Edge Function (checked against the RFC 8291 example), triggered after commit by pg_net; owner alerts (new order, UPI claim, table request) and student "ready" alerts in their language; subscriptions limited to real push services
  - kitchen screen with a secret link (no prices/phones; can only start/finish orders); printable kitchen tickets
  - daily cash closing with history; ingredient usage RPC → shopping list and expected-vs-actual usage check; menu engineering insights
  - English / Hindi / Telugu student UI (Noto fonts loaded only when needed); veg-only filter; installable PWA (student and console manifests), offline page
  - owner console and kitchen screen are code-split (student bundle 731 → 518 kB)

## Key decisions
Counter pickup only · statuses `placed→preparing→ready→completed` + `cancelled` · payment `unpaid/paid` kept separate, with UPI "customer says paid" shown as a claim only · completion requires paid · paid→unpaid owner-only · device-generated 256-bit order secret (hash stored) for anonymous access · prices computed only in SQL · max 3 open orders per phone · IST business day · black = identity, yellow = action.

## Tests executed (all passing)
| Suite | Result |
|---|---|
| Lint | 0 errors (style warnings only) |
| Typecheck, build | pass |
| Unit + component | 61/61 |
| DB/security/business rules on local Supabase | 110/110 |
| E2E demo (phone + desktop) | 46/46 |
| E2E local Supabase (phone + desktop) | 46/46 |
| Production push chain (DB event → Edge Function → Google push service) | verified with a test subscription, then removed |

## Outstanding
1. Set a real UPI ID in Settings and test with ₹1 on a real phone.
2. Change the simple starter passwords; print the table QR codes from the live domain.
3. Enter item costs (Menu) and start logging expenses so Profit & loss reflects reality.
4. Turn on alerts on the owner's phone (Settings → Alerts & app) and place a test order with the screen locked.
5. Manual checks not automatable here: iOS Safari, real UPI apps, paper printing on the actual receipt printer, Hindi/Telugu wording review by a native speaker.
6. Possible later: automatic UPI confirmation (payment gateway), refund tracking, CAPTCHA on ordering, phone-number retention job.
