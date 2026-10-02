import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPppoeAdminHandler } from '../_shared/pppoe-usage.js';

const env = { get: (name: string) => Deno.env.get(name) };
Deno.serve(createPppoeAdminHandler({ env, createClient }));
