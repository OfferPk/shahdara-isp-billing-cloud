import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCustomerPortalLogoutHandler } from './handler.js';

Deno.serve(createCustomerPortalLogoutHandler({ env: Deno.env, createClient }));
