import {loadSync} from "jsr:@std/dotenv@0.225.8";
import {join} from "jsr:@std/path@1.1.6";

// Resolve .env relative to this file rather than the process cwd, so
// the example works regardless of where the server is launched from.
// import.meta.dirname is a real filesystem path (unlike
// new URL(...).pathname, which is percent-encoded and breaks on
// directories containing spaces).
const envPath = join(import.meta.dirname!, ".env");

// export: false keeps the values out of Deno.env, so they stay private
// to the modules that import this one.
export const env: Record<string, string> = loadSync({envPath, export: false});
