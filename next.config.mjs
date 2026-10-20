/** @type {import('next').NextConfig} */
const nextConfig = {
  // v17: the receipt PDF reads its fonts from lib/fonts at run time — make sure Vercel packs them with every
  // server function (pages' server actions make PDFs too, not only the /api/receipt route)
  outputFileTracingIncludes: { "/**/*": ["./lib/fonts/**/*"] },
  // v19.3: a page seen in the last 30 s opens at once when you go back to it (tabs, week arrows, back button).
  // Saving anything clears this — every action calls revalidatePath — so your own changes always show at once;
  // what other members change shows within 30 s (booking itself is always checked fresh by the database).
  experimental: { staleTimes: { dynamic: 30 } },
};
export default nextConfig;
