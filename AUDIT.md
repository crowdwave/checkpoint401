# Checkpoint 401 — Multi-Technique Audit

This document records the findings from sweeping the codebase with each of the 34 software-analysis techniques (Rounds 1–7) supplied as the methodology brief. The sweep was repeated until additional passes yielded only minor refinements; the final pass produced no new High-or-above findings, only nits already noted under Low/Info, which is the diminishing-returns signal used to terminate the loop.

State analysed: `master` at `c78f93c` (post the 17 compatibility-safe fix commits — earlier issues already addressed there are not re-listed).

> **Status note (post-audit fix sweep):** Many of the findings below have since been addressed in commits `7a566c1`..`34cd5a2`. Skim the commit log between `c78f93c` and `34cd5a2` for the per-finding fixes. Items that remain open are typically those that would break compatibility (dependency upgrades, default-flip on `--strict-uri`/`--quiet`, hot-reload, structured logging, metrics endpoint, mandatory rate-limit) or are operational rather than code (rotating the placeholder secrets in `config/.env`).

## Scope

Files reviewed:
- `checkpoint401.ts` (server entry point, 659 lines)
- `README.md`
- `etc/systemd/system/checkpoint401.service`
- `test.sh`, `routes.json`, `.gitignore`
- `config/*.ts` (eight example endpoint and helper files — these are shipped as templates and are imported at runtime; bugs in them are reported even though operators are expected to substitute their own auth logic)

## Severity scale

- **Critical**: actively exploitable, leads to auth bypass, data loss, or unauthenticated remote impact.
- **High**: serious correctness or security defect; high likelihood of operational impact.
- **Medium**: defect that fires under realistic but specific conditions; meaningful but not catastrophic impact.
- **Low**: minor bug, fragile assumption, doc/UX defect, or housekeeping issue.
- **Info**: nit, style, or future-proofing observation.

Each finding is tagged with the technique(s) that surfaced it.

---

## Critical

None found in the current state. (The original review's H-tier issues were addressed in commits `0765bd8`–`c78f93c`. The closest current candidate is **H-1** below pending verification of the JWT library's algorithm-confusion behaviour.)

---

## High

### H-1. JWT verification algorithm enforcement is unverified in djwt v2.2 (config/checkCookieIsValidReturningUserId.ts:19)

**Techniques:** Secrets & Cryptography (29), Auth Path (26), Adversarial Input (12).

The example cookie validator pins `djwt@v2.2` (released 2021) and calls `verify(token, env.JWT_SECRET, "HS256")`. djwt v2 had multiple changes around algorithm enforcement; some pre-3.x releases trusted the algorithm declared in the JWT header rather than the algorithm passed to `verify`. If v2.2 is one of those, an attacker can submit a token with `alg: none` (or with `alg: HS256` signed with a public key the attacker knows for an asymmetric token) and pass auth.

Verify against the upstream tag, or upgrade to a current djwt release where the algorithm parameter is enforced. If verify confirms vulnerability, this becomes Critical: full auth bypass for anyone using the example endpoints.

### H-2. JWT `exp` / `nbf` claim handling not verified

**Techniques:** Session Lifecycle (31), FMEA (3).

The validator returns `decoded.id` directly from `verify`. djwt v2.2's `verify` should reject expired tokens, but the code does not assert it. If the library tolerates missing `exp` or doesn't check it, every token issued is valid forever. Session revocation is also impossible (no deny-list, no rotation). For a JWT-based scheme this is the entire lifecycle layer.

### H-3. `DatabaseManager` swallows every operational failure (checkpoint401.ts:46–101)

**Techniques:** Completeness/Error Path (20), FMEA (3).

`createTableIfNotExists`, `insertInitialStats`, and `updateDatabase` each wrap their work in `try { ... } catch (error) { console.error(...) }`. If the SQLite file is read-only, the table can't be created, the disk is full, or the schema drifts, the server logs once and silently keeps serving — but stats never persist, and any future code path that depends on the table existing will fail in confusing ways. For an auth sidecar the right behaviour is fail-loud at startup; today the operator only finds out by noticing the DB is empty days later. Propagate the error from `createTableIfNotExists` and surface failures at startup.

### H-4. Endpoint functions have no execution timeout (checkpoint401.ts:336)

**Techniques:** DoS / Resource Exhaustion (33), Temporal Logic (7), FMEA (3).

`createEndpointFunctionProxy` does `await target(...argumentsList)` with no timeout wrapper. A buggy or malicious endpoint that hangs (`new Promise(() => {})`, blocking DB query, slow remote call) ties up the request forever. A reverse proxy will eventually time out the subrequest, but the in-flight handler in checkpoint401 keeps running until the endpoint resolves or the process dies. With concurrent slow requests the server accumulates pending Promises until OOM. Wrap the call in `Promise.race` against a configurable timeout (default ~5s) and fail-closed on expiry.

### H-5. Log injection via decoded URL match-groups (checkpoint401.ts:250, config/customErrors.ts:91, config/authFunc...Channel.ts:23)

**Techniques:** Information Flow / Taint Tracking (6), Side-Channel & Error Leakage (34), Adversarial Input (12).

`makeResponse` logs `request.url` verbatim. `--strict-uri` (opt-in) rejects raw CR/LF/NUL in the header value but does not account for URL-encoded forms (`%0A`, `%0D`, `%00`). `URLPattern` extracts named groups by URL-decoding pathname segments. So `/api/v1/wave/newwave/foo%0AALERT%20admin%20granted` yields a `channel_id` group containing a literal newline, and `InternalApplicationError(...)` interpolates that into a multi-line `console.error`. An attacker can forge log entries (e.g. fake "auth granted" lines) to obscure their activity. Sanitise log inputs (`replace(/[\r\n\0]/g, '�')`) at every log site, or use structured logging that escapes by default.

### H-6. Postgres connection is not gracefully closed on shutdown (config/db.ts:14–27 vs checkpoint401.ts:642–647)

**Techniques:** Resource Leak (11), Signal/Shutdown Boundary (17), Coupling (19).

Two signal handlers are registered: `config/db.ts` registers an async handler that does `await sql.end({timeout: 5})` then `Deno.exit()`; `checkpoint401.ts` registers a sync handler that does `dbManager.close(); Deno.exit()`. Deno fires listeners in registration order. Because the example endpoints (loaded during `setupRoutes`, line 640) transitively import `config/db.ts`, db.ts's handler registers FIRST. When SIGTERM arrives:

1. db.ts handler starts, hits `await sql.end(...)` and yields.
2. Main handler runs, calls `dbManager.close()` and synchronously `Deno.exit()`.
3. Process dies before `sql.end` completes — Postgres connection abandoned.

Long-running deployments leak a Postgres backend per restart. Either centralise shutdown in one place, or have main's handler `await` cleanup before exiting (and remove db.ts's exit).

---

## Medium

### M-1. `setTimeout` with delay > 2³¹−1 ms fires immediately, hot-looping the periodic flush (checkpoint401.ts:438–445, 238)

**Techniques:** Boundary / Equivalence Partitioning (8), Arithmetic Correctness (23), Symbolic Execution (9).

`validateUpdatePeriod` accepts any number ≥ 1000. `setTimeout` in V8 internally uses a 32-bit signed int; values > `2^31 - 1` (≈ 24.8 days) silently degrade to `1 ms`. So `--update-period 3000000000` (≈ 35 days) results in `updateDatabasePeriodically` re-firing every event-loop tick, pegging CPU. Same hazard with `--update-period 1e1000` (`Number(...)` returns `Infinity`, validation passes, `setTimeout(fn, Infinity)` ⇒ `1 ms`). Cap the upper bound (e.g. ≤ 24 days) and reject `Infinity`/`NaN`/non-finite explicitly.

### M-2. Cookie parsing splits on the wrong delimiter (config/checkCookieIsValidReturningUserId.ts:16)

**Techniques:** Protocol Conformance (10), Input Canonicalization (28), Adversarial Input (12).

`cookies.split("; ")` requires the literal sequence `space + ; + space` between cookies. RFC 6265 specifies the separator as `; ` but real-world clients and proxies sometimes emit just `;`. A request whose Cookie header is `a=1;token=xxx` (no space) falls through `find(c => c.startsWith("token="))` because the matching element is `;token=xxx`. The user is silently denied. Use `cookies.split(/;\s*/)`.

### M-3. JWT cookie is split on the first `=`, truncating values that contain `=` (config/checkCookieIsValidReturningUserId.ts:18)

**Techniques:** Boundary (8), Input Canonicalization (28).

`jwtCookie.split("=")[1]` returns only the second element. RFC 7519 base64url JWTs do not pad with `=`, so today this works, but if the issuing layer (or a proxy that base64-encodes wrapped values) ever produces a value containing `=`, the token is silently truncated and verification fails — a denial-of-service that looks like "auth is broken for some users". Use `jwtCookie.slice(jwtCookie.indexOf("=") + 1)`.

### M-4. `dotenv` `.env` path is resolved relative to cwd (config/checkCookieIsValidReturningUserId.ts:5, config/db.ts:5)

**Techniques:** FMEA (3), Coupling (19), Trust Boundary (25).

`config({path: ".env"})` reads `.env` from `Deno.cwd()`. With `--config-dir` set, the cwd may not be the config dir, and the `.env` file is silently absent: `env.JWT_SECRET` is undefined and `JwtSecretNotSetError` is thrown on every request. The systemd unit pins `WorkingDirectory=/opt/checkpoint401/config` so it works there, but anyone who runs from a different directory loses all auth. Resolve relative to the script or to `applicationOptions.currentWorkingDir`.

### M-5. Periodic flush can break its own setTimeout chain on bad invariants (checkpoint401.ts:211–216)

**Techniques:** Liveness / Temporal Logic (7), Completeness/Error Path (20).

`updateDatabasePeriodically` validates `dbManager` and `updatePeriod` BEFORE the `try/finally`. If they ever fail (today they can't, in future they might if anyone refactors), the throw escapes. Because the function is invoked from `setTimeout`, the rejection is unhandled and the next flush is never scheduled — counters leak forever from then on, silently. Move the validation inside the try, or fail at startup once.

### M-6. Snapshot is lost when `updateDatabase` fails (checkpoint401.ts:217–235, 80–96)

**Techniques:** Idempotency (14), FMEA (3), Completeness/Error Path (20).

The snapshot/clear/write reorder fixed the future-async race, but introduces a new failure mode: the snapshot is cleared from the in-memory counters BEFORE the write. If `updateDatabase` throws (DB locked, disk full, query error), the catch logs and returns; the snapshot data is gone from memory and never reached the DB. Stats data loss per failed flush. On error, fold the snapshot's counts back into the live counters before continuing.

### M-7. Per-route updates aren't atomic; partial failure silently loses data (checkpoint401.ts:80–96)

**Techniques:** Idempotency (14), Concurrency (4).

`updateDatabase` iterates routes and runs an UPDATE per route. The catch is around the whole loop, so if route #5 throws, routes #6..N are skipped and lose their counts (and combined with M-6 the snapshot is also gone). Wrap the loop in a transaction (`BEGIN`/`COMMIT`), or at least re-fold un-flushed routes into in-memory counters on error.

### M-8. Stats DB ordering: periodic flush is scheduled before initial rows exist (checkpoint401.ts:196–197)

**Techniques:** State Machine Analysis (2), Symbolic Execution (9).

`updateDatabasePeriodically(...)` is invoked (line 196) before `await dbManager.insertInitialStats(...)` (line 197). The first periodic update can race with the initial insert: `UPDATE` against rows that don't exist yet is a no-op and the in-memory counters are nevertheless cleared. Counts during the first ~10 seconds vanish. Move the schedule call below `insertInitialStats`.

### M-9. Shutdown does not flush in-memory counters (checkpoint401.ts:642–645)

**Techniques:** Signal/Shutdown Boundary (17), FMEA (3), Observability (24).

`shutdown` calls `dbManager.close()` then `Deno.exit()`. Counters accumulated since the last periodic flush (up to the full `updatePeriod`, default 10s × N routes × QPS) are dropped. For a service that restarts on every deploy this is a guaranteed stats hole. Snapshot+flush in the shutdown handler before close.

### M-10. Shutdown does not drain in-flight requests (checkpoint401.ts:642–648)

**Techniques:** Signal/Shutdown Boundary (17), Liveness (7).

`Deno.serve` is never gracefully shut down. SIGTERM aborts in-flight subrequests, so the reverse proxy sees connection resets during normal restarts and may treat them as auth failures (denying real users). Use `Deno.serve(...).shutdown()` and await it before `Deno.exit()`.

### M-11. URL-encoded CR/LF bypass `--strict-uri` (checkpoint401.ts:580–597)

**Techniques:** Input Canonicalization (28), Information Flow (6), Adversarial Input (12).

`validateInboundUri` rejects raw `\r\n\0`. It does not check decoded forms (`%0A`, `%0D`, `%00`). `URLPattern` URL-decodes path segments before binding to named groups, so the decoded values still flow into logs and error messages. Either decode before validation, or validate the post-decoded match-group values where they're consumed.

### M-12. Adversary-controlled `--header-name-uri` value bypasses checks if the proxy forwards it (checkpoint401.ts:265, 510–517)

**Techniques:** Trust Boundary (25), Confused Deputy (32).

The header NAME is operator-config; the header VALUE is taken whole from `request.headers.get(...)`. Standard NGINX `proxy_set_header X-Forwarded-Uri $request_uri;` overrides any inbound value. But Caddy `header_up` semantics differ: if the operator does not explicitly drop the inbound header, a client-supplied `X-Forwarded-Uri: /admin` is forwarded and trusted. Document this as a setup requirement and consider rejecting if the header appears more than once.

### M-13. No request-body size or header-size limits (Deno.serve defaults; checkpoint401.ts:648)

**Techniques:** DoS / Resource Exhaustion (33), Adversarial Input (12).

`Deno.serve` is invoked with no size or rate limits. An attacker that can reach the auth port can send an oversized header (multi-MB `X-Forwarded-Uri`) repeatedly. URLPattern matches it linearly; CPU and memory spike. Cap `--strict-uri`'s 8192-char URI limit applies only when the flag is opt-in. Add per-request memory limits at the listener level or, at minimum, enforce strict-uri by default in a future major version.

### M-14. No rate limiting and no max in-flight (checkpoint401.ts:648–651)

**Techniques:** DoS / Resource Exhaustion (33), Stress Pattern (16).

A single attacker on the same network can exhaust DB connections (Postgres pool, sqlite mutex), peg CPU on URLPattern matching, and fill memory with pending Promises. There is no per-IP or per-process throttle. For an auth sidecar that's typically only behind a proxy this is acceptable — but the README does not tell operators to add a rate-limit layer.

### M-15. `displayHelp()` documents stale field names that no longer match `routes.json` (checkpoint401.ts:373–382)

**Techniques:** Semantic Gap (21), Regression (18), API Surface (22).

The help text says route entries take `route` and `file` fields and live in `endpoints/`/`auth/` subdirectories. The actual schema is `routeURLPattern` / `routeEndpointTypeScriptFile` and the directory is `config/`. Operators following `--help` will write a `routes.json` that fails the new schema validation. Re-write the help block to match the README and the validation logic.

### M-16. `--header-name-uri` and `--header-name-method` accept the empty string (checkpoint401.ts:510–527)

**Techniques:** Boundary (8), API Surface (22).

`--header-name-uri ""` is accepted; subsequent `request.headers.get("")` returns `null` for every request and 401 is returned for everything. Same for the method header. The misconfiguration is invisible until production traffic arrives. Validate that header names are non-empty and contain only token characters per RFC 7230.

### M-17. `--header-name-uri` and `--header-name-method` may be set to the same value (checkpoint401.ts:510–527)

**Techniques:** API Surface (22), FMEA (3).

There is no check that the URI and method headers differ. If both end up `"X-Forwarded-Uri"`, the method comparison reads the URI value, no route ever matches, every request is 404. Validate that the two header names differ at parse time.

### M-18. JWT/cookie Cookie header parsing is case-sensitive on `token=` prefix (config/checkCookieIsValidReturningUserId.ts:16)

**Techniques:** Input Canonicalization (28), Protocol Conformance (10).

Per RFC 6265 cookie names are case-sensitive — the prefix match is technically correct — but combined with M-2 it is fragile to upstream renaming. Document the cookie-name contract or accept a configurable name.

### M-19. Verbose log line discloses the full inbound URL including query string (checkpoint401.ts:249–250)

**Techniques:** Side-Channel (34), Secrets (29), Observability (24).

The log includes `request.url`, which is the value of `X-Forwarded-Uri`. Real applications often pass session tokens, password-reset tokens, OAuth codes, and PII in query strings. With `--quiet` not set (the default), every such token reaches stdout/journald. Either redact query strings by default in verbose logs, or flip the default to quiet in a future major version.

---

## Low

### L-1. The verbose-log default is on, but `--verbose` is also still a flag with no inverse pairing (checkpoint401.ts:457–462)

**Techniques:** API Surface (22).

`--verbose` and `--quiet` both exist; if both are passed, the last one wins silently. Detect the conflict at parse time, like `--port` already does for env vs CLI.

### L-2. Duplicate flags use last-wins with no detection (checkpoint401.ts:450–545)

**Techniques:** API Surface (22).

`--port 3000 --port 4000` accepts and uses `4000`. Same for every value-bearing flag. Operators with buggy invocation scripts get the wrong config. Track the set of seen flags and reject duplicates.

### L-3. Linear `O(N)` route scan with redundant `pattern.test() + pattern.exec()` (checkpoint401.ts:308–314)

**Techniques:** Stress Pattern (16), Semantic Gap (21).

For every iteration of every request, both `.test(...)` and `.exec(...)` are called. `.exec` returns null on no-match, so `.test` is redundant. Also the no-arg `dummyBaseURL = "http://www.example.org"` literal is allocated per iteration. Hoist it to module scope and drop the `.test` call.

### L-4. `routerInternalRoute` interface name is also used as the loop variable name inside the same method (checkpoint401.ts:257–261, 308)

**Techniques:** Semantic Gap (21), Coupling (19).

Lower-case-leading interface name colliding with iteration variable name is a maintainability hazard — TS doesn't complain because of namespace separation, but readers do. Rename the interface to `RouteEntry`.

### L-5. `console.log` of the function reference at line 188

**Techniques:** Observability (24), Semantic Gap (21).

`console.log(routeConfig.method, routeConfig.routeURLPattern, endpointFunctionProxy);` prints a Proxy object stringification — pure noise. Remove it.

### L-6. Error message at line 339 references the wrong field

**Techniques:** Semantic Gap (21).

`Function: ${routeConfig.routeURLPattern}` should be `Function: ${routeConfig.routeEndpointTypeScriptFile}`. Same field is already printed as `Route` earlier in the same string.

### L-7. `UnknownAuthError` constructor unconditionally logs the stack trace (config/customErrors.ts:71–77)

**Techniques:** Observability (24), Side-Channel (34).

Every construction (which can happen on every failed auth) logs the full stack via `console.error(this.stack)`. Even if the caller catches and ignores it, the log grew. Move the log to the actual catch site, or gate it on a verbose flag.

### L-8. `rethrowCatchInAuth` is annotated as returning the input but actually never returns (config/customErrors.ts:20)

**Techniques:** Contract Verification (1), Semantic Gap (21).

It always throws. The signature `function rethrowCatchInAuth(error: CustomError)` should be `: never`. As written, callers like `throw rethrowCatchInAuth(error)` (line 30) work only because the throw is unreachable.

### L-9. Useless try/catch wrappers that just re-throw (checkpoint401.ts:263–285)

**Techniques:** Semantic Gap (21).

`getInboundUriFromHeaders` and `getInboundMethodFromHeaders` each wrap the body in `try { ... } catch (error) { throw error; }`. Removes nothing, adds noise, masks future maintenance because readers expect the catch to do something.

### L-10. Top-of-file usage block is stale (checkpoint401.ts:5–27)

**Techniques:** Semantic Gap (21), Regression (18).

The block lists `--config-dir`, `--db-filename`, `--update-period`, `--disable-stats`, `--header-name-uri`, `--header-name-method`, `--version`, `--help`. Missing: `--verbose`, `--quiet`, `--strict-uri`, `--no-error-body`, `--port`, `--listen-address`. Also says "deno run --allow-net --allow-read --allow-write" — `--allow-env` was added to the README but not here.

### L-11. README links to a file that does not exist (README.md:170)

**Techniques:** Regression (18), Semantic Gap (21).

The link `https://github.com/crowdwave/checkpoint401/blob/master/config/getUserIdFromRequest.ts` 404s — the actual file in the repo is `checkCookieIsValidReturningUserId.ts`. Update the link.

### L-12. `test.sh` targets a port the server never listens on (test.sh:4)

**Techniques:** Regression (18).

`SERVER_URL="http://localhost:4401"` while the code default is `3000`. The script also hits routes (`/api/users`, `/api/post`) that aren't in the example `routes.json`. Rewrite or delete.

### L-13. `.gitignore` is incomplete (.gitignore:1–4)

**Techniques:** FMEA (3), Secrets (29).

Only `.idea/` is ignored. `.env` (which contains `JWT_SECRET` and `DATABASE_URL`), `route_stats_counters.db`, and `.DS_Store` are not ignored. The `.DS_Store` file is already present in the working tree (visible in `ls -la`). Add `.env`, `*.db`, `.DS_Store` to prevent accidental commits.

### L-14. Debug `console.log` left in shipped example (config/authFuncSignedInUserMustBeAMemberOfTheChannel.ts:25)

**Techniques:** Observability (24), Semantic Gap (21).

`console.log(isUserAMemberOfChannel)` — bare boolean dump. Remove.

### L-15. `addSignalListener("SIGTERM", ...)` will throw on Windows (checkpoint401.ts:646–647)

**Techniques:** FMEA (3), Cross-platform.

POSIX signals are not available on Windows; Deno throws on `addSignalListener("SIGTERM", ...)`. The `try/catch` pattern used in `config/db.ts:22-26` is correct; the main file does not have it. Either gate on `Deno.build.os` or wrap in try/catch.

### L-16. Empty `routes.json` produces a server that 404s every request silently (checkpoint401.ts:135–203)

**Techniques:** FMEA (3), Boundary (8), Observability (24).

A zero-length route array passes validation, the server starts, and every request gets 404. The reverse proxy treats that as deny and the operator sees "all auth fails" with no startup error. Refuse to start if the array is empty, or at least log a prominent warning.

### L-17. JWT verification happens AFTER `getUserId` extraction, but failures are normalised to a single "Unknown auth error" (checkpoint401.ts:344–347)

**Techniques:** Side-Channel (34), Observability (24).

`createEndpointFunctionProxy`'s catch turns any thrown error into `errorMessage: "Unknown auth error"`. That is good for clients (no enumeration) but bad for operators (no signal in the response, only in logs). Combined with the lack of structured logging it's hard to correlate. Add an internal request-id in the response header (without exposing the message).

### L-18. The `403` status is never used; Caddy's forward_auth treats 403 as "deny without retry" semantics differently from 401 (checkpoint401.ts:202, 254, 326)

**Techniques:** Protocol Conformance (10).

The server only emits `200/401/404`. For some proxies, distinguishing "request was malformed" from "credentials were wrong" matters. Consider 400 for header-validation failures from `--strict-uri`, 401 only for credential failure.

### L-19. `Number(" 3000 ")` (whitespace) is accepted as a port (checkpoint401.ts:429–435)

**Techniques:** Boundary (8).

`Number` strips whitespace. Probably harmless, but inconsistent with strict-typing elsewhere. Use `parseInt(port, 10)` and check the full string matched.

### L-20. Top-of-file VERSION constant is not surfaced anywhere except `--version`, and is not stored in the DB (checkpoint401.ts:3)

**Techniques:** Migration (15), Observability (24).

The DB schema has no version row. If a future release changes columns, there's no way to detect. Add a `schema_version` table and check it at startup.

### L-21. `URLPattern` errors at route registration aren't reported with which entry they belong to (checkpoint401.ts:301)

**Techniques:** Completeness/Error Path (20), Semantic Gap (21).

`new URLPattern({pathname: routeURLPattern})` can throw `TypeError: Invalid URL pattern` for malformed patterns. The throw goes to the outer catch with no index/route information. Wrap in try and re-throw with the offending entry.

### L-22. `setupRoutes` triple-logs each loaded route (checkpoint401.ts:182, 188, 190)

**Techniques:** Observability (24).

Three `console.log` lines per route at startup. With many routes this is verbose noise. Collapse to one structured line.

### L-23. `routes.json` is read twice (checkpoint401.ts:105 and 140)

**Techniques:** Coupling (19), FMEA (3).

`setupRoutes` and `loadAdditionalTsFiles` each `Deno.readTextFile` and `JSON.parse` it. If the file is replaced between the two reads, the two views disagree. Pass the parsed array from `setupRoutes` into `loadAdditionalTsFiles`.

### L-24. `loadAdditionalTsFiles` continues on per-file import failure (checkpoint401.ts:114–122)

**Techniques:** Completeness/Error Path (20), FMEA (3).

A syntax error in any helper file is logged and then ignored — the server starts up "successfully" but with the helper missing. Endpoint imports that depend on it then crash at first request. Either fail-loud, or log a startup summary that highlights skipped files.

### L-25. `isNaN(Infinity)` is false; `--update-period 1e1000` slips through (checkpoint401.ts:438–445)

**Techniques:** Boundary (8), Arithmetic Correctness (23).

Same root as M-1 but worth listing separately for the parser. `Number.isFinite` is the correct guard; `isNaN` is not.

### L-26. There is no test suite, no Deno test config, and no CI config

**Techniques:** Regression (18), Mutation Testing (13).

`test.sh` is three uncoordinated curls. There are no `*_test.ts` files. The mutation-testing perspective: any of the bugs in this document could be planted as a one-line change and would pass review with no automated detection. Add at minimum a smoke test that boots the server with a fixture `routes.json` and exercises 200/401/404.

### L-27. 401 responses lack a `WWW-Authenticate` header (checkpoint401.ts:254)

**Techniques:** Protocol Conformance (10).

RFC 7235 requires 401 responses to include `WWW-Authenticate`. Forward-auth deployments usually don't care (the proxy translates the response into its own challenge), but pure HTTP clients see a non-conformant response.

---

## Info

### I-1. `dummyBaseURL` constant duplicated per request iteration

(See L-3.) Hoist once.

### I-2. `setupRoutes` catches and re-throws, then `runServer` catches and logs again (checkpoint401.ts:199–202, 652–655)

**Techniques:** Observability (24).

Single failure produces two `console.error` lines with the same content. Pick one layer to own the log.

### I-3. `dotenv` v3.2.2, `deno-sqlite` v3.8, `postgresjs` v3.4.4 are all 2022–2023 vintage

**Techniques:** Migration (15), FMEA (3).

Audit each for known vulnerabilities and update. Pinning to old versions of unmaintained or moved-around deno.land/x packages is fragile.

### I-4. Comment typo "this MEANT to be" should be "this is MEANT to be" (checkpoint401.ts:309)

**Techniques:** Semantic Gap (21).

### I-5. `loadAdditionalTsFiles` re-imports already-cached modules

**Techniques:** Stress Pattern (16).

The `excludeFiles` fix correctly excludes route entries. Helpers transitively imported by route endpoints are still re-imported here; ESM caches dedupe so the second `import()` resolves to the cached module. No correctness impact, but each file is `stat`'d twice on startup. Pre-build a cached set.

### I-6. No SIGHUP handling

**Techniques:** Signal/Shutdown Boundary (17).

`SIGHUP` defaults to terminating the process. Some operators expect SIGHUP for "reload config without restart". Currently impossible (no hot reload). Document, or implement a reload of `routes.json`.

### I-7. No structured logging

**Techniques:** Observability (24).

All logs are unstructured `console.log`. Aggregators (Loki, ELK) need parsing. Switch to JSON-line logging when `--quiet` is off, or always.

### I-8. Hot reload of `routes.json` is not supported

**Techniques:** API Surface (22).

A new route requires a server restart, which (per M-10) drops in-flight requests. Either support reload, or document the restart cost.

### I-9. No metrics endpoint or Prometheus exporter

**Techniques:** Observability (24).

`route_stats_counters.db` accumulates counts but the only way to read them is to open the SQLite file. An exposed `/metrics` endpoint (gated by allow-list) would help operators.

### I-10. Endpoint contract type is duplicated as inline type at line 315

**Techniques:** Coupling (19).

`{ success: boolean; errorMessage?: string; }` is declared as the `EndpointFunction` type alias on line 29 and again inline on line 315. Use the alias.

### I-11. The `excludeFiles` set is keyed on `routeEndpointTypeScriptFile` (a flat filename) but `dirEntry.name` could differ in case on case-insensitive filesystems

**Techniques:** Cross-platform, Boundary (8).

On macOS HFS+ default and on Windows NTFS, `Foo.ts` and `foo.ts` collide. The exclude set won't dedupe them. Low impact since the actual import is also case-insensitive on those filesystems and ESM caches handle it.

### I-12. `applicationOptions` is mutated through a shared reference in tests' absence

**Techniques:** Coupling (19).

`URLPatternRouter` stores `applicationOptions` and reads `verbose` / `suppressErrorBody` on each request. If anyone ever mutates the options object after server start, the router observes the change immediately. No bug today, but a fragile contract.

---

## Methodology recap

Each technique below was applied at least once across the whole codebase. Multiple passes were performed; the table records the loop where the technique stopped surfacing new findings (i.e. where returns went to zero).

| # | Technique | First pass yield | Stable at pass |
|---|-----------|------------------|----------------|
| 1 | Contract Verification | H-3, M-5, L-8 | 2 |
| 2 | State Machine Analysis | M-8 | 2 |
| 3 | FMEA | H-3, H-4, M-4, M-9, L-13, L-15, L-16, L-23, L-24 | 3 |
| 4 | Concurrency / Happens-Before | M-6, M-7 (no pure data race in single-thread JS, but interleaving issues) | 2 |
| 5 | Invariant Verification | L-16 | 2 |
| 6 | Information Flow / Taint | H-5, M-11, M-19 | 3 |
| 7 | Temporal Logic / Liveness | H-4, M-5, M-10 | 2 |
| 8 | Boundary / Equivalence | M-1, M-16, L-19, L-25, I-11 | 3 |
| 9 | Symbolic Execution | M-1, M-8 | 2 |
| 10 | Protocol Conformance | M-2, L-18, L-27 | 2 |
| 11 | Resource Leak | H-6, M-10 | 2 |
| 12 | Adversarial Input (Fuzzing) | H-5, M-11, M-13 | 3 |
| 13 | Mutation Testing | L-26 | 1 |
| 14 | Idempotency | M-6, M-7 | 2 |
| 15 | Migration / Upgrade | L-20, I-3 | 1 |
| 16 | Stress Pattern | L-3, M-14, I-5 | 2 |
| 17 | Signal / Shutdown Boundary | H-6, M-9, M-10, L-15, I-6 | 3 |
| 18 | Regression | M-15, L-10, L-11, L-12, L-26 | 2 |
| 19 | Coupling | H-6, L-23, I-10, I-12 | 2 |
| 20 | Completeness / Error Path | H-3, L-21, L-24 | 2 |
| 21 | Semantic Gap | M-15, L-4, L-5, L-6, L-7, L-9, L-10, L-22, I-4 | 3 |
| 22 | API Surface | M-15, M-16, M-17, L-1, L-2, I-8 | 3 |
| 23 | Arithmetic Correctness | M-1, L-25 | 2 |
| 24 | Observability | M-9, L-7, L-17, L-22, I-2, I-7, I-9 | 3 |
| 25 | Trust Boundary | M-12 | 2 |
| 26 | Auth/Authz Path | H-1 | 2 |
| 27 | Injection Surface | (none beyond H-5) | 1 |
| 28 | Input Canonicalization | M-2, M-3, M-11, M-18 | 3 |
| 29 | Secrets & Cryptography | H-1, M-19, L-13 | 2 |
| 30 | Privilege Escalation / Isolation | (single-tenant; n/a) | 1 |
| 31 | Session & State Lifecycle | H-2 | 1 |
| 32 | SSRF / CSRF / Confused Deputy | M-12 | 1 |
| 33 | DoS / Resource Exhaustion | H-4, M-13, M-14 | 2 |
| 34 | Side-Channel / Error Leakage | H-5, L-7, L-17 | 2 |

A fourth pass was performed against the master file looking for leftovers; it surfaced only style refinements (already captured in Info), confirming diminishing returns. No "fix everything" pass was run — this document is read-only by request.

## Summary counts

- Critical: 0
- High: 6 (H-1 to H-6)
- Medium: 19 (M-1 to M-19)
- Low: 27 (L-1 to L-27)
- Info: 12 (I-1 to I-12)

Total: 64 distinct findings.
