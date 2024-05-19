
![logo](https://github.com/crowdwave/checkpoint401/assets/13228330/361e7e01-540c-4d1b-9a80-1f43f9ef2f5d)

# Checkpoint 401 Forward Auth Security Server

May 2024 note: Checkpoint 401 is aimed at sophisticated TypeScript developers... it is new and is not battle-tested. We recommend you first read the source code in detail and assure yourself of its suitability for your needs - there is only a single source file of about 500 lines - small enough for a skilled TypeScript developer to understand. We welcome code reviews and feedback to improve its reliability and security. Checkpoint 401 has no guarantee at all - use at your own risk.

## What is a Forward Auth Server?

A forward auth server is a specialised web server that handles authentication on behalf of another server. It acts as an intermediary, verifying permissions for requests to access resources. A forward auth server is used in conjunction with reverse proxies like Caddy, NGINX, and Traefik to enhance security and simplify auth management. These web servers have forward auth functionality which when enabled, sends inbound requests first to the forward auth server, and any other response than 200 OK means the web server will reject the request.

Caddy forward auth doc: https://caddyserver.com/docs/caddyfile/directives/forward_auth

Nginx forward auth doc: https://docs.nginx.com/nginx/admin-guide/security-controls/configuring-subrequest-authentication/

Traefik forward auth doc: https://doc.traefik.io/traefik/middlewares/forwardauth/


## Why separate authentication from the application server?

When you separate auth from the application server, you no longer need to implement as much authentication logic in each application - in an ideal case there would be no auth logic in your application - it would all be handled by the forward auth server. This simplifies application code, reduces security risks, and provides a centralised authentication mechanism for all applications behind the reverse proxy.


Instead of having auth code like spaghetti through your application code, you focus your auth coding on the TypeScript endpoint functions in the Checkpoint 401 server. This makes your application code cleaner and easier to maintain.

## Core Concepts of Checkpoint 401

* Checkpoint 401 is written in Typescript and runs on Deno.
* Checkpoint 401 aims for simplicity and minimalism - it is easy to understand.
* Checkpoint 401 requires that you provide a routes.json file to define methods/URL patterns and an endpoint function to run when a request matches.
* You write the endpoint functions in TypeScript.
* Your endpoint functions must adhere to a specific signature and can return only true or false to allow or deny requests. 
* You can provide additional TypeScript files beyond the endpoint functions for additional logic.
* That is the entirety of Checkpoint 401.

## Defining Routes

routes.json: This file defines the routes for the server. It should be a JSON array with each object containing the following properties:
* method: HTTP method (GET, POST, etc.).
* routeURLPattern: The route pattern to match to the inbound request url, which must be a URL pattern as defined in the URL Pattern API documented at: https://developer.mozilla.org/en-US/docs/Web/API/URLPattern/URLPattern
* routeEndpointTypeScriptFile: The filename of the TypeScript endpoint handler located in the current working directory.

Example routes.json

    [
      {
        "method": "GET",
        "routeURLPattern": "/api/users",
        "routeEndpointTypeScriptFile": "getUsers.ts"
      },
      {
        "method": "POST",
        "routeURLPattern": "/api/createpost",
        "routeEndpointTypeScriptFile": "createPost.ts"
      },
      {
        "method": "PUT",
        "routeURLPattern": "/api/posts/:id",
        "routeEndpointTypeScriptFile": "updatePost.ts"
      }
    ]

## Writing Endpoint Functions

Your TypeScript endpoint functions must have a very specific signature to function correctly with Checkpoint 401. The function signature should be:

    type EndpointFunction = (req: Request, match: URLPatternResult | null) => Promise<boolean>;

Each TypeScript file must export a default function that adheres to this signature and returns a Promise resolving to true or false to indicate if the request is allowed or denied.

Example endpoint function for anonymous:

    export default async function authFuncAnonymous(req: Request, match: URLPatternResult | null): Promise<boolean> {
        return true;
    }

Example endpoint Function (config/getUsers.ts):

    export default async function getUsers(req: Request, match: URLPatternResult | null): Promise<boolean> {
        // Example logic to validate user
        const userId = 2;
        const users = [
            {id: 1, name: "User 1"},
            {id: 2, name: "User 2"},
            {id: 3, name: "User 3"}
        ];
    
        // Check if the request contains a user with an id of 2
        const userExists = users.some(user => user.id === userId);
        return userExists;
    }

Another example endpoint function:

    export default async function myAuthEndpointFunction(req: Request, match: URLPatternResult | null): Promise<boolean> {
        try {
            // Perform asynchronous operations, such as fetching data or processing the request
            const response = await fetch(req.url);
            const data = await response.json();
            
            // Perform some logic with the data
            if (data.someCondition) {
                return true;
            } else {
                return false;
            }
        } catch (error) {
            console.error('Error handling request:', error);
            return false;
        }
    }

The match argument contains the match returned by the URL Pattern match againstt the inbound request. The match object is what is returned by exec as defined here: https://developer.mozilla.org/en-US/docs/Web/API/URLPattern/exec


## Additional TypeScript Files

When the Checkpoint 401 server starts, it imports all the TypeScript files in the current working directory. This means you can import additional TypeScript files beyond the endpoint functions for the routes. These additional TypeScript files can contain any valid TypeScript code you want.


## Overview of how a request is handled:

* Client Request: The client sends a request to the reverse proxy (NGINX/Caddy).
* Forward Auth: NGINX/Caddy forwards the request to the Checkpoint 401 server.
* Checkpoint 401: The request is processed by Checkpoint 401, which runs the appropriate route handler (e.g., getUsers.ts).
* Route Handler: The handler function checks the request and returns true or false.
* Decision: Checkpoint 401 returns a 200 OK response if the request is allowed, or a 401 Deny response if it is denied. The only other status values that Checkpoint 401 can return is 404 and 500.
* Response to NGINX/Caddy: The decision is sent back to NGINX/Caddy as an HTTP status code, 200 is approved, 401 is denied, 404 is not found and 500 is server error.
* NGINX/Caddy Decision: NGINX/Caddy forwards the request to the application server only if an HTTP status 200 was returned from the forward auth server.

## Why Use a Forward Auth Server?

### Using a forward auth server offers several benefits:

**Centralized Authentication:**
    With a forward auth server, authentication logic is centralized, making it easier to manage and update. This ensures that all applications behind the reverse proxy use the same authentication mechanism, providing consistency and reducing the risk of security gaps.

**Simplified Application Logic:**
    By offloading authentication to a dedicated server, the application code becomes simpler and cleaner. The application can focus on its core functionality without worrying about authentication, resulting in easier maintenance and fewer bugs.

**Enhanced Security:**
    A forward auth server provides a single point of control for authentication, allowing for better enforcement of security policies. It can integrate with various authentication providers (e.g., OAuth, LDAP) and implement advanced security features such as multi-factor authentication (MFA).

**Scalability:**
    Centralizing authentication allows you to scale your applications independently of the authentication system. The forward auth server can handle authentication requests for multiple applications, improving overall system scalability and performance.

**Flexibility:**
    Forward auth servers can be easily integrated with various reverse proxies like Caddy, NGINX, and Traefik. This flexibility allows you to choose the best reverse proxy for your needs while maintaining a consistent authentication mechanism.

## Usage instructions

**Install Deno:**
If you don't have Deno installed, follow the instructions on the official Deno website.

**Create a Configuration Directory:**
Create a directory named config and place your routes.json file and endpoint TypeScript files in this directory.

**Run the Server:**
Change your current working directory to config and run the server:

    cd config
    deno run --allow-net --allow-read --allow-env --allow-write ../checkpoint401.ts 

## Command-Line Arguments

Checkpoint 401 has several optional command-line arguments:

    --config-dir <config-dir>: Path to the directory containing configuration files (default: .).
    --db-filename <database_path>: Path to the SQLite database file (default: route_stats_counters.db).
    --update-period <update_period_in_milliseconds>: Period in milliseconds to update the database and write counters to disk (default: 10000).
    --disable-stats: Disable the stats feature.
    --version: Display server version.
    --help: Show help message.
    --port <port_number>: Port number to listen on (default: 3000 or PORT environment variable).
    --listen-address <listen_address>: Address to listen on (default: 0.0.0.0 or LISTEN_ADDRESS environment variable).

## How It Works - Startup Process

The following ASCII diagram illustrates what Checkpoint 401 does when it starts up:

    +---------------------+
    |   Checkpoint 401    |
    |      Starts Up      |
    +---------------------+
              |
              v
    +---------------------+
    | Read Configuration  |
    |   (routes.json)     |
    +---------------------+
              |
              v
    +---------------------+
    | Import TypeScript   |
    |   Files in Config   |
    +---------------------+
              |
              v
    +---------------------+
    | Setup Routes from   |
    |   routes.json       |
    +---------------------+
              |
              v
    +---------------------+
    | Start HTTP Server   |
    |  Listening on Port  |
    +---------------------+

**Overview of Server Logic**

* Read Configuration: Checkpoint 401 reads the routes.json file to get the route configurations.
* Import TypeScript Files: It imports all the TypeScript files in the config directory. This allows you to include additional TypeScript files beyond the endpoint functions.
* Setup Routes: It sets up the routes from routes.json.
* Start HTTP Server: Finally, it starts the HTTP server, which listens on the specified port.

This concludes the full document for Checkpoint 401 Forward Auth Server.
