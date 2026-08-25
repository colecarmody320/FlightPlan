import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://pqamqgxqftxxnzbqcgxq.supabase.co";
const supabaseKey = "sb_publishable_GqHEIWAvc8gj1rr1SijQnA_HyLmQKBh";

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
