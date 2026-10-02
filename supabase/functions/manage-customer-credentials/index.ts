import { createClient } from 'npm:@supabase/supabase-js@2';
import { createManageCustomerCredentialsHandler } from './handler.js';

Deno.serve(createManageCustomerCredentialsHandler({ env: Deno.env, createClient }));
