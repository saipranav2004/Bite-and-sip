# Bite & Sip — Project State

_Last updated: 11 Oct 2026 (IST)._

## Current phase
**Live on Vercel + Supabase. Iteration 3 adds the owner's business tools and a redesigned staff console.**

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
  - Team page: create logins by username, reset passwords, remove access (Edge Function `staff-admin`, owner-checked)
  - staff console redesign: sidebar / icon rail / bottom tabs, page headers, period picker, KPI cards with deltas, data tables, drawers
  - kept the kitchen role: helpers never see profit, prices or the UPI ID, and the audit log names who did what; an owner can still run everything alone

## Key decisions
Counter pickup only · statuses `placed→preparing→ready→completed` + `cancelled` · payment `unpaid/paid` kept separate, with UPI "customer says paid" shown as a claim only · completion requires paid · paid→unpaid owner-only · device-generated 256-bit order secret (hash stored) for anonymous access · prices computed only in SQL · max 3 open orders per phone · IST business day · black = identity, yellow = action.

## Tests executed (all passing)
| Suite | Result |
|---|---|
| Lint | 0 errors (style warnings only) |
| Typecheck, build | pass |
| Unit + component | 36/36 |
| DB/security/business rules on local Supabase (incl. Edge Function) | 78/78 |
| E2E demo (phone + desktop) | 26/26 |
| E2E local Supabase (phone + desktop) | 26/26 |

## Outstanding
1. Set a real UPI ID in Settings and test with ₹1 on a real phone.
2. Change the simple starter passwords; print the table QR codes from the live domain.
3. Enter item costs (Menu) and start logging expenses so Profit & loss reflects reality.
4. Manual checks not automatable here: iOS Safari, real UPI apps, paper printing.
5. Possible later: daily cash-closing report, refund tracking, CAPTCHA on ordering, phone-number retention job.
