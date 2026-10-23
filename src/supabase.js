import { createClient } from '@supabase/supabase-js'
// Public (anon / publishable) key: fine in the browser. Writes only go through the huis_* RPC functions.
// Set both in .env.local (see .env.example) or in your hosting provider's environment variables.
const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (copy .env.example to .env.local)')
export const supabase = createClient(URL, KEY, { auth: { persistSession: false } })
export const resetDemo = null
