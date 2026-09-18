# Minhwa member app — Seat booking

Weekly seat board + Swish payment for the Minhwa Association. Next.js 15 · Supabase (phone login) · Vercel.

## 1. Supabase
1. Create a new project (region: EU / Stockholm).
2. SQL Editor → run `sql/schema_v1.sql`.
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
Push to GitHub (`GogoCompanyR/minhwa-member-app`), import into Vercel, add the two env variables, deploy.
Then set the Vercel URL as Site URL in Supabase Auth.

## How it works
- `/` weekly board (10 slots × week). Dots = members; 5 = "Full"; extra bookings show in navy.
- `/slot/[id]/[date]` who's coming + Book. Booking calls `book_seat()` in the database, which checks window/limits and creates a charge.
- `/pay/[bookingId]` opens Swish via deep link with number, amount and message pre-filled. "I have paid" → awaiting confirmation → admin marks paid.
- `/me` my seats, cancel (free until N days before — enforced in `cancel_booking()`).
- `/admin` week board with names + payment status; `/admin/settings` price, Swish number, rules, teachers, roles.

All rules live in the database functions (`sql/schema_v1.sql`), so the app can't bypass them.

## Next modules (same database)
- Shop: products / stock / orders → charges & payments already exist.
- Swish statement paste → auto-match payments to charges by phone + message.
