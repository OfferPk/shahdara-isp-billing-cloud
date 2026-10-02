import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPppoeIngestHandler } from '../_shared/pppoe-usage.js';

const env = { get: (name: string) => Deno.env.get(name) };
Deno.serve(createPppoeIngestHandler({ env, createClient }));
