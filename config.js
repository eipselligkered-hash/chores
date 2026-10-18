// App configuration. Copy your values from Supabase: Project Settings > API.
// The anon key is safe to publish (row-level security protects the data). NEVER put the service_role key here.
window.CHORES_CONFIG = {
  backend: 'auto',                       // 'auto' = Supabase when the two values below are filled in, otherwise local mock
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
  cap: 300,                               // weekend cap in minutes (settings table overrides it when using Supabase)
};
