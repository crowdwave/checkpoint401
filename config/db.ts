import postgres from "npm:postgres@3.4.9";
import {env} from "./env.ts";

// Fail fast at startup with a clear message. Throwing here surfaces as
// "Error importing endpoint ..." from checkpoint401 and stops the server
// before it can serve a single request without a working user store.
if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in config/.env (see config/.env.example)");
}

// postgres.js consults the standard PG* environment variables even when
// the URL is complete, so under Deno's scoped env permission the process
// must be granted: --allow-env=PG* (Deno 2 wildcard syntax)
const sql = postgres(env.DATABASE_URL);

// checkpoint401 awaits this during graceful shutdown, after in-flight
// requests have drained. Do NOT install signal handlers or call
// Deno.exit() from config modules: that races the server's own shutdown
// and loses the final counter flush and in-flight responses.
export async function onShutdown(): Promise<void> {
  await sql.end({timeout: 5});
}

export default sql;
