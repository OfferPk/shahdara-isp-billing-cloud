import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCustomerPortalDataHandler } from './handler.js';

Deno.serve(createCustomerPortalDataHandler({ env: Deno.env, createClient }));
