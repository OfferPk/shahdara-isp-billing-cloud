import { createClient } from 'npm:@supabase/supabase-js@2';
import { createChangeCustomerPasswordHandler } from './handler.js';

Deno.serve(createChangeCustomerPasswordHandler({ env: Deno.env, createClient }));
