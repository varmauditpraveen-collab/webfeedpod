const { createClient } = require('@supabase/supabase-js');

let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return supabaseClient;
}

async function getUserById(userId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertUserFromGoogle(profile) {
  const supabase = getSupabase();
  const googleSub = profile?.id;
  const email = profile?.emails?.[0]?.value ?? null;
  const name = profile?.displayName ?? null;
  const avatarUrl = profile?.photos?.[0]?.value ?? null;

  if (!googleSub) throw new Error('Google profile missing id');

  const row = {
    google_sub: googleSub,
    email,
    name,
    avatar_url: avatarUrl,
  };

  const { data, error } = await supabase
    .from('users')
    .upsert(row, { onConflict: 'google_sub' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function logAnalyticsEvent({ userId, eventName, eventProperties }) {
  const supabase = getSupabase();
  const { error } = await supabase.from('analytics_events').insert({
    user_id: userId,
    event_name: eventName,
    event_properties: eventProperties || {},
  });
  if (error) throw error;
}

async function getAnalyticsStats({ userId, days = 7 }) {
  const supabase = getSupabase();
  // Keep this simple: group counts by event_name for the last N days.
  const { data, error } = await supabase
    .from('analytics_events')
    .select('event_name, created_at')
    .eq('user_id', userId)
    .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  if (error) throw error;

  const counts = {};
  for (const row of data || []) {
    counts[row.event_name] = (counts[row.event_name] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([eventName, count]) => ({ eventName, count }))
    .sort((a, b) => b.count - a.count);
}

async function getRecentAnalyticsEvents({ userId, limit = 20 }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('analytics_events')
    .select('event_name,event_properties,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getUserById,
  upsertUserFromGoogle,
  logAnalyticsEvent,
  getAnalyticsStats,
  getRecentAnalyticsEvents,
};

