import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * The app's own key (SUPABASE_SERVICE_ROLE_KEY) — used only on the server, for work that has no logged-in
 * user behind it: the inbound receipt route and the reading/reply that follows it.
 * Row-level security does not apply to this client, so keep its use small and explicit.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type ServiceClient = ReturnType<typeof createServiceClient>;
