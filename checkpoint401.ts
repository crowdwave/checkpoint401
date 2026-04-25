import {DB} from "https://deno.land/x/sqlite@v3.8/mod.ts";

const VERSION: number = 4;

/*
to run:
deno run --allow-net --allow-read --allow-write checkpoint401.ts --db-filename my_database.db

to compile:
deno compile checkpoint401.ts

to run:
./checkpoint401

Optional Arguments:
The provided code supports command-line arguments for configuration. You can pass these arguments when running the binary:
    --config-dir <config-dir>: Path to the directory containing configuration files (default: .)
    --db-filename <database_path>: Path to the SQLite database file (default: route_stats_counters.db)
    --update-period <update_period_in_milliseconds>: Period in milliseconds to update the database and write counters to disk (default: 10000)
    --disable-stats: Disable the stats feature
    --header-name-uri <header_name>: Name of the header for URI (default: X-Forwarded-Uri)
    --header-name-method <header_name>: Name of the header for method (default: X-Forwarded-Method)
    --version: Display server version
    --help: Show help message

./checkpoint401 --dir custom_config --disable-stats
 */

type EndpointFunction = (req: Request, match: URLPatternResult | null) => Promise<{ success: boolean; errorMessage?: string; }>;

interface RouteItem {
    method: string;
    routeURLPattern: string;
    routeEndpointTypeScriptFile: string;
    passCount?: number;
    failCount?: number;
}

class DatabaseManager {
    private db: DB;

    constructor(dbFilename: string) {
        this.db = new DB(dbFilename);
    }

    async createTableIfNotExists() {
        try {
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
        } catch (error) {
            console.error("Error creating table:", error);
        }
    }

    async insertInitialStats(routes: RouteItem[]) {
        const insertStmt = `
            INSERT OR IGNORE INTO route_stats_counters (method, route, passCount, failCount)
            VALUES (?, ?, 0, 0)
        `;

        try {
            for (const routeConfig of routes) {
                this.db.query(insertStmt, [routeConfig.method, routeConfig.routeURLPattern]);
            }
            console.log("Initial stats inserted into database.");
        } catch (error) {
            console.error("Error inserting initial stats:", error);
        }
    }

    async updateDatabase(routes: RouteItem[]) {
        const updateStmt = `
            UPDATE route_stats_counters
            SET passCount = passCount + ?,
                failCount = failCount + ?
            WHERE method = ?
              AND route = ?
        `;

        try {
            for (const routeConfig of routes) {
                this.db.query(updateStmt, [routeConfig.passCount, routeConfig.failCount, routeConfig.method, routeConfig.routeURLPattern]);
            }
        } catch (error) {
            console.error("Error updating database:", error);
        }
    }

    close() {
        this.db.close();
    }
}

async function loadAdditionalTsFiles(applicationOptions: ApplicationOptions): Promise<void> {
    try {
        const routesJson = await Deno.readTextFile(`${applicationOptions.currentWorkingDir}/routes.json`);
        const routes = JSON.parse(routesJson);
        const excludeFiles = new Set(routes.map((route: { routeEndpointTypeScriptFile: string }) => route.routeEndpointTypeScriptFile));

        const directory = await Deno.readDir(applicationOptions.currentWorkingDir);
        console.log(`Importing non-router TypeScript files from ${applicationOptions.currentWorkingDir}`);
        let totalImported = 0;
        for await (const dirEntry of directory) {
            if (dirEntry.isFile && dirEntry.name.endsWith('.ts') && !excludeFiles.has(dirEntry.name)) {
                try {
                    const filePath = `${applicationOptions.currentWorkingDir}/${dirEntry.name}`;
                    await import(filePath);
                    totalImported++
                    console.log(`File ${filePath} loaded successfully.`);
                } catch (error) {
                    console.error(`Error importing non-router file '${dirEntry.name}': ${error.message}`);
                }
            }
        }
        if (totalImported === 0) {
            console.log(`No non-router TypeScript files found in ${applicationOptions.currentWorkingDir}`);
        }

    } catch (error) {
        console.error(`Error loading non-router TypeScript files: ${error}`);
        Deno.exit(1);
    }
}


async function setupRoutes(
    applicationOptions: ApplicationOptions,
    dbManager: DatabaseManager,
): Promise<URLPatternRouter> {
    try {
        const routesJson = await Deno.readTextFile(`${applicationOptions.currentWorkingDir}/routes.json`);
        const parsed: unknown = JSON.parse(routesJson);
        if (!Array.isArray(parsed)) {
            throw new Error("routes.json must be a JSON array of route objects.");
        }
        let routeItems: RouteItem[] = parsed.map((entry, index) => {
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
            return {
                method: e.method,
                routeURLPattern: e.routeURLPattern,
                routeEndpointTypeScriptFile: e.routeEndpointTypeScriptFile,
                passCount: 0,
                failCount: 0,
            };
        });
        const urlPatternRouter: URLPatternRouter = new URLPatternRouter(applicationOptions)
        for (const routeConfig of routeItems) {
            const endpointFileName = routeConfig.routeEndpointTypeScriptFile;
            // routes.json supplies a flat filename. Reject anything that
            // could escape the config directory or look like an absolute
            // path - if routes.json is ever attacker-controlled, this
            // turns "import the auth function" into "import any .ts on
            // disk".
            if (typeof endpointFileName !== "string" || endpointFileName.length === 0
                || endpointFileName.includes("/") || endpointFileName.includes("\\")
                || endpointFileName.includes("..") || endpointFileName.includes("\0")) {
                throw new Error(`Invalid routeEndpointTypeScriptFile '${endpointFileName}': must be a flat filename in the config directory.`);
            }
            const filePath = `./config/${endpointFileName}`;
            try {
                const endpointModule = await import(filePath);
                if (!endpointModule.default) {
                    throw new Error(`The file '${filePath}' does not export a valid default handler.`);
                }
                const endpointFunctionProxy = createEndpointFunctionProxy(endpointModule.default, routeConfig, applicationOptions) as EndpointFunction;
                urlPatternRouter.addRoute(routeConfig.method, routeConfig.routeURLPattern, endpointFunctionProxy);
                console.log(`Loaded route ${routeConfig.method} ${routeConfig.routeURLPattern} -> ${filePath}`);
            } catch (error) {
                throw new Error(`Error importing endpoint '${filePath}': ${error.message}`);
            }
        }
        if (!applicationOptions.disableStats) updateDatabasePeriodically(dbManager, routeItems, applicationOptions);
        await dbManager.insertInitialStats(routeItems);
        return urlPatternRouter;
    } catch (error) {
        // Re-throw with a context-prefixed message; runServer's catch
        // is the single layer that logs the failure to stderr, which
        // avoids the double-log we used to produce here.
        throw new Error(`Failed to set up routes: ${error.message}`);
    }
}

async function updateDatabasePeriodically(
    dbManager: DatabaseManager,
    routes: RouteItem[],
    applicationOptions: ApplicationOptions,
) {
    const {updatePeriod} = applicationOptions;
    if (!dbManager || !(dbManager instanceof DatabaseManager)) {
        throw new Error('Invalid dbManager argument. It must be an instance of DatabaseManager.');
    }
    if (typeof updatePeriod !== 'number' || updatePeriod <= 0) {
        throw new Error('Invalid updatePeriod argument. It must be a positive number.');
    }
    try {
        // Snapshot then clear before writing, so any increments that
        // land while the write is in flight are preserved for the next
        // flush rather than zeroed. Today the sqlite query is sync so
        // this can't happen, but the function is async and would race
        // if query ever became awaited.
        const snapshot = routes.map(route => ({
            method: route.method,
            routeURLPattern: route.routeURLPattern,
            passCount: route.passCount ?? 0,
            failCount: route.failCount ?? 0,
        })) as RouteItem[];
        for (const route of routes) {
            route.passCount = 0;
            route.failCount = 0;
        }
        await dbManager.updateDatabase(snapshot);
    } catch (error) {
        console.error('Error updating database:', error);
    } finally {
        // Schedule the next update after the current one has completed
        setTimeout(() => updateDatabasePeriodically(dbManager, routes, applicationOptions), updatePeriod);
    }
}

const makeResponse = (
    statusCode: 401 | 200 | 404,
    applicationOptions: ApplicationOptions,
    request: Request,
    URLPatternPathname: string | null,
    errorMessage?: string,
): Response => {
    if (applicationOptions.verbose) {
        console.log(`[${new Date().toISOString()}] status: ${statusCode} method: ${request.method} pattern: ${URLPatternPathname} request.url: ${request.url}`);
    }
    const includeBody = statusCode === 401 && errorMessage && !applicationOptions.suppressErrorBody;
    const body = includeBody ? JSON.stringify({error: errorMessage}) : null;
    return new Response(body, {status: statusCode});
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

function getInboundUriFromHeaders(request: Request, headerNameUri: string): string {
    const xForwardedUri = request.headers.get(headerNameUri);
    if (xForwardedUri === null) {
        throw new Error(`AUTH: ${headerNameUri} not found in headers`);
    }
    return xForwardedUri;
}

function getInboundMethodFromHeaders(request: Request, headerNameMethod: string): string {
    const xForwardedMethod = request.headers.get(headerNameMethod);
    if (xForwardedMethod === null) {
        throw new Error(`AUTH: ${headerNameMethod} not found in headers`);
    }
    return xForwardedMethod;
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
            throw new Error(`Invalid routeURLPattern '${routeURLPattern}' for ${method}: ${error.message}`);
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
                const result: Awaited<ReturnType<EndpointFunction>> = await route.endpointFunction(request, match);
                if (result.success) {
                    return makeResponse(200, this.applicationOptions, request, route.pattern.pathname);
                } else {
                    return makeResponse(401, this.applicationOptions, request, route.pattern.pathname, result.errorMessage);
                }
            }
            return makeResponse(404, this.applicationOptions, request, null);
        } catch (error) {
            console.error('Error handling request:', error);
            return makeResponse(401, this.applicationOptions, request, null);
        }
    }
}

// this wraps the endpoints and ensures only boolean is returned
function createEndpointFunctionProxy(fn: Function, routeConfig: RouteItem, applicationOptions: ApplicationOptions): EndpointFunction {
    return new Proxy(fn, {
        async apply(target, thisArg, argumentsList) {
            try {
                const result = await target(...argumentsList);
                if (typeof result !== "object" || typeof result.success !== "boolean" || (result.errorMessage && typeof result.errorMessage !== "string")) {
                    routeConfig.failCount = (routeConfig.failCount || 0) + 1; // Increment fail count
                    throw new Error(`[${new Date().toISOString()}] YOUR TYPESCRIPT ENDPOINT FUNCTION DID NOT RETURN AN OBJECT WITH A BOOLEAN 'success' PROPERTY AND AN OPTIONAL 'errorMessage' STRING PROPERTY! Method: ${routeConfig.method}, Route: ${routeConfig.routeURLPattern}, File: ${routeConfig.routeEndpointTypeScriptFile}`);
                }
                // Update the stats
                result.success ? (routeConfig.passCount = (routeConfig.passCount || 0) + 1) : (routeConfig.failCount = (routeConfig.failCount || 0) + 1);
                return result;
            } catch (error) {
                console.error(error);
                return {success: false, errorMessage: "Unknown auth error"};
            }
        },
    }) as EndpointFunction;
}

function displayHelp() {
    console.log(`
      Server usage:

      server --config-dir <config_directory> [--db-filename <database_path>] [--update-period <update_period_in_milliseconds>] [--disable-stats] [--version] [--help] [--port <port_number>] [--listen-address <listen_address>] [--header-name-uri <header_name>] [--header-name-method <header_name>]

      --config-dir: Path to the directory containing configuration files (default: .)
      --db-filename: Path to the SQLite database file (default: route_stats_counters.db)
      --update-period: Period in milliseconds to update the database and write counters to disk (default: 10000)
      --disable-stats: Disable the stats feature
      --verbose: Enable verbose logging (default: on)
      --quiet: Disable verbose per-request logging. Verbose logs include the full request URL, which can contain tokens/PII passed in the query string.
      --version: Display server version
      --help: Show help message
      --port: Port number to listen on (default: 3000 or PORT environment variable). If both are set, the server will exit with an error.
      --listen-address: Address to listen on (default: 127.0.0.1 or LISTEN_ADDRESS environment variable). If both are set, the server will exit with an error.
      --header-name-uri: Name of the header for URI (default: X-Forwarded-Uri)
      --header-name-method: Name of the header for method (default: X-Forwarded-Method)
      --strict-uri: Reject inbound X-Forwarded-Uri values that are not '/'-prefixed paths or contain CR/LF/NUL bytes. Off by default for compatibility; recommended for new deployments.
      --no-error-body: Do not include the endpoint's errorMessage in 401 response bodies. Off by default. Recommended if your reverse proxy forwards the auth response body to clients or error pages, since distinct error strings can enable user enumeration.

      **Configuration Files:**

      - routes.json: This file defines the routes for the server. It should be a JSON array with each object containing the following properties:
          - method: HTTP method (GET, POST, etc.)
          - route: The route path for the request
          - file: The filename of the TypeScript endpoint handler located in the "endpoints" directory

      - auth/<function_name>.ts: These files define the authentication logic. Each file should export a default function that takes a Request object as input and returns a Promise that resolves to true if the request is authorized, false otherwise.

      - endpoints/<file_name>.ts: These files define the endpoint handlers for specific routes. Each file should export a default function that takes a Request object as input and returns a Response object or a value that will be converted to a Response.
  `);
}

interface ApplicationOptions {
    currentWorkingDir: string;
    dbFilename: string;
    disableStats: boolean;
    hostname: string;
    port: number;
    updatePeriod: number;
    verbose: boolean;
    headerNameUri: string;
    headerNameMethod: string;
    strictUri: boolean;
    suppressErrorBody: boolean;
}

function printApplicationOptions(options: ApplicationOptions) {
    console.log(`currentWorkingDir: ${options.currentWorkingDir}`);
    console.log(`dbFilename: ${options.dbFilename}`);
    console.log(`disableStats: ${options.disableStats}`);
    console.log(`hostname: ${options.hostname}`);
    console.log(`port: ${options.port}`);
    console.log(`updatePeriod: ${options.updatePeriod}`);
    console.log(`verbose: ${options.verbose}`);
    console.log(`headerNameUri: ${options.headerNameUri}`);
    console.log(`headerNameMethod: ${options.headerNameMethod}`);
    console.log(`strictUri: ${options.strictUri}`);
    console.log(`suppressErrorBody: ${options.suppressErrorBody}`);
}

function parseArgs(args: string[]): ApplicationOptions {
    const applicationOptions: ApplicationOptions = {
        dbFilename: "route_stats_counters.db",
        currentWorkingDir: Deno.cwd(),
        disableStats: false,
        hostname: `127.0.0.1`,
        port: 3000,
        updatePeriod: 10000,
        verbose: true,
        headerNameUri: "X-Forwarded-Uri",
        headerNameMethod: "X-Forwarded-Method",
        strictUri: false,
        suppressErrorBody: false,
    };

    function validatePort(port: string): number {
        const parsedPort = Number(port);
        if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            console.error("Error: --port option requires a valid port number between 1 and 65535.");
            Deno.exit(1);
        }
        return parsedPort;
    }

    function validateUpdatePeriod(period: string): number {
        const parsedPeriod = Number(period);
        if (isNaN(parsedPeriod) || parsedPeriod < 1000) {
            console.error("Error: --update-period option requires a number greater than or equal to 1000.");
            Deno.exit(1);
        }
        return parsedPeriod;
    }

    let portFromCli = false;
    let hostnameFromCli = false;
    let verboseFromCli = false;
    let quietFromCli = false;

    const seenFlags = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            if (seenFlags.has(arg)) {
                console.error(`Error: ${arg} was passed more than once.`);
                Deno.exit(1);
            }
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
                break;
            case "--no-error-body":
                applicationOptions.suppressErrorBody = true;
                break;
            case "--db-filename":
                if (i + 1 < args.length) {
                    applicationOptions.dbFilename = args[i + 1];
                    i++;
                } else {
                    console.error("Error: --db-filename option requires a database filename.");
                    Deno.exit(1);
                }
                break;
            case "--update-period":
                if (i + 1 < args.length) {
                    applicationOptions.updatePeriod = validateUpdatePeriod(args[i + 1]);
                    i++;
                } else {
                    console.error("Error: --update-period option requires a number.");
                    Deno.exit(1);
                }
                break;
            case "--disable-stats":
                applicationOptions.disableStats = true;
                break;
            case "--port":
                if (i + 1 < args.length) {
                    applicationOptions.port = validatePort(args[i + 1]);
                    portFromCli = true;
                    i++;
                } else {
                    console.error("Error: --port option requires a number.");
                    Deno.exit(1);
                }
                break;
            case "--listen-address":
                if (i + 1 < args.length) {
                    applicationOptions.hostname = args[i + 1];
                    hostnameFromCli = true;
                    i++;
                } else {
                    console.error("Error: --listen-address option requires an address.");
                    Deno.exit(1);
                }
                break;
            case "--header-name-uri":
                if (i + 1 < args.length) {
                    applicationOptions.headerNameUri = args[i + 1];
                    i++;
                } else {
                    console.error("Error: --header-name-uri option requires a header name.");
                    Deno.exit(1);
                }
                break;
            case "--header-name-method":
                if (i + 1 < args.length) {
                    applicationOptions.headerNameMethod = args[i + 1];
                    i++;
                } else {
                    console.error("Error: --header-name-method option requires a header name.");
                    Deno.exit(1);
                }
                break;
            case "--config-dir":
                if (i + 1 < args.length) {
                    applicationOptions.currentWorkingDir = args[i + 1];
                    i++;
                } else {
                    console.error("Error: --config-dir option requires a directory path.");
                    Deno.exit(1);
                }
                break;
            case "--help":
                displayHelp();
                Deno.exit(0);
                break;
            default:
                console.error(`Unknown argument: ${arg}`);
                Deno.exit(1);
        }
    }

    // Track whether the CLI explicitly set port/hostname rather than
    // comparing against the default sentinel - otherwise passing
    // --port 3000 (or --listen-address 127.0.0.1) alongside the env
    // var was indistinguishable from "not set on CLI" and the conflict
    // check silently skipped.
    const envPort = Deno.env.get("PORT");
    if (portFromCli && envPort) {
        console.error("Error: Both command-line argument and environment variable are set for port.");
        Deno.exit(1);
    }

    const envhostname = Deno.env.get("LISTEN_ADDRESS");
    if (hostnameFromCli && envhostname) {
        console.error("Error: Both command-line argument and environment variable are set for listen address.");
        Deno.exit(1);
    }

    // If only environment variables are set, apply them
    if (!portFromCli && envPort) {
        applicationOptions.port = validatePort(envPort);
    }
    if (!hostnameFromCli && envhostname) {
        applicationOptions.hostname = envhostname;
    }

    if (verboseFromCli && quietFromCli) {
        console.error("Error: --verbose and --quiet are mutually exclusive.");
        Deno.exit(1);
    }

    // Header names must be non-empty token chars per RFC 7230, and the
    // URI and method headers must differ - otherwise both reads return
    // the same value and the router can never match.
    const httpTokenChars = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    if (!httpTokenChars.test(applicationOptions.headerNameUri)) {
        console.error(`Error: --header-name-uri '${applicationOptions.headerNameUri}' is not a valid HTTP header name.`);
        Deno.exit(1);
    }
    if (!httpTokenChars.test(applicationOptions.headerNameMethod)) {
        console.error(`Error: --header-name-method '${applicationOptions.headerNameMethod}' is not a valid HTTP header name.`);
        Deno.exit(1);
    }
    if (applicationOptions.headerNameUri.toLowerCase() === applicationOptions.headerNameMethod.toLowerCase()) {
        console.error(`Error: --header-name-uri and --header-name-method must differ (both set to '${applicationOptions.headerNameUri}').`);
        Deno.exit(1);
    }

    return applicationOptions;
}


function printVersion() {
    console.log(`checkpoint401 version ${VERSION}`);
}

function validateInboundUri(uri: string): void {
    // Cheap structural checks against the value the proxy passed in via
    // X-Forwarded-Uri. This catches:
    //   - header-injection bytes (CR/LF/NUL)
    //   - absolute URLs that would let an attacker steer URLPattern
    //     onto a different host's pathname semantics
    //   - non-path values that are obviously not what the proxy meant
    //     to send, helping detect proxy misconfiguration early.
    if (uri.length === 0 || uri.length > 8192) {
        throw new Error("AUTH: inbound URI is empty or too long");
    }
    if (/[\r\n\0]/.test(uri)) {
        throw new Error("AUTH: inbound URI contains CR/LF/NUL");
    }
    if (!uri.startsWith("/")) {
        throw new Error("AUTH: inbound URI must start with '/'");
    }
}

function patchMethodAndUriIntoRequest(request: Request, applicationOptions: ApplicationOptions): Request {
    // This function is a workaround to patch the method and URL into the request object
    // because the web server sends us the method and url in headers
    try {
        const method = getInboundMethodFromHeaders(request, applicationOptions.headerNameMethod);
        const url = getInboundUriFromHeaders(request, applicationOptions.headerNameUri);
        if (applicationOptions.strictUri) {
            validateInboundUri(url);
        }

        const handler = {
            get: function(target: Request, prop: string) {
                if (prop === 'method') {
                    return method;
                }
                if (prop === 'url') {
                    return url;
                }
                const value = (target as any)[prop];
                // Native Request methods (json, text, arrayBuffer, clone,
                // formData, blob) check internal slots on `this`. If we
                // return the function unbound, calling it on the proxy
                // throws TypeError, so endpoints that read the body fail.
                return typeof value === 'function' ? value.bind(target) : value;
            }
        };

        return new Proxy(request, handler);
    } catch (error) {
        throw new Error(`Error modifying request: ${error.message}`);
    }
}

async function runServer(): Promise<void> {
    try {
        printVersion()
        const args = Deno.args;
        const applicationOptions: ApplicationOptions = parseArgs(args);
        printApplicationOptions(applicationOptions);
        const dbManager = new DatabaseManager(applicationOptions.dbFilename);
        await dbManager.createTableIfNotExists();
        const router = await setupRoutes(applicationOptions, dbManager);
        await loadAdditionalTsFiles(applicationOptions);
        const shutdown = () => {
            dbManager.close();
            Deno.exit();
        }
        Deno.addSignalListener("SIGTERM", shutdown);
        Deno.addSignalListener("SIGINT", shutdown);
        Deno.serve(
            {hostname: applicationOptions.hostname, port: applicationOptions.port},
            (req) => router.handleRequest(patchMethodAndUriIntoRequest(req, applicationOptions))
        );
    } catch (error) {
        console.error("Server startup failed:", error.message);
        Deno.exit(1);
    }
}

runServer();
