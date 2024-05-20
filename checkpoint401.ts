import {DB} from "https://deno.land/x/sqlite/mod.ts";

const VERSION: number = 1;

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
        const excludeFiles = new Set(routes.map((route: { file: string }) => route.file));

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
        let routeItems: RouteItem[] = JSON.parse(routesJson);
        routeItems = routeItems.map(route => ({
            ...route,
            passCount: 0,
            failCount: 0,
        }));
        const urlPatternRouter: URLPatternRouter = new URLPatternRouter(applicationOptions)
        for (const routeConfig of routeItems) {
            //const filePath = `${Deno.realPathSync('.')}/${routeConfig.routeEndpointTypeScriptFile}`;
            const filePath = `./config/${routeConfig.routeEndpointTypeScriptFile}`;
            try {
                /*                if (!routeConfig.routeEndpointTypeScriptFile.startsWith('./')) {
                                    routeConfig.routeEndpointTypeScriptFile = './' + routeConfig.routeEndpointTypeScriptFile;
                                }*/
                console.log(`Importing ${filePath} .....`);
                const endpointModule = await import(filePath);
                if (!endpointModule.default) {
                    throw new Error(`The file '${filePath}' does not export a valid default handler.`);
                }
                const endpointFunctionProxy = createEndpointFunctionProxy(endpointModule.default, routeConfig, applicationOptions) as EndpointFunction;
                console.log(routeConfig.method, routeConfig.routeURLPattern, endpointFunctionProxy);
                urlPatternRouter.addRoute(routeConfig.method, routeConfig.routeURLPattern, endpointFunctionProxy);
                console.log(`Route ${routeConfig.method} ${routeConfig.routeURLPattern} loaded successfully, endpoint is: ${filePath}`);
            } catch (error) {
                console.trace(`Error importing endpoint '${filePath}': ${error.message}`);
                throw new Error(`Error importing endpoint '${filePath}': ${error.message}`);
            }
        }
        if (!applicationOptions.disableStats) updateDatabasePeriodically(dbManager, routeItems, applicationOptions);
        await dbManager.insertInitialStats(routeItems);
        return urlPatternRouter;
    } catch (error) {
        console.error('Failed to set up routes:', error);
        throw error;
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
        await dbManager.updateDatabase(routes);
        // Reset the counters
        for (const route of routes) {
            route.passCount = 0;
            route.failCount = 0;
        }
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
    const body = statusCode === 401 && errorMessage ? JSON.stringify({ error: errorMessage }) : null;
    return new Response(body, {status: statusCode});
}

interface routerInternalRoute {
    pattern: URLPattern;
    method: string;
    endpointFunction: EndpointFunction,
}

class URLPatternRouter {
    private routerInternalRoute: routerInternalRoute[] = [];
    private applicationOptions: ApplicationOptions;

    constructor(applicationOptions: ApplicationOptions) {
        this.applicationOptions = applicationOptions;
    }

    addRoute(
        method: string,
        routeURLPattern: string,
        endpointFunction:
            EndpointFunction,
    ) {
        this.routerInternalRoute.push(
            {pattern: new URLPattern({pathname: routeURLPattern}), method, endpointFunction}
        );
    }

    async handleRequest(request: Request) {
        try {
            for (const routerInternalRoute of this.routerInternalRoute) {
                const match = routerInternalRoute.pattern.exec(request.url);
                if (request.method === routerInternalRoute.method && match) {
                    const result: { success: boolean; errorMessage?: string; } = await routerInternalRoute.endpointFunction(request, match);
                    if (result.success) {
                        return makeResponse(200, this.applicationOptions, request, routerInternalRoute.pattern.pathname);
                    } else {
                        return makeResponse(401, this.applicationOptions, request, routerInternalRoute.pattern.pathname, result.errorMessage);
                    }
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
                    throw new Error(`[${new Date().toISOString()}] YOUR TYPESCRIPT ENDPOINT FUNCTION DID NOT RETURN AN OBJECT WITH A BOOLEAN 'success' PROPERTY AND AN OPTIONAL 'errorMessage' STRING PROPERTY! Method: ${routeConfig.method}, Route: ${routeConfig.routeURLPattern}, Function: ${routeConfig.routeURLPattern}`);
                }
                // Update the stats
                result.success ? (routeConfig.passCount = (routeConfig.passCount || 0) + 1) : (routeConfig.failCount = (routeConfig.failCount || 0) + 1);
                return result.success;
            } catch (error) {
                console.error(error);
                return false;
            }
        },
    }) as EndpointFunction;
}

function displayHelp() {
    console.log(`
      Server usage:

      server --config-dir <config_directory> [--db-filename <database_path>] [--update-period <update_period_in_milliseconds>] [--disable-stats] [--version] [--help] [--port <port_number>] [--listen-address <listen_address>]

      --config-dir: Path to the directory containing configuration files (default: .)
      --db-filename: Path to the SQLite database file (default: route_stats_counters.db)
      --update-period: Period in milliseconds to update the database and write counters to disk (default: 10000)
      --disable-stats: Disable the stats feature
      --verbose: Enable verbose logging
      --version: Display server version
      --help: Show help message
      --port: Port number to listen on (default: 3000 or PORT environment variable). If both are set, the server will exit with an error.
      --listen-address: Address to listen on (default: 0.0.0.0 or LISTEN_ADDRESS environment variable). If both are set, the server will exit with an error.

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
}

function printApplicationOptions(options: ApplicationOptions) {
    console.log(`currentWorkingDir: ${options.currentWorkingDir}`);
    console.log(`dbFilename: ${options.dbFilename}`);
    console.log(`disableStats: ${options.disableStats}`);
    console.log(`hostname: ${options.hostname}`);
    console.log(`port: ${options.port}`);
    console.log(`updatePeriod: ${options.updatePeriod}`);
    console.log(`verbose: ${options.verbose}`);
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

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case "--version":
                printVersion()
                Deno.exit(0);
                break;
            case "--verbose":
                applicationOptions.verbose = true;
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
                    i++;
                } else {
                    console.error("Error: --port option requires a number.");
                    Deno.exit(1);
                }
                break;
            case "--listen-address":
                if (i + 1 < args.length) {
                    applicationOptions.hostname = args[i + 1];
                    i++;
                } else {
                    console.error("Error: --listen-address option requires an address.");
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

    // Check if both command-line argument and environment variable are set for port
    const envPort = Deno.env.get("PORT");
    if (applicationOptions.port !== 3000 && envPort) {
        console.error("Error: Both command-line argument and environment variable are set for port.");
        Deno.exit(1);
    }

    // Check if both command-line argument and environment variable are set for listen address
    const envhostname = Deno.env.get("LISTEN_ADDRESS");
    if (applicationOptions.hostname !== "127.0.0.1" && envhostname) {
        console.error("Error: Both command-line argument and environment variable are set for listen address.");
        Deno.exit(1);
    }

    // If only environment variables are set, apply them
    if (!args.includes("--port") && envPort) {
        applicationOptions.port = validatePort(envPort);
    }
    if (!args.includes("--listen-address") && envhostname) {
        applicationOptions.hostname = envhostname;
    }

    return applicationOptions;
}


function printVersion() {
    console.log(`checkpoint401 version ${VERSION}`);
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
        Deno.serve({hostname: applicationOptions.hostname, port: applicationOptions.port}, (req) => router.handleRequest(req));
    } catch (error) {
        console.error("Server startup failed:", error.message);
        Deno.exit(1);
    }
}

runServer();
