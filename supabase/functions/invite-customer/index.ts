import { createClient } from 'npm:@supabase/supabase-js@2';
import { createInviteHandler } from './handler.js';

Deno.serve(createInviteHandler({ env: Deno.env, createClient }));
