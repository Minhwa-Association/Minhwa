// A page's Supabase reads that came back with an error. Without this check a failed read looks like an empty
// list ("nobody booked") — as on 2026-10-12, when the v16 code was live before the v16 SQL had run.
type ReadError = { message: string; code?: string } | null | undefined;

/** true when any read failed. Each failure goes to the server log (Vercel → Logs) with the page and read name. */
export function loadFailed(page: string, reads: Record<string, ReadError>): boolean {
  let failed = false;
  for (const [name, e] of Object.entries(reads)) {
    if (!e) continue;
    failed = true;
    console.error(`[load] ${page} · ${name}: ${e.code ?? "?"} ${e.message}`);
  }
  return failed;
}
