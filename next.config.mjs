/** @type {import('next').NextConfig} */
const nextConfig = {
  // v17: the receipt PDF reads its fonts from lib/fonts at run time — make sure Vercel packs them with every
  // server function (pages' server actions make PDFs too, not only the /api/receipt route)
  outputFileTracingIncludes: { "/**/*": ["./lib/fonts/**/*"] },
};
export default nextConfig;
