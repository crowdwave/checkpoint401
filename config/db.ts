import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";
import { DotenvConfig, config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

// Load environment variables
const env: DotenvConfig = config({ path: ".env" });

if (!env.DATABASE_URL) {
  console.log("env.DATABASE_URL invalid");
  Deno.exit(1);
}

const sql = postgres(env.DATABASE_URL);

const doShutdown = async () => {
  console.info("SIGTERM signal received, shutting down....");
  await sql.end({ timeout: 5 });
  Deno.exit();
};

const signals: Deno.Signal[] = ["SIGTERM", "SIGQUIT", "SIGINT"];
for (const signal of signals) {
  try {
    Deno.addSignalListener(signal, doShutdown);
  } catch (e) {
    console.log(`Warning could not init signal ${signal}`);
  }
}

export default sql;
