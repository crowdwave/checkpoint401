import {DB} from "https://deno.land/x/sqlite@v3.9.1/mod.ts";
import {join, resolve, toFileUrl} from "jsr:@std/path@1.1.6";

const VERSION: number = 5;

/*
Requires Deno 2.x.

to run (from inside your config directory, with the stats DB kept there):
cd config
deno run \
  --allow-net=127.0.0.1:3000 \
  --allow-read=. \
  --allow-write=. \
  --allow-env=PORT,LISTEN_ADDRESS \
  ../checkpoint401.ts

Note that --allow-write must cover the DIRECTORY holding the stats DB,
not just the DB file: SQLite also creates journal files beside it.
Pass --disable-stats to need no write permission at all.

to compile:
deno compile checkpoint401.ts

Run with --help for the full list of flags. The set is also documented
in displayHelp() below; both must be kept in sync with parseArgs().
 */

// Third argument is an AbortSignal that fires when --endpoint-timeout-ms
// elapses. Endpoint functions should pass it to fetch()/DB calls so a
// timed-out request also cancels the underlying work. It is optional so
// two-argument endpoints written for earlier versions keep working.
type TimerId = ReturnType<typeof setTimeout>;

type EndpointResult = { success: boolean; errorMessage?: string; };
type EndpointFunction = (req: Request, match: URLPatternResult | null, signal?: AbortSignal) => Promise<EndpointResult>;

// Any module loaded from the config directory may export this. It is
// awaited during graceful shutdown, after in-flight requests drain and
// before the process exits, so helpers can close DB pools etc. Modules
// must NOT install their own signal handlers or call Deno.exit().
type ShutdownHook = () => void | Promise<void>;

interface RouteItem {
    method: string;
    routeURLPattern: string;
    routeEndpointTypeScriptFile: string;
    passCount: number;
    failCount: number;
}

function errMsg(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function errName(error: unknown): string {
    if (error instanceof Error) return error.name;
    return typeof error;
}

// Replace any control character that could break log line framing
// (CR, LF, NUL, plus other C0 controls) with a safe placeholder.
// Anything containing these in a log line would otherwise let a
// caller forge fake log entries by injecting the bytes into the
// inbound URI or method header.
// Also truncates: error text can embed request-derived strings (a
// database error quoting a bad parameter, for instance), and the
// forwarded URI alone may be 8KB.
const MAX_LOG_FIELD = 512;
function sanitizeForLog(s: string, max = MAX_LOG_FIELD): string {
    // Stack traces keep their newlines (max > MAX_LOG_FIELD callers);
    // everything else is forced onto one line.
    const cleaned = max > MAX_LOG_FIELD
        ? s.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "?")
        : s.replace(/[\x00-\x1f\x7f]/g, "?");
    return cleaned.length > max ? cleaned.slice(0, max) + "...[truncated]" : cleaned;
}

class DatabaseManager {
    private db: DB;

    constructor(dbFilename: string) {
        this.db = new DB(dbFilename);
    }

    createTableIfNotExists() {
        // Propagate failure rather than swallowing it: if the stats
        // table can't be created (read-only filesystem, locked DB,
        // disk full) the server is in a broken state and should fail
        // fast at startup rather than serve traffic with no working
        // stats DB.
        this.db.query(`
            CREATE TABLE IF NOT EXISTS route_stats_counters
            (
                method    TEXT    NOT NULL,
                route     TEXT    NOT NULL,
                passCount INTEGER NOT NULL DEFAULT 0,
                failCount INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (method, route)
            )
        `);
        console.log("Table route_stats_counters created or already exists.");
    }

    // Methods are stored uppercased since v5. Databases written by
    // earlier versions may hold rows keyed by the method exactly as it
    // appeared in routes.json (e.g. 'get'); fold those into the
    // uppercase row so historical counts are not orphaned.
    migrateMethodCase() {
        this.db.query("BEGIN");
        try {
            this.db.query(`
                INSERT OR IGNORE INTO route_stats_counters (method, route, passCount, failCount)
                SELECT UPPER(method), route, 0, 0 FROM route_stats_counters WHERE method != UPPER(method)
            `);
            this.db.query(`
                UPDATE route_stats_counters
                SET passCount = passCount + (SELECT COALESCE(SUM(l.passCount), 0) FROM route_stats_counters l
                                             WHERE l.route = route_stats_counters.route AND UPPER(l.method) = route_stats_counters.method AND l.method != route_stats_counters.method),
                    failCount = failCount + (SELECT COALESCE(SUM(l.failCount), 0) FROM route_stats_counters l
                                             WHERE l.route = route_stats_counters.route AND UPPER(l.method) = route_stats_counters.method AND l.method != route_stats_counters.method)
                WHERE method = UPPER(method)
            `);
            this.db.query("DELETE FROM route_stats_counters WHERE method != UPPER(method)");
            this.db.query("COMMIT");
        } catch (error) {
            this.db.query("ROLLBACK");
            throw error;
        }
    }

    insertInitialStats(routes: RouteItem[]) {
        // Propagates failure for the same reason as createTableIfNotExists:
        // if the rows don't exist, every later UPDATE silently matches
        // nothing and the stats feature is broken without any signal.
        this.migrateMethodCase();
        const insertStmt = `
            INSERT OR IGNORE INTO route_stats_counters (method, route, passCount, failCount)
            VALUES (?, ?, 0, 0)
        `;
        for (const routeConfig of routes) {
            this.db.query(insertStmt, [routeConfig.method, routeConfig.routeURLPattern]);
        }
        console.log("Initial stats inserted into database.");
    }

    updateDatabase(routes: RouteItem[]) {
        const updateStmt = `
            UPDATE route_stats_counters
            SET passCount = passCount + ?,
                failCount = failCount + ?
            WHERE method = ?
              AND route = ?
        `;

        // Wrap the per-route updates in a single transaction so a
        // failure on the Nth row rolls back rows 1..N-1 instead of
        // committing a partial flush. Re-throw on failure so the
        // caller can fold the snapshot back into the in-memory
        // counters and try again on the next tick.
        this.db.query("BEGIN");
        try {
            for (const routeConfig of routes) {
                this.db.query(updateStmt, [routeConfig.passCount, routeConfig.failCount, routeConfig.method, routeConfig.routeURLPattern]);
            }
            this.db.query("COMMIT");
        } catch (error) {
            this.db.query("ROLLBACK");
            throw error;
        }
    }

    close() {
        this.db.close();
    }
}

interface LoadedModules {
    shutdownHooks: Array<{ name: string; hook: ShutdownHook }>;
    seen: Set<string>;
}

function collectShutdownHook(module: Record<string, unknown>, name: string, loaded: LoadedModules) {
    // A file referenced by several routes is imported (from cache) once
    // per route; register its hook only once.
    if (loaded.seen.has(name)) return;
    loaded.seen.add(name);
    if (typeof module.onShutdown === "function") {
        loaded.shutdownHooks.push({name, hook: module.onShutdown as ShutdownHook});
    }
}

async function importConfigFile(configDir: string, fileName: string): Promise<Record<string, unknown>> {
    // Build a file: URL from the absolute config-dir path so the import
    // resolves against the CONFIG directory, never against this script's
    // location or the process cwd (which differ under --config-dir).
    const url = toFileUrl(join(configDir, fileName)).href;
    return await import(url);
}

async function loadAdditionalTsFiles(
    applicationOptions: ApplicationOptions,
    routeItems: RouteItem[],
    loaded: LoadedModules,
): Promise<void> {
    const excludeFiles = new Set(routeItems.map((route) => route.routeEndpointTypeScriptFile));
    const directory = Deno.readDir(applicationOptions.configDir);
    console.log(`Importing non-router TypeScript files from ${applicationOptions.configDir}`);
    let totalImported = 0;
    for await (const dirEntry of directory) {
        if (dirEntry.isFile && dirEntry.name.endsWith('.ts') && !excludeFiles.has(dirEntry.name)) {
            try {
                const module = await importConfigFile(applicationOptions.configDir, dirEntry.name);
                collectShutdownHook(module, dirEntry.name, loaded);
                totalImported++;
                console.log(`File ${dirEntry.name} loaded successfully.`);
            } catch (error) {
                // A helper that fails to import means some endpoint will
                // misbehave at request time. Fail fast at startup instead.
                throw new Error(`Error importing non-router file '${dirEntry.name}': ${errMsg(error)}`);
            }
        }
    }
    if (totalImported === 0) {
        console.log(`No non-router TypeScript files found in ${applicationOptions.configDir}`);
    }
}

function parseRoutesJson(routesJson: string): RouteItem[] {
    const parsed: unknown = JSON.parse(routesJson);
    if (!Array.isArray(parsed)) {
        throw new Error("routes.json must be a JSON array of route objects.");
    }
    if (parsed.length === 0) {
        console.warn("WARNING: routes.json is empty. Every request will receive 404 (deny). Add at least one route to enable the server.");
    }
    const seen = new Set<string>();
    return parsed.map((entry, index) => {
        if (entry === null || typeof entry !== "object") {
            throw new Error(`routes.json entry at index ${index} must be an object.`);
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.method !== "string" || e.method.length === 0) {
            throw new Error(`routes.json entry at index ${index} is missing required string field 'method'.`);
        }
        if (typeof e.routeURLPattern !== "string" || e.routeURLPattern.length === 0) {
            throw new Error(`routes.json entry at index ${index} is missing required string field 'routeURLPattern'.`);
        }
        if (typeof e.routeEndpointTypeScriptFile !== "string" || e.routeEndpointTypeScriptFile.length === 0) {
            throw new Error(`routes.json entry at index ${index} is missing required string field 'routeEndpointTypeScriptFile'.`);
        }
        const endpointFileName = e.routeEndpointTypeScriptFile;
        // routes.json supplies a flat filename. Reject anything that
        // could escape the config directory or look like an absolute
        // path - if routes.json is ever attacker-controlled, this
        // turns "import the auth function" into "import any .ts on
        // disk".
        if (endpointFileName.includes("/") || endpointFileName.includes("\\")
            || endpointFileName.includes("..") || endpointFileName.includes("\0")) {
            throw new Error(`Invalid routeEndpointTypeScriptFile '${endpointFileName}' at index ${index}: must be a flat filename in the config directory.`);
        }
        // Methods are matched case-insensitively at request time, so
        // store them uppercased: that keeps the stats DB key consistent
        // and makes the duplicate check below exact.
        const method = e.method.toUpperCase();
        const key = `${method} ${e.routeURLPattern}`;
        if (seen.has(key)) {
            // First match wins at request time, so the later entry can
            // never be reached. Almost certainly a config mistake.
            throw new Error(`routes.json entry at index ${index} duplicates an earlier route (${key}); the later entry would be unreachable.`);
        }
        seen.add(key);
        return {
            method,
            routeURLPattern: e.routeURLPattern,
            routeEndpointTypeScriptFile: endpointFileName,
            passCount: 0,
            failCount: 0,
        };
    });
}

async function setupRoutes(
    applicationOptions: ApplicationOptions,
    loaded: LoadedModules,
): Promise<{ router: URLPatternRouter; routeItems: RouteItem[] }> {
    try {
        const routesJson = await Deno.readTextFile(join(applicationOptions.configDir, "routes.json"));
        const routeItems = parseRoutesJson(routesJson);
        const urlPatternRouter: URLPatternRouter = new URLPatternRouter(applicationOptions)
        for (const routeConfig of routeItems) {
            const endpointFileName = routeConfig.routeEndpointTypeScriptFile;
            try {
                const endpointModule = await importConfigFile(applicationOptions.configDir, endpointFileName);
                if (typeof endpointModule.default !== "function") {
                    throw new Error(`The file '${endpointFileName}' does not export a default function.`);
                }
                collectShutdownHook(endpointModule, endpointFileName, loaded);
                const endpointFunctionProxy = createEndpointFunctionProxy(endpointModule.default as EndpointFunction, routeConfig, applicationOptions);
                urlPatternRouter.addRoute(routeConfig.method, routeConfig.routeURLPattern, endpointFunctionProxy);
                console.log(`Loaded route ${routeConfig.method} ${routeConfig.routeURLPattern} -> ${endpointFileName}`);
            } catch (error) {
                throw new Error(`Error importing endpoint '${endpointFileName}': ${errMsg(error)}`);
            }
        }
        return {router: urlPatternRouter, routeItems};
    } catch (error) {
        // Re-throw with a context-prefixed message; runServer's catch
        // is the single layer that logs the failure to stderr, which
        // avoids the double-log we used to produce here.
        throw new Error(`Failed to set up routes: ${errMsg(error)}`);
    }
}

function snapshotAndClear(routes: RouteItem[]): RouteItem[] {
    // Snapshot then clear before writing, so any increments that
    // land while the write is in flight are preserved for the next
    // flush rather than zeroed.
    const snapshot = routes.map(route => ({...route}));
    for (const route of routes) {
        route.passCount = 0;
        route.failCount = 0;
    }
    return snapshot;
}

function flushCounters(dbManager: DatabaseManager, routes: RouteItem[]): void {
    const snapshot = snapshotAndClear(routes);
    try {
        dbManager.updateDatabase(snapshot);
    } catch (error) {
        // The write failed. Fold the snapshot's counts back into
        // the live counters so they aren't lost - the next flush
        // will retry.
        for (let i = 0; i < routes.length; i++) {
            routes[i].passCount += snapshot[i].passCount;
            routes[i].failCount += snapshot[i].failCount;
        }
        throw error;
    }
}

type ResponseStatus = 200 | 401 | 404 | 503;

const makeResponse = (
    statusCode: ResponseStatus,
    applicationOptions: ApplicationOptions,
    request: Request,
    URLPatternPathname: string | null,
    errorMessage?: string,
): Response => {
    if (applicationOptions.verbose) {
        // Log the path only. The query string can carry tokens or PII.
        const url = request.url;
        const q = url.indexOf("?");
        const pathOnly = q === -1 ? url : url.slice(0, q);
        console.log(`[${new Date().toISOString()}] status: ${statusCode} method: ${sanitizeForLog(request.method)} pattern: ${URLPatternPathname} path: ${sanitizeForLog(pathOnly)}`);
    }
    const includeBody = statusCode === 401 && errorMessage && !applicationOptions.suppressErrorBody;
    const body = includeBody ? JSON.stringify({error: errorMessage}) : null;
    // RFC 7235 requires a 401 to include WWW-Authenticate. Most reverse
    // proxies translate the auth response into their own challenge and
    // ignore this, but emit a generic value for spec conformance.
    const headers: HeadersInit | undefined =
        statusCode === 401 ? {"WWW-Authenticate": "Bearer realm=\"checkpoint401\""}
            : statusCode === 503 ? {"Retry-After": "1"}
                : undefined;
    return new Response(body, {status: statusCode, headers});
}

interface RouteEntry {
    pattern: URLPattern;
    method: string;
    endpointFunction: EndpointFunction,
}

// URLPattern requires a base URL to resolve a path-only string. We
// only care about the pathname match, so any syntactically-valid URL
// works. Hoisted to module scope so it isn't re-allocated on every
// route iteration of every request.
const URL_PATTERN_BASE = "http://www.example.org";

function getRequiredHeader(request: Request, headerName: string): string {
    const value = request.headers.get(headerName);
    if (value === null) {
        throw new Error(`AUTH: ${headerName} not found in headers`);
    }
    return value;
}

class URLPatternRouter {
    private routes: RouteEntry[] = [];
    private applicationOptions: ApplicationOptions;

    constructor(applicationOptions: ApplicationOptions) {
        this.applicationOptions = applicationOptions;
    }

    addRoute(
        method: string,
        routeURLPattern: string,
        endpointFunction: EndpointFunction,
    ) {
        let pattern: URLPattern;
        try {
            pattern = new URLPattern({pathname: routeURLPattern});
        } catch (error) {
            throw new Error(`Invalid routeURLPattern '${routeURLPattern}' for ${method}: ${errMsg(error)}`);
        }
        this.routes.push(
            {pattern, method: method.toUpperCase(), endpointFunction}
        );
    }

    async handleRequest(request: Request) {
        try {
            const requestMethod = request.method.toUpperCase();
            for (const route of this.routes) {
                if (requestMethod !== route.method) continue;
                const match = route.pattern.exec(request.url, URL_PATTERN_BASE);
                if (match === null) continue;
                const result = await route.endpointFunction(request, match);
                if (result.success) {
                    return makeResponse(200, this.applicationOptions, request, route.pattern.pathname);
                } else {
                    return makeResponse(401, this.applicationOptions, request, route.pattern.pathname, result.errorMessage);
                }
            }
            return makeResponse(404, this.applicationOptions, request, null);
        } catch (error) {
            console.error('Error handling request:', sanitizeForLog(errMsg(error)));
            return makeResponse(401, this.applicationOptions, request, null);
        }
    }
}

// Live evaluations: requests currently being handled plus endpoint
// invocations that outlived their timeout and are still running. The
// --max-in-flight cap is applied to this number so that abandoned
// endpoints keep occupying a slot until they actually settle.
const concurrency = {live: 0};

// Native error classes signal a bug in endpoint code rather than a
// deliberate denial; those are worth a stack trace.
function isProgrammingError(error: unknown): boolean {
    return error instanceof TypeError || error instanceof RangeError
        || error instanceof ReferenceError || error instanceof SyntaxError;
}

// Wraps each endpoint: enforces the return-value contract, applies the
// execution timeout, keeps the pass/fail counters, and converts every
// failure mode (throw, bad shape, timeout) into a denial.
function createEndpointFunctionProxy(fn: EndpointFunction, routeConfig: RouteItem, applicationOptions: ApplicationOptions): EndpointFunction {
    return async (req: Request, match: URLPatternResult | null): Promise<EndpointResult> => {
        const controller = new AbortController();
        let timeoutId: TimerId | undefined;
        let timedOut = false;
        // Call inside a promise so a synchronous throw is handled the
        // same way as a rejection, and so the promise exists before the
        // race for the timeout bookkeeping below.
        const work: Promise<unknown> = new Promise((resolve) => resolve(fn(req, match, controller.signal)));
        try {
            let result: unknown;
            if (applicationOptions.endpointTimeoutMs > 0) {
                // Race the endpoint against a timeout so a hung handler
                // can't tie up a request slot indefinitely. Fail-closed:
                // timeout becomes a denied auth. The AbortSignal handed
                // to the endpoint is fired too, so cooperative endpoints
                // can cancel their underlying fetch/DB work.
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        timedOut = true;
                        controller.abort();
                        reject(new Error(`Endpoint timed out after ${applicationOptions.endpointTimeoutMs}ms`));
                    }, applicationOptions.endpointTimeoutMs);
                });
                result = await Promise.race([work, timeoutPromise]);
            } else {
                result = await work;
            }
            if (result === null || typeof result !== "object"
                || typeof (result as EndpointResult).success !== "boolean"
                || ((result as EndpointResult).errorMessage !== undefined && typeof (result as EndpointResult).errorMessage !== "string")) {
                throw new Error(`YOUR TYPESCRIPT ENDPOINT FUNCTION DID NOT RETURN AN OBJECT WITH A BOOLEAN 'success' PROPERTY AND AN OPTIONAL 'errorMessage' STRING PROPERTY! Method: ${routeConfig.method}, Route: ${routeConfig.routeURLPattern}, File: ${routeConfig.routeEndpointTypeScriptFile}`);
            }
            const typed = result as EndpointResult;
            if (typed.success) routeConfig.passCount++; else routeConfig.failCount++;
            return typed;
        } catch (error) {
            // Every failure mode is a denial and counts as one. Log a
            // single sanitised line rather than a stack trace: an
            // unauthenticated caller can trigger this on every request.
            // Programming errors (TypeError etc.) are not request-derived
            // and need their stack to be found, so those get it; so does
            // everything else under --verbose.
            routeConfig.failCount++;
            const stamp = new Date().toISOString();
            console.error(`[${stamp}] endpoint ${routeConfig.routeEndpointTypeScriptFile} failed: ${sanitizeForLog(errName(error))}: ${sanitizeForLog(errMsg(error))}`);
            if ((isProgrammingError(error) || applicationOptions.verbose) && error instanceof Error && error.stack) {
                console.error(sanitizeForLog(error.stack, 4000));
            }
            return {success: false, errorMessage: "Unknown auth error"};
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            if (timedOut) {
                // The request is answered, but the endpoint is still
                // running. Keep it counted against --max-in-flight until
                // it settles, and swallow its eventual outcome.
                concurrency.live++;
                work.then(() => {}, () => {}).finally(() => { concurrency.live--; });
            }
        }
    };
}

function displayHelp() {
    console.log(`
      Server usage:

      checkpoint401 [--config-dir <dir>] [--db-filename <path>] [--update-period <ms>] [--disable-stats] [--verbose] [--quiet] [--version] [--help] [--port <n>] [--listen-address <addr>] [--header-name-uri <name>] [--header-name-method <name>] [--strict-uri] [--no-strict-uri] [--allow-encoded-path] [--no-error-body] [--endpoint-timeout-ms <ms>] [--shutdown-timeout-ms <ms>] [--max-in-flight <n>]

      --config-dir: Directory containing routes.json, the endpoint files and any helper .ts files (default: current directory)
      --db-filename: Path to the SQLite stats database (default: route_stats_counters.db in the current directory). The DIRECTORY must be writable: SQLite creates journal files beside the DB.
      --update-period: Period in milliseconds to flush counters to the database (default: 10000)
      --disable-stats: Disable the stats feature entirely. No database is opened or created, so no write permission is needed.
      --verbose: Enable per-request logging (status, method, matched pattern, request path without query string). Off by default.
      --quiet: Disable per-request logging (the default; kept for compatibility).
      --version: Display server version
      --help: Show help message
      --port: Port number to listen on (default: 3000 or PORT environment variable). If both are set, the server will exit with an error.
      --listen-address: Address to listen on (default: 127.0.0.1 or LISTEN_ADDRESS environment variable). If both are set, the server will exit with an error.
      --header-name-uri: Name of the header carrying the original request URI (default: X-Forwarded-Uri)
      --header-name-method: Name of the header carrying the original request method (default: X-Forwarded-Method)
      --strict-uri: Reject inbound URI values that are not '/'-prefixed paths, start with '//', or contain backslashes, dot segments, '#', control bytes, or percent-encoded forms of any of those. ON by default; this flag is accepted for compatibility.
      --no-strict-uri: Turn the above off. Only do this if your proxy sends something other than a plain request path and you understand the parser-differential risk.
      --allow-encoded-path: Keep strict mode but permit percent-encoded '/', '\\', '#' and '%' in path segments, for backends whose routes legitimately carry them (e.g. 'group%2Fproject' ids). Only enable it if you have confirmed your backend does not decode and re-split the path. Encoded control bytes and '%2e' stay refused.
      --no-error-body: Do not include the endpoint's errorMessage in 401 response bodies. Off by default. Recommended if your reverse proxy forwards the auth response body to clients or error pages, since distinct error strings can enable user enumeration.
      --endpoint-timeout-ms: Maximum time (ms) an endpoint function may run before the request is failed-closed (returned as 401) and the endpoint's AbortSignal fires (default: 10000). 0 disables.
      --shutdown-timeout-ms: On SIGTERM/SIGINT, how long (ms) to wait for in-flight requests to drain before flushing counters and exiting anyway (default: 10000). A second signal exits immediately.
      --max-in-flight: Maximum concurrent requests being evaluated (default: 1024). Requests above the limit get 503 without running any endpoint. 0 disables.

      **Configuration Files:**

      - routes.json: This file defines the routes for the server. It should be a JSON array with each object containing the following properties:
          - method: HTTP method (GET, POST, etc.)
          - routeURLPattern: A URL Pattern API pathname pattern (https://developer.mozilla.org/en-US/docs/Web/API/URLPattern)
          - routeEndpointTypeScriptFile: Flat filename (no '/' or '..') of the TypeScript endpoint handler, located in the config directory.

      - <config-dir>/<file_name>.ts: Each endpoint TypeScript file must export a default async function with signature:
          (req: Request, match: URLPatternResult | null, signal?: AbortSignal) => Promise<{ success: boolean; errorMessage?: string }>
        Any other .ts file in the config directory is also imported on startup so endpoints can share helpers.
        An endpoint file or a top-level .ts file in the config directory may export 'onShutdown(): Promise<void> | void'; it is awaited during graceful shutdown. Files in subdirectories are not scanned, so put hooks in top-level files. Modules must not install signal handlers or call Deno.exit().
  `);
}

interface ApplicationOptions {
    configDir: string;
    dbFilename: string;
    disableStats: boolean;
    hostname: string;
    port: number;
    updatePeriod: number;
    verbose: boolean;
    headerNameUri: string;
    headerNameMethod: string;
    strictUri: boolean;
    allowEncodedPath: boolean;
    suppressErrorBody: boolean;
    endpointTimeoutMs: number; // 0 disables the timeout.
    shutdownTimeoutMs: number;
    maxInFlight: number; // 0 disables the cap.
}

function printApplicationOptions(options: ApplicationOptions) {
    for (const [key, value] of Object.entries(options)) {
        console.log(`${key}: ${value}`);
    }
}

function parseArgs(args: string[]): ApplicationOptions {
    const applicationOptions: ApplicationOptions = {
        dbFilename: "route_stats_counters.db",
        configDir: Deno.cwd(),
        disableStats: false,
        hostname: `127.0.0.1`,
        port: 3000,
        updatePeriod: 10000,
        verbose: false,
        headerNameUri: "X-Forwarded-Uri",
        headerNameMethod: "X-Forwarded-Method",
        strictUri: true,
        allowEncodedPath: false,
        suppressErrorBody: false,
        endpointTimeoutMs: 10000,
        shutdownTimeoutMs: 10000,
        maxInFlight: 1024,
    };

    const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout int32 limit; larger values fire immediately.

    function fail(message: string): never {
        console.error(`Error: ${message}`);
        Deno.exit(1);
    }

    function parseInteger(source: string, raw: string, min: number, max: number): number {
        // Number() accepts "3000.5", "0x1000", " 3000 " and "1e3"; a
        // port or millisecond count should be a plain decimal integer.
        if (!/^\d+$/.test(raw)) {
            fail(`${source} requires a plain decimal integer, got '${raw}'.`);
        }
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            fail(`${source} must be between ${min} and ${max}, got '${raw}'.`);
        }
        return parsed;
    }

    const validatePort = (raw: string, source = "--port") => parseInteger(source, raw, 1, 65535);

    let portFromCli = false;
    let hostnameFromCli = false;
    let verboseFromCli = false;
    let quietFromCli = false;
    let strictFromCli = false;
    let noStrictFromCli = false;

    function takeValue(i: number, flag: string, what: string): string {
        if (i + 1 >= args.length) fail(`${flag} option requires ${what}.`);
        return args[i + 1];
    }

    const seenFlags = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            if (seenFlags.has(arg)) fail(`${arg} was passed more than once.`);
            seenFlags.add(arg);
        }
        switch (arg) {
            case "--version":
                printVersion()
                Deno.exit(0);
                break;
            case "--verbose":
                applicationOptions.verbose = true;
                verboseFromCli = true;
                break;
            case "--quiet":
                applicationOptions.verbose = false;
                quietFromCli = true;
                break;
            case "--strict-uri":
                applicationOptions.strictUri = true;
                strictFromCli = true;
                break;
            case "--no-strict-uri":
                applicationOptions.strictUri = false;
                noStrictFromCli = true;
                break;
            case "--allow-encoded-path":
                applicationOptions.allowEncodedPath = true;
                break;
            case "--no-error-body":
                applicationOptions.suppressErrorBody = true;
                break;
            case "--endpoint-timeout-ms":
                applicationOptions.endpointTimeoutMs = parseInteger(arg, takeValue(i, arg, "a number of milliseconds"), 0, MAX_TIMER_MS);
                i++;
                break;
            case "--shutdown-timeout-ms":
                applicationOptions.shutdownTimeoutMs = parseInteger(arg, takeValue(i, arg, "a number of milliseconds"), 0, MAX_TIMER_MS);
                i++;
                break;
            case "--max-in-flight":
                applicationOptions.maxInFlight = parseInteger(arg, takeValue(i, arg, "a request count"), 0, Number.MAX_SAFE_INTEGER);
                i++;
                break;
            case "--db-filename":
                applicationOptions.dbFilename = takeValue(i, arg, "a database filename");
                i++;
                break;
            case "--update-period":
                applicationOptions.updatePeriod = parseInteger(arg, takeValue(i, arg, "a number of milliseconds"), 1000, MAX_TIMER_MS);
                i++;
                break;
            case "--disable-stats":
                applicationOptions.disableStats = true;
                break;
            case "--port":
                applicationOptions.port = validatePort(takeValue(i, arg, "a port number"));
                portFromCli = true;
                i++;
                break;
            case "--listen-address":
                applicationOptions.hostname = takeValue(i, arg, "an address");
                hostnameFromCli = true;
                i++;
                break;
            case "--header-name-uri":
                applicationOptions.headerNameUri = takeValue(i, arg, "a header name");
                i++;
                break;
            case "--header-name-method":
                applicationOptions.headerNameMethod = takeValue(i, arg, "a header name");
                i++;
                break;
            case "--config-dir":
                applicationOptions.configDir = takeValue(i, arg, "a directory path");
                i++;
                break;
            case "--help":
                displayHelp();
                Deno.exit(0);
                break;
            default:
                fail(`Unknown argument: ${arg}`);
        }
    }

    // Track whether the CLI explicitly set port/hostname rather than
    // comparing against the default sentinel - otherwise passing
    // --port 3000 (or --listen-address 127.0.0.1) alongside the env
    // var was indistinguishable from "not set on CLI" and the conflict
    // check silently skipped.
    const envPort = Deno.env.get("PORT");
    if (portFromCli && envPort) fail("Both command-line argument and environment variable are set for port.");

    const envhostname = Deno.env.get("LISTEN_ADDRESS");
    if (hostnameFromCli && envhostname) fail("Both command-line argument and environment variable are set for listen address.");

    // If only environment variables are set, apply them
    if (!portFromCli && envPort) applicationOptions.port = validatePort(envPort, "PORT environment variable");
    if (!hostnameFromCli && envhostname) applicationOptions.hostname = envhostname;

    if (verboseFromCli && quietFromCli) fail("--verbose and --quiet are mutually exclusive.");
    if (strictFromCli && noStrictFromCli) fail("--strict-uri and --no-strict-uri are mutually exclusive.");

    // Header names must be non-empty token chars per RFC 7230, and the
    // URI and method headers must differ - otherwise both reads return
    // the same value and the router can never match.
    const httpTokenChars = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    if (!httpTokenChars.test(applicationOptions.headerNameUri)) {
        fail(`--header-name-uri '${applicationOptions.headerNameUri}' is not a valid HTTP header name.`);
    }
    if (!httpTokenChars.test(applicationOptions.headerNameMethod)) {
        fail(`--header-name-method '${applicationOptions.headerNameMethod}' is not a valid HTTP header name.`);
    }
    if (applicationOptions.headerNameUri.toLowerCase() === applicationOptions.headerNameMethod.toLowerCase()) {
        fail(`--header-name-uri and --header-name-method must differ (both set to '${applicationOptions.headerNameUri}').`);
    }

    // Resolve the config dir to an absolute, existing directory once,
    // so file reads and dynamic imports agree on where it is
    // regardless of cwd or this script's location.
    try {
        applicationOptions.configDir = Deno.realPathSync(resolve(applicationOptions.configDir));
        if (!Deno.statSync(applicationOptions.configDir).isDirectory) throw new Error("not a directory");
    } catch (error) {
        fail(`--config-dir '${applicationOptions.configDir}' is not a readable directory: ${errMsg(error)}`);
    }

    return applicationOptions;
}


function printVersion() {
    console.log(`checkpoint401 version ${VERSION}`);
}

// Structural checks against the value the proxy passed in via
// X-Forwarded-Uri. The URL parser behind URLPattern (WHATWG) is
// lenient: it turns '\' into '/', resolves '.' and '..' segments, and
// accepts absolute and protocol-relative URLs. The reverse proxy
// forwards the RAW URI to the backend, whose parser may disagree, so
// anything the two could interpret differently is rejected here
// rather than authorised on our interpretation. Also rejects control
// bytes, raw or percent-encoded, which otherwise reach log lines and
// error messages via match groups.
// Percent-encoded control bytes, '.', '/', '\\', '#' and '%' itself:
// all of these change meaning between a decoding parser and a
// non-decoding one. '%25' is included because a backend that decodes
// twice turns '%252e%252e' into '..' after this server has already
// authorised the literal form.
const PERCENT_ENCODED_RISKY = /%(0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c|23|25)/i;

function validateInboundUri(uri: string, allowEncodedPath: boolean): void {
    if (uri.length === 0 || uri.length > 8192) {
        throw new Error("AUTH: inbound URI is empty or too long");
    }
    if (!uri.startsWith("/")) {
        throw new Error("AUTH: inbound URI must start with '/'");
    }
    if (uri.startsWith("//")) {
        throw new Error("AUTH: inbound URI must not start with '//' (protocol-relative URL)");
    }
    if (/[\x00-\x1f\x7f]/.test(uri)) {
        throw new Error("AUTH: inbound URI contains control bytes");
    }
    if (uri.includes("#")) {
        throw new Error("AUTH: inbound URI contains a fragment");
    }
    // The remaining checks are about how the PATH is parsed, so they
    // apply to the path only. Query strings legitimately carry encoded
    // slashes and dots (e.g. ?redirect=%2Fhome) and the URL parser does
    // not treat backslashes or dot segments specially there.
    const q = uri.indexOf("?");
    const path = q === -1 ? uri : uri.slice(0, q);
    if (path.includes("\\")) {
        throw new Error("AUTH: inbound URI path contains a backslash");
    }
    if (allowEncodedPath) {
        // Operator opted in to encoded reserved characters in path
        // segments (e.g. GitLab-style 'group%2Fproject' ids). Encoded
        // control bytes are still refused, and so is '%2e': the WHATWG
        // parser treats '%2e%2e' as a dot segment and resolves it, so
        // permitting it would reopen the traversal this check exists for.
        if (/%(0[0-9a-f]|1[0-9a-f]|7f|2e)/i.test(path)) {
            throw new Error("AUTH: inbound URI path contains a percent-encoded control byte or '.'");
        }
    } else if (PERCENT_ENCODED_RISKY.test(path)) {
        throw new Error("AUTH: inbound URI path contains a percent-encoded control byte, '.', '/', '\\', '#' or '%'");
    }
    for (const segment of path.split("/")) {
        // Servlet containers strip ';param' path parameters from each
        // segment before normalising, so '..;' is '..' to Tomcat and
        // Spring while the WHATWG parser leaves it alone. Judge the
        // segment by what precedes the first ';'.
        const core = segment.split(";", 1)[0];
        if (core === "." || core === "..") {
            throw new Error("AUTH: inbound URI path contains a dot segment");
        }
    }
}

function patchMethodAndUriIntoRequest(request: Request, applicationOptions: ApplicationOptions): Request {
    // This function is a workaround to patch the method and URL into the request object
    // because the web server sends us the method and url in headers
    const method = getRequiredHeader(request, applicationOptions.headerNameMethod);
    const url = getRequiredHeader(request, applicationOptions.headerNameUri);
    if (applicationOptions.strictUri) {
        validateInboundUri(url, applicationOptions.allowEncodedPath);
    }

    const handler = {
        get: function (target: Request, prop: string | symbol) {
            if (prop === 'method') {
                return method;
            }
            if (prop === 'url') {
                return url;
            }
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            // Native Request methods (json, text, arrayBuffer, clone,
            // formData, blob) check internal slots on `this`. If we
            // return the function unbound, calling it on the proxy
            // throws TypeError, so endpoints that read the body fail.
            return typeof value === 'function' ? value.bind(target) : value;
        }
    };

    return new Proxy(request, handler);
}

async function runServer(): Promise<void> {
    try {
        printVersion()
        const args = Deno.args;
        const applicationOptions: ApplicationOptions = parseArgs(args);
        printApplicationOptions(applicationOptions);

        // With --disable-stats no database is touched at all, so the
        // process needs no write permission.
        let dbManager: DatabaseManager | null = null;
        if (!applicationOptions.disableStats) {
            dbManager = new DatabaseManager(applicationOptions.dbFilename);
            dbManager.createTableIfNotExists();
        }

        const loaded: LoadedModules = {shutdownHooks: [], seen: new Set()};
        const {router, routeItems} = await setupRoutes(applicationOptions, loaded);
        await loadAdditionalTsFiles(applicationOptions, routeItems, loaded);

        // flushCounters is synchronous, so a plain interval cannot
        // overlap itself. Cleared on shutdown.
        let flushInterval: TimerId | undefined;
        if (dbManager) {
            dbManager.insertInitialStats(routeItems);
            const db = dbManager;
            flushInterval = setInterval(() => {
                try {
                    flushCounters(db, routeItems);
                } catch (error) {
                    console.error('Error updating database:', errMsg(error));
                }
            }, applicationOptions.updatePeriod);
        }

        const server = Deno.serve(
            {
                hostname: applicationOptions.hostname,
                port: applicationOptions.port,
                // Anything that escapes the handler is a bug on our side,
                // not grounds to let a request through. Deny, and log one
                // line rather than Deno's default stack dump.
                onError: (error) => {
                    console.error("Unhandled error in request handler:", sanitizeForLog(errMsg(error)));
                    return new Response(null, {status: 401, headers: {"WWW-Authenticate": "Bearer realm=\"checkpoint401\""}});
                },
            },
            async (req) => {
                if (applicationOptions.maxInFlight > 0 && concurrency.live >= applicationOptions.maxInFlight) {
                    // Shed load before running any endpoint code. 503 is
                    // still a denial to the proxy, but distinguishable
                    // from a real auth failure in logs and metrics.
                    return makeResponse(503, applicationOptions, req, null);
                }
                concurrency.live++;
                try {
                    let patched: Request;
                    try {
                        patched = patchMethodAndUriIntoRequest(req, applicationOptions);
                    } catch (error) {
                        // Missing/invalid forwarded headers: almost always a
                        // proxy misconfiguration, or someone talking to the
                        // auth port directly. Deny with 401, not 500.
                        console.error("Rejected request:", sanitizeForLog(errMsg(error)));
                        return makeResponse(401, applicationOptions, req, null);
                    }
                    return await router.handleRequest(patched);
                } finally {
                    concurrency.live--;
                }
            },
        );

        // Graceful shutdown: stop accepting new requests, wait (bounded)
        // for in-flight handlers to finish, flush any unflushed counters
        // so the periodic-flush gap doesn't lose them across restarts,
        // run module shutdown hooks, close the DB, exit. A second
        // signal while that is in progress exits immediately.
        let signalsSeen = 0;
        const shutdown = async (signal: string) => {
            signalsSeen++;
            if (signalsSeen > 1) {
                console.error(`Received ${signal} again during shutdown; exiting immediately.`);
                try { dbManager?.close(); } catch { /* best effort */ }
                Deno.exit(1);
            }
            console.log(`Received ${signal}; draining in-flight requests (up to ${applicationOptions.shutdownTimeoutMs}ms)...`);
            if (flushInterval !== undefined) clearInterval(flushInterval);
            let drainTimer: TimerId | undefined;
            try {
                await Promise.race([
                    server.shutdown(),
                    new Promise<void>((resolve) => {
                        drainTimer = setTimeout(() => {
                            console.error(`Drain timed out after ${applicationOptions.shutdownTimeoutMs}ms with ${concurrency.live} evaluation(s) still live; continuing shutdown.`);
                            resolve();
                        }, applicationOptions.shutdownTimeoutMs);
                    }),
                ]);
            } catch (error) {
                console.error("Error draining server:", errMsg(error));
            } finally {
                if (drainTimer !== undefined) clearTimeout(drainTimer);
            }
            if (dbManager) {
                try {
                    flushCounters(dbManager, routeItems);
                } catch (error) {
                    console.error("Error flushing counters on shutdown:", errMsg(error));
                }
            }
            for (const {name, hook} of loaded.shutdownHooks) {
                try {
                    await hook();
                    console.log(`Shutdown hook in ${name} completed.`);
                } catch (error) {
                    console.error(`Shutdown hook in ${name} failed:`, errMsg(error));
                }
            }
            try {
                dbManager?.close();
            } catch (error) {
                console.error("Error closing DB:", errMsg(error));
            }
            Deno.exit();
        };
        // SIGTERM is not supported on Windows; SIGINT is. Register
        // each one independently so a missing signal doesn't prevent
        // the others from being installed.
        for (const signal of ["SIGTERM", "SIGINT"] as const) {
            try {
                Deno.addSignalListener(signal, () => { shutdown(signal); });
            } catch (error) {
                console.warn(`Could not install ${signal} handler: ${errMsg(error)}`);
            }
        }
    } catch (error) {
        console.error("Server startup failed:", errMsg(error));
        Deno.exit(1);
    }
}

runServer();
