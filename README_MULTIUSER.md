# Multi-user setup (Google OAuth + Supabase)

This repo currently uses:
- MongoDB for the podcast generator (same as your existing setup)
- Supabase Postgres for multi-user login sessions + analytics + user profile lookup

## 1) Supabase
1. Create a Supabase project.
2. Run `supabase/migrations/001_multiuser_schema.sql` in the SQL editor.
3. Copy:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_DB_URL` (Database connection string)

## 2) Google Cloud Console
1. Create an OAuth client ID (Web application).
2. Set Authorized redirect URIs to:
   - `http://localhost:3000/auth/google/callback`
   - (and your production callback URL)

## 3) Backend env + run
1. Copy `backend/.env.example` to `backend/.env` and fill values.
2. Install deps and run:
   - `cd backend && npm install`
   - `npm run dev`

## Notes
- After login, the app will call `/auth/me` and then use `credentials: 'include'` for API calls.
- `/api/*` routes are currently guarded by `requireAuth` (401 will trigger the login UI).

