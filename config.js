// App configuration. Copy your values from Supabase: Project Settings > API.
// The anon key is safe to publish (row-level security protects the data). NEVER put the service_role key here.
window.CHORES_CONFIG = {
  backend: 'auto',                       // 'auto' = Supabase when the two values below are filled in, otherwise local mock
  supabaseUrl: 'https://rwbiizjwvyssdyxjuqan.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3Ymlpemp3dnlzc2R5eGp1cWFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTc0MDMsImV4cCI6MjEwNzg5MzQwM30.E5QFlaM434SRXo8ygcT_gmIfI2ntxQhxR20JAaaiOWk',
  cap: 300,                               // weekend cap in minutes (settings table overrides it when using Supabase)
};
