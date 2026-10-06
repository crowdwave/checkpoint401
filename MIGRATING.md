# Migrating from Checkpoint 401 v4 to v5

Version 5 hardens the server's defaults and requires Deno 2. Most deployments
need only a handful of changes, but several defaults now **deny** requests
that version 4 allowed, so read the breaking changes before you upgrade.

Run `checkpoint401.ts --version` to see which version you have. The version
number is the `VERSION` constant at the top of the file.

## Breaking changes at a glance

| # | Area | v4 behaviour | v5 behaviour | Action needed |
|---|------|--------------|--------------|---------------|
| 1 | Runtime | Deno 1.x or 2.x | Deno 2.x only | Upgrade Deno |
| 2 | Dependencies | Unpinned, no lockfile | Exact pins, frozen `deno.lock` | Regenerate the lock if your config imports other modules |
| 3 | URI validation | Off by default | **On by default** | Check your paths, or opt out |
| 4 | Endpoint timeout | None | **10 seconds**, then 401 | Raise it if endpoints are slow |
| 5 | Concurrency cap | None | **1024**, then 503 | Raise it for very high traffic |
| 6 | Per-request log | On by default | Off by default | Add `--verbose` if you relied on it |
| 7 | Endpoint file location | `config/` beside the script | The config directory | Only matters if the two differ |
| 8 | Missing forwarded headers | 500 | 401 | Update monitoring that keys on 500 |
| 9 | Duplicate routes | Later entry silently ignored | Startup error | Remove the duplicate |
| 10 | Helper import failure | Logged, startup continues | Startup error | Fix the helper |
| 11 | Numeric flags and `PORT` | Any JavaScript number | Plain decimal integers | Fix values like `3000.5` or `0x0BB8` |
| 12 | Config modules and shutdown | Modules could exit on SIGTERM | Server owns shutdown | Move cleanup to `onShutdown` |
| 13 | Type checking | Older config code type-checked | `deno check` may fail | Update error-handling types |

Changes to the bundled example config are listed separately under
[Example config changes](#example-config-changes). They only affect you if
you copied those files.

## Breaking changes in detail

### 1. Deno 2 is required

The lockfile format, the `jsr:` and `npm:` imports, and the `--allow-env=PG*`
wildcard all need Deno 2. Version 5 is tested on Deno 2.7 and 2.9.

```bash
deno upgrade
deno --version   # must report 2.x
```

### 2. Dependencies are pinned and the lockfile is frozen

`deno.json` at the repository root turns on a **frozen** `deno.lock`. Deno
finds `deno.json` by walking up from the working directory, so it applies
even when you run the server from inside `config/`.

A frozen lock refuses to start if any imported module is missing from it. If
your config directory imports anything the bundled lock doesn't cover, such
as an older driver version or another library, startup fails with:

```
error: The lockfile is out of date. Run `deno install --frozen=false`, or rerun with `--frozen=false` to update it.
```

Regenerate the lock against your own config, then commit it with that config:

```bash
deno install --entrypoint --frozen=false checkpoint401.ts config/*.ts
deno check checkpoint401.ts config/*.ts
```

Use `config/*.ts` or whatever path holds your config. After this, every
start verifies each dependency's integrity hash. A tampered or drifted
dependency stops the server instead of running.

### 3. Strict URI validation is on by default

The URL parser behind route matching turns `\` into `/`, resolves `.` and
`..` segments, and accepts absolute and protocol-relative URLs. Your backend
receives the raw URI and may parse it differently. In version 4 an attacker
could therefore be authorised for one path while the backend served another.

Version 5 denies, with 401, any forwarded URI that is not a plain `/` path:

- absolute URLs and paths starting with `//`
- backslashes in the path
- `.` and `..` segments, including the servlet-container form `..;`
- fragments (`#`)
- control bytes, raw or percent-encoded
- percent-encoded `.`, `/`, `\`, `#` and `%` in the path (`%2e`, `%2f`, `%5c`, `%23`, `%25`)

Query strings are exempt from the path rules.

**Check before upgrading.** Look for legitimate paths that carry encoded
slashes or percent signs, such as GitLab-style `group%2Fproject` ids or file
names containing `%`. Rejected requests appear in the log as
`Rejected request: AUTH: ...`.

**If you need encoded characters in paths**, keep strict mode and add
`--allow-encoded-path`. It permits encoded `/`, `\`, `#` and `%`, but still
refuses encoded control bytes and `%2e`.

**To restore version 4 behaviour**, pass `--no-strict-uri`. Only do this if
you have confirmed your backend parses paths the same way the URL standard
does.

### 4. Endpoints time out after 10 seconds

An endpoint that runs longer than `--endpoint-timeout-ms` is denied with 401.
Version 4 had no limit. The endpoint also receives an `AbortSignal` as its
third argument, which fires at the timeout:

```ts
export default async function myEndpoint(req: Request, match: URLPatternResult | null, signal?: AbortSignal) {
    const res = await fetch("http://127.0.0.1:5000/session", { signal });
    // ...
}
```

Existing two-argument endpoints keep working unchanged. If any legitimately
take longer, raise the limit, for example `--endpoint-timeout-ms 30000`. Pass
`0` to disable it.

### 5. Concurrency is capped at 1024

Above `--max-in-flight` live evaluations, requests get 503 with
`Retry-After: 1` and no endpoint code runs. Endpoints still running after
their timeout keep counting until they finish, so a slow backend cannot pile
up unbounded work. Raise the cap for very high traffic, or pass `0` to
disable it.

### 6. Per-request logging is off by default

Version 4 logged every request, including the full URL with its query
string. Version 5 logs nothing per request unless you pass `--verbose`, and
even then logs only the path. `--quiet` is still accepted and now does
nothing.

Denials are still logged, one line per failed endpoint. Programming errors in
endpoint code, such as a `TypeError`, also get a stack trace. With
`--verbose`, every endpoint failure gets one.

### 7. Endpoint files load from the config directory

Version 4 read `routes.json` and helper files from the working directory or
`--config-dir`, but imported endpoint files from `config/` beside
`checkpoint401.ts`. Version 5 loads everything from the config directory.

This only affects you if the two locations differed. The usual setup of
running from inside `config/` behaves the same as before.

### 8. Missing forwarded headers return 401, not 500

A request without the URI or method header, which usually means a
misconfigured proxy or someone calling the auth port directly, now gets 401
and a one-line log entry. Version 4 returned 500 with a stack trace. Update
any alerting that watches for 500s from the auth server.

### 9. Duplicate routes are a startup error

Two entries in `routes.json` with the same method and pattern now stop
startup with the index of the duplicate. Version 4 silently used the first
and ignored the second. Methods are compared case-insensitively.

Version 5 also stores methods in upper case in the stats database. Existing
rows keyed by a lower-case method are merged into the upper-case row
automatically on first start. You don't need to do anything.

### 10. A helper file that fails to import stops startup

Version 4 logged the error and carried on, which left endpoints that depended
on the helper failing at request time. Version 5 refuses to start. Fix or
remove the broken file.

Version 5 also refuses to start if it cannot create the initial stats rows.

### 11. Numeric flags must be plain decimal integers

`--port`, `--update-period`, `--endpoint-timeout-ms`, `--shutdown-timeout-ms`,
`--max-in-flight` and the `PORT` environment variable now reject values such
as `3000.5`, `0x0BB8`, `1e3` and `" 3000 "`. Version 4 accepted anything
JavaScript's `Number()` could parse.

### 12. The server owns shutdown

On SIGTERM or SIGINT, version 5 stops accepting connections, waits up to
`--shutdown-timeout-ms` (default 10 seconds) for in-flight requests, flushes
its counters, runs shutdown hooks, closes the stats database and exits. A
second signal exits immediately.

A config module that installs its own signal handler and calls `Deno.exit()`
cuts that sequence short. In-flight requests are dropped and the final
counter flush is lost. Version 4's example `db.ts` did exactly this, and
copies of it are common.

**Before:**

```ts
const sql = postgres(env.DATABASE_URL);

const doShutdown = async () => {
  await sql.end({ timeout: 5 });
  Deno.exit();
};
for (const signal of ["SIGTERM", "SIGQUIT", "SIGINT"]) {
  Deno.addSignalListener(signal, doShutdown);
}

export default sql;
```

**After:**

```ts
const sql = postgres(env.DATABASE_URL);

// Awaited by the server during graceful shutdown.
export async function onShutdown(): Promise<void> {
  await sql.end({ timeout: 5 });
}

export default sql;
```

`onShutdown` is collected from endpoint files and from top-level `.ts` files
in the config directory. Subdirectories are not scanned.

Also replace any `Deno.exit()` at import time with a thrown error. The server
reports it as a clear startup failure:

```ts
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
```

### 13. `deno check` may fail on older config code

Deno 2 types `catch (error)` variables as `unknown`. Version 4's example
`rethrowCatchInAuth(error: CustomError)` therefore fails `deno check` with
`Argument of type 'unknown' is not assignable to parameter of type
'CustomError'` at every call site.

`deno run` doesn't type-check in Deno 2, so this won't stop the server. It
will stop `deno check`, and you should run that before every deploy. Change
the helper to accept `unknown`:

```ts
export function rethrowCatchInAuth(error: unknown): never {
    if (error instanceof Error && knownErrorNames.includes(error.name)) {
        throw error;
    }
    console.error(`ALERT DEVELOPERS! ERROR WAS NOT IN KNOWN ERRORS: ${error instanceof Error ? error.name : typeof error}`);
    throw new UnknownAuthError();
}
```

## Permission changes

Version 5 needs no new permissions for the server itself. Two corrections to
the version 4 documentation apply to both versions:

- **`--allow-write` must cover the directory holding the stats database,**
  not just the file. SQLite creates journal files beside it. Version 4's
  documented file-scoped grant failed at startup. With `--disable-stats`, no
  database is opened and no write permission is needed.
- **The postgres.js driver reads the standard `PG*` environment variables**
  even when the connection URL is complete. Under scoped permissions, grant
  them with the Deno 2 wildcard rather than unrestricted env access:
  `--allow-env=PORT,LISTEN_ADDRESS,PG*`.

## New options

None of these change behaviour unless you use them.

- `--allow-header "Name: Value"` adds a header to every 200 response.
  Repeatable. A proxy can copy it onto the upstream request, so the
  application can refuse anything that bypassed the auth layer. With Caddy:

  ```
  forward_auth localhost:3300 {
      uri {path}
      copy_headers Checkpoint401
  }
  ```

  and start the server with `--allow-header "Checkpoint401: passed"`. This
  replaces any local patch that hard-coded such a header.
- `--allow-encoded-path`, `--no-strict-uri`: see change 3.
- `--endpoint-timeout-ms`, `--max-in-flight`, `--shutdown-timeout-ms`: see
  changes 4, 5 and 12.

## Example config changes

These only affect you if you copied files from this repository's `config/`.

- **djwt 3.** Tokens are verified with a `CryptoKey`, which binds the key to
  HS256. `verify(token, key)` replaces `verify(token, secret, "HS256")`.
- **`JWT_SECRET` must be at least 32 bytes.** The example refuses to start
  otherwise. Generate one with `openssl rand -base64 48`. The template in
  `config/.env.example` is deliberately too short, so a copied template
  cannot run with a public secret.
- **The token must carry a string `id` claim.** Missing or non-string ids
  are denied.
- **Bad or malformed tokens raise `InvalidJwtTokenError`.** Add it to
  `knownErrorNames` in your copy of `customErrors.ts`. Otherwise every
  garbage cookie logs an "ALERT DEVELOPERS" line.
- **Cookie parsing** splits on `;` with optional whitespace, and keeps
  everything after the first `=`.
- **`.env` loading** uses `@std/dotenv` instead of the unmaintained
  `deno.land/x/dotenv`, and resolves the file from `import.meta.dirname`, so
  directories with spaces work.
- **`config/.env` is no longer tracked.** Copy `config/.env.example` to
  `config/.env`. The secrets committed in earlier versions are in public git
  history and must be treated as compromised.

## Upgrade procedure

This is the procedure used for a production upgrade, including the problems
it turned up.

1. **Stage the new version beside the old one.** Copy the new
   `checkpoint401.ts` and `deno.json` into a staging directory along with
   your config.
2. **Update your config** for changes 12 and 13, and anything under
   [Example config changes](#example-config-changes) that applies.
3. **Generate the lock and type-check** in the staging directory:

   ```bash
   deno install --entrypoint --frozen=false checkpoint401.ts config/*.ts
   deno check checkpoint401.ts config/*.ts
   ```

4. **Run the staged copy on a spare port** with the exact permissions and
   flags you will use in production. Under systemd, run it as a temporary
   unit with the same sandbox directives, because a sandbox problem only
   shows up there.
5. **Exercise it.** Send an anonymous request, a protected request without a
   cookie, a protected request with a real session cookie, and a traversal
   attempt such as `/protected\..\..\public`. Expect 200, 401, 200 and 401.
6. **Swap it in.** Stop the old service, keep the old directory as a
   timestamped backup, move the staged directory into place, install the new
   unit file and start. Copy the stats database across if its location
   changed.
7. **Verify through the proxy**, not just directly, and watch the log for
   `Rejected request` lines over the first day.

### Lessons from the production upgrade

- **`SystemCallFilter` kills Deno.** The example unit file in version 4's
  development history included `SystemCallFilter=@system-service` plus
  `~@privileged @resources`. On Ubuntu 24.04 with Deno 2.7 this killed the
  process with SIGSYS, exit status 31. The filter has been removed from the
  example unit. If you added it yourself, remove it.
- **Run `systemctl reset-failed` before restarting a rolled-back unit.** A
  unit that crash-loops under `Restart=always` hits systemd's start limit.
  After that, `systemctl start` refuses to start even the old, working
  version until the failed state is cleared:

  ```bash
  sudo systemctl reset-failed checkpoint401 && sudo systemctl start checkpoint401
  ```

- **Check health over HTTP, not by grepping the journal.** A request to an
  anonymous route that returns 200 proves the server is listening and
  routing. Header names come back in lower case, so compare them
  case-insensitively.

## Rolling back

Stop the service, restore the previous directory and unit file, clear the
failed state, and start:

```bash
sudo systemctl stop checkpoint401
sudo cp /etc/systemd/system/checkpoint401.service.before-v5 /etc/systemd/system/checkpoint401.service
sudo mv /opt/checkpoint401 /opt/checkpoint401.v5
sudo mv /opt/checkpoint401.before-v5 /opt/checkpoint401
sudo systemctl daemon-reload
sudo systemctl reset-failed checkpoint401
sudo systemctl start checkpoint401
```

Adjust the paths to match your backups. If you moved the stats database for
version 5, version 4 keeps using its old copy, which lacks counts recorded
while version 5 ran.
