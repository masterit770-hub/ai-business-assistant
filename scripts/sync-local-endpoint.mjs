// Upsert the Local-model endpoint (and model) into engine_settings via the Supabase
// service role, so the deployed app's Local mode always points at the live tunnel —
// even after the tunnel restarts with a new URL. Reads creds from process.env
// (the supervisor sources .secrets/supabase.env). Never prints the key.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const endpoint = process.argv[2]; // e.g. https://xxx.trycloudflare.com/v1
const model = process.argv[3] || "qwen2.5:1.5b";
if (!url || !key || !endpoint) {
  console.error("missing SUPABASE_URL / SERVICE_ROLE_KEY / endpoint arg");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { error } = await sb
  .from("engine_settings")
  .upsert(
    [
      { key: "local_endpoint", value: endpoint },
      { key: "local_model", value: model },
    ],
    { onConflict: "key" }
  );
if (error) {
  console.error("upsert failed:", error.message);
  process.exit(1);
}
console.log("synced local_endpoint=" + endpoint + " local_model=" + model);
