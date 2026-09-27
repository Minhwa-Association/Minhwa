# Minhwa member app — Seat booking

Weekly seat board + Swish payment for the Minhwa Association. Next.js 15 · Supabase (phone login) · Vercel.

## 1. Supabase
1. Create a new project (region: EU / Stockholm).
2. SQL Editor → run `sql/schema_v1.sql`, then the migrations in order (`migration_v2` … `migration_v8`).
3. Authentication → Providers → **Phone** → enable, choose **Twilio**, paste Account SID, Auth Token and Message Service SID (or a sender number / alphanumeric sender "Minhwa").
4. Authentication → URL configuration → Site URL = your Vercel URL (later).
5. Project Settings → API → copy **Project URL** and **anon public** key.

## 2. Run locally
```
cp .env.example .env.local   # paste URL + anon key
npm install
npm run dev
```
Log in with your own phone once, then run `sql/make_admin.sql` (with your phone) in the SQL Editor to become admin.

## 3. Deploy
Push to GitHub (`Minhwa-Association/Minhwa`), import into Vercel, add the two env variables, deploy.
Then set the Vercel URL as Site URL in Supabase Auth.

## How it works
- `/` weekly board (10 slots × week). Dots = members; 5 = "Full"; extra bookings show in navy.
- `/slot/[id]/[date]` who's coming + Book. Booking calls `book_seat()` in the database, which checks window/limits and creates a **payment** with a short code (`S0231`).
- `/pay/[bookingId]` opens Swish via deep link with number, amount and message pre-filled — the message starts with the code: `S0231 05/10 Mon Day Rock`. "I have paid" → awaiting confirmation → the treasurer confirms.
- `/me` my seats, cancel (free until N days before — enforced in `cancel_booking()`).
- `/store` — materials the association buys in Korea. Members enter quantities → one order, one payment (`kind = material`, code `O0001`, Swish message `O0001 Store <name>`) → "I have paid" → the treasurer confirms in Payments → lines become *paid*. Items in stock are handed out at the studio (`/store/admin` → "From stock → ready" → "Collected"); items not in stock wait for the next group order (step 2b). `/store/orders` = my orders. Products can be ordered at stock 0 as long as they are on the list (`active`).
- `/store/admin` — **Treasurer and Admin only.** Hand out paid lines, see orders awaiting payment, edit products (name · variant · maker · price · minimum · on the list), change stock only through recorded adjustments (`stock_movements`), add products, see the stock log.
- `/payments` — **Treasurer and Admin only.** Paste the Nordea statement (CSV export or copied rows). Each line is stored once (fingerprint of date + amount + text + balance) and matched: a payment code in the line = matched; same amount + payer name ≈ member name (or a bank name learned earlier) + date within the window = suggested. Three lists: matched/suggested (confirm · not this one), waiting for confirmation (members who tapped "I have paid"), only in the bank (attach to a payment · set aside). Confirming makes the seat green everywhere; Undo takes it back. Money going out is kept for the ledger (next step).
- `/calendar` shared calendar of the association's activities — **Crew and Admin only** (members and teachers don't see the tab). `/calendar/subscribe` gives a personal webcal link (`/cal/<token>.ics`) for the phone's calendar app.
- `/admin` week board with names + payment status ("Mark paid" = confirm by hand, same as in Payments); `/admin/settings` price, Swish number, rules, teachers, roles (Teacher / Crew / Treasurer / Admin — any combination per member), and pre-registering members/teachers by phone (linked automatically on their first login).

All rules live in the database functions (`sql/`), so the app can't bypass them.

## Payment statuses
`pending` (not paid) → `claimed` ("I have paid") → `confirmed` (treasurer, usually against a bank line) → `refunded`. `cancelled` = the booking was cancelled before it was paid. Bank lines: `unmatched` → `suggested` / `matched` → `confirmed`; `ignored` (set aside) · `outgoing` (money going out).

## Nordea statement formats
- Association account (PlusGiro företag): `Bokföringsdag,Belopp,Avsändare,Mottagare,Namn,Ytterligare detaljer,Meddelande,Egna anteckningar,Saldo,Valuta`. An incoming Swish has `Namn = Inbetalning Swish Företag` and the **payer's name in `Meddelande`** (bank spelling, `SURNAME,GIVEN`, cut at 20 characters). `Saldo` is written on one line per day only. Transfers carry the other party in `Ytterligare detaljer` and the transfer message in `Meddelande`.
- Personal account: `Bokföringsdag;Belopp;Avsändare;Mottagare;Namn;Rubrik;Saldo;Valuta;` — an incoming Swish is `Rubrik = Swish inbetalning <payer's name>`.
- Neither export carries the Swish message or a reference number, so matching works on name + amount + date (a payer name the treasurer attaches once is remembered in `members.bank_names`; names cut at 20 characters match by prefix) and a line's identity is date + amount + text + name + message + its position among identical lines. The payment code only matches automatically when a source includes the Swish message.

## Store data (v9)
`products` (code = the old inventory app's product string, category Brush · Paper · Colour, subcategory, name, variant, maker, price in whole kr, stock, min_stock, active) · `stock_movements` (opening · adjust · sale · purchase · return — `products.stock` follows by trigger) · `orders` (one payment each) · `order_items` (qty, price and name as ordered, status awaiting_payment → paid → ready → collected; group_buy for step 2b). The 25 products and their stock of 2026-09-27 are seeded by the migration.

## Next modules (same database)
- Store step 2b: purchase list → group-buy batches (`purchase_batches` · `purchase_lines`) → arrival = stock in + lines ready; "request" box for materials not on the list; refunds.
- Ledger: categories for every bank line (starting from the 2024 categories), receipts, month close, SIE export.
