# Minhwa member app — Seat booking

Weekly seat board + Swish payment for the Minhwa Association. Next.js 15 · Supabase (phone login) · Vercel.

## 1. Supabase
1. Create a new project (region: EU / Stockholm).
2. SQL Editor → run `sql/schema_v1.sql`, then the migrations in order (`migration_v2` … `migration_v13`).
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

### Receipts by e-mail (v13) — extra setup
The app takes in members' receipts mailed to `receipt@minhwa.org` (an alias of `manager@minhwa.org`, Microsoft 365).
1. **Resend** (resend.com, free plan): add the domain `in.minhwa.org` for *receiving* → put its MX record in GoDaddy DNS (subdomain `in` — the root MX stays Microsoft 365). Add `minhwa.org` for *sending* → its DKIM record and the SPF `include` next to Microsoft's in the root TXT. Webhooks → add endpoint `https://app.minhwa.org/api/inbound/receipt`, event `email.received`; copy the signing secret.
2. **Vercel → Environment Variables**: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (`whsec_…`), `ANTHROPIC_API_KEY` (reads the receipts), `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API → service_role), `MAIL_FROM` = `Minhwa Association <manager@minhwa.org>`. Optional: `MAIL_REPLY_TO`, `APP_URL`, `CLAUDE_MODEL`. Redeploy.
3. **Microsoft 365**: make every mail to `receipt@minhwa.org` also go to `receipt@in.minhwa.org`. First try an Outlook rule on manager@ (*sent to receipt@minhwa.org → redirect to receipt@in.minhwa.org, move to folder Receipts*). If the tenant blocks external auto-forwarding (a bounce says so), use the Exchange admin center instead: remove the alias and create a distribution group `receipt@minhwa.org` with members manager@ and a mail contact `receipt@in.minhwa.org`.
4. Send one test mail with a photo to receipt@minhwa.org → it should appear under Payments → Receipts within a minute, and the sender (if a member with that e-mail) gets the "received" reply. The Receipts page lists any variable still missing.

## How it works
- `/` weekly board (10 slots × week). Dots = members; 5 = "Full"; extra bookings show in navy.
- `/slot/[id]/[date]` who's coming + Book. Booking calls `book_seat()` in the database, which checks window/limits and creates a **payment** with a short code (`S0231`).
- `/pay/[bookingId]` opens Swish via deep link with number, amount and message pre-filled — the message starts with the code: `S0231 05/10 Mon Day Rock`. "I have paid" → awaiting confirmation → the treasurer confirms.
- `/me` my seats, cancel (free until N days before — enforced in `cancel_booking()`).
- `/store` — materials the association buys in Korea. Members enter quantities → one order, one payment (`kind = material`, code `O0001`, Swish message `O0001 Store <name>`) → "I have paid" → the treasurer confirms in Payments → lines become *paid*. Items in stock are handed out at the studio (`/store/admin` → "From stock → ready" → "Collected"); items not in stock wait for the next group order (step 2b). `/store/orders` = my orders. Products can be ordered at stock 0 as long as they are on the list (`active`).
- `/store/admin` — **Treasurer and Admin only.** Hand out paid lines, run the group order from Korea (waiting lines → shopping list with restock → ordered → arrived), answer requests, refund lines, see orders awaiting payment, edit products (name · variant · maker · price · minimum · on the list), two photos per product (shrunk in the browser, stored in the public `product-photos` bucket), change stock only through recorded adjustments (`stock_movements`), add products, see the stock log.
- `/payments/receipts` — **Treasurer and Admin only.** Members' receipts for things they paid for the association (see *Receipts* below): check → approve → pay from the bank → the transfer is matched → paid. `/me/receipts` — a member's bank account for paying them back, upload a receipt, follow the answer.
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

## Group orders from Korea (v11)
One `purchase_batches` row is *open* at a time ("2026-10 Korea"). Paid lines that cannot be handed out from stock go on it (`order_items.status = group_buy`, `batch_id`); restock pieces per product live in `purchase_lines` (suggested as `min_stock − stock` for low-stock products). `mark_batch_ordered` freezes the list; `mark_batch_arrived` books every product in (`stock_movements.purchase`), hands the members' lines out (`sale`) and marks them ready. Costs (KRW, SEK/KRW rate, shipping, customs, import VAT) are kept on the batch and shown against what members paid. `requests` = a member's ask for something not on the list (open → added with the linked product / declined). `refund_order_item` marks a line refunded after the treasurer has sent the money back with Swish; when every line of an order is refunded the payment is too. Members see group orders through `group_orders_public` (name and status only).

## Price rule and quotes (v12)
Members are not charged shipping, customs or VAT: a piece that costs ₩10,000 in Korea is sold for 100 kr (`settings.price_krw_per_sek`, 100), and the gap to the real exchange rate covers the logistics. `products.cost_krw` keeps the latest cost per piece (copied from the group order on arrival); the shopping list and the product list show the rule price when it differs. A request for something that is not on the list can be **quoted**: `quote_request` creates a hidden "Special" product for that member plus an order awaiting payment — from there it is an ordinary order (Swish → confirmed → group order → ready).

## Receipts (v13)
A member pays for something for the association and mails the receipt (photo or PDF) to **receipt@minhwa.org**, or uploads it under My seats → Receipts. Resend receives the copy and calls `POST /api/inbound/receipt` (Svix-signed; the middleware lets `api/inbound/` through). The route stores the files in the private bucket `receipts` (`<claim id>/…`), creates an `expense_claims` row (`import_claim`, code `R0001`…; the same Message-ID twice is one claim) and links the member by the sending address (`members.email` or the learned `members.extra_emails`). After answering the webhook it reads the receipt with Claude (`lib/claims-read.ts`: shop, date, total, currency, VAT, items, kind — a card slip is flagged), stores the reading (`set_claim_reading`, only fills what is still empty) and sends **one** automatic reply, "received", to a known member (`MAIL_FROM`, via Resend). Nothing else is mailed by the app.

The treasurer (Payments → Receipts) checks the numbers, says who an unknown sender is (remembered), approves with the amount to pay back and a category (`ledger_categories`, seeded from the 2024 categories: 3985 membership · 3400 course · 3980 material sold / grant · 2893 loan · 5460 material · 6570 fees …), or declines with a reply. Then pays from Nordea to the account the member saved (`member_bank_accounts`, visible to the member and the treasurer only) with the claim code as message. When the statement is pasted, each outgoing line is matched to an approved claim by amount + member name (or the code in the message) and offered as "Paid — this line"; "Paid by hand" works without the bank. `unpay_claim` / `reopen_claim` take steps back. Claim statuses: `new → approved → paid`, or `declined`. A claim (receipt file + decision + bank line) is one voucher for the books; since July 2024 the digital copy is enough in Sweden.

## Next modules (same database)
- Ledger: categories for every bank line (the `ledger_categories` table is the start), month close, SIE export, advance payments (paid orders not yet handed out).
- Secretary: association mailbox, notices, financial report to members.
