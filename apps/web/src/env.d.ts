/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://abcd.supabase.co. Absent = offline guest mode. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon (public) key. Absent = offline guest mode. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
