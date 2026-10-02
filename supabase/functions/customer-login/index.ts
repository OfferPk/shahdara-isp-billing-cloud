import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCustomerLoginHandler } from './handler.js';

Deno.serve(createCustomerLoginHandler({ env: Deno.env, createClient }));
