import { createSyncAgentIngestHandler } from './handler.js';

// The handler validates its dedicated agent bearer secret because it is not a Supabase Auth JWT.
Deno.serve(createSyncAgentIngestHandler({ env: Deno.env, fetchImpl: fetch }));
