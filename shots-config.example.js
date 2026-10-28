/**
 * Copy to shots-config.js and fill in your Supabase project values.
 * The anon key is expected to be public (RLS enforces writes).
 */
window.SHOTS_CONFIG = {
  pitch: { width: 68, length: 105 },
  storageKey: "brighton-varsity-shot-tracker",
  // "dev" | "prod" — when "dev", the shell uses orange chrome + a DEV logo.
  // Omit to infer from supabaseUrl (DEV ref fmiymqnfezkqagpbrmoi).
  env: "dev",
  brandName: "Brighton Bengals",
  brandSub: "Shot Tracker",
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_ANON_PUBLIC_KEY",
  pin: "KEPPA"
};
