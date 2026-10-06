#!/bin/bash
# Smoke test for a locally-running checkpoint401 server.
# Adjust SERVER_URL, header names, and route paths to match your setup.
# Exits non-zero if any expectation fails.

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
URI_HEADER="${URI_HEADER:-X-Forwarded-Uri}"
METHOD_HEADER="${METHOD_HEADER:-X-Forwarded-Method}"
fail=0

expect() { # expect <status> <description> <curl args...>
  local want="$1" desc="$2"; shift 2
  local got
  got=$(curl -sS -o /dev/null -w "%{http_code}" "$@" "$SERVER_URL/")
  if [ "$got" = "$want" ]; then echo "ok   $got  $desc"; else echo "FAIL got $got want $want  $desc"; fail=1; fi
}

expect 200 "GET /api/v1/auth/signin (anonymous route)" -H "${URI_HEADER}: /api/v1/auth/signin" -H "${METHOD_HEADER}: GET"
expect 404 "GET /unconfigured/path (no route)"          -H "${URI_HEADER}: /unconfigured/path" -H "${METHOD_HEADER}: GET"
expect 401 "no forwarded headers at all"
expect 401 "URI header only"                            -H "${URI_HEADER}: /api/v1/auth/signin"
expect 401 "backslash traversal onto anonymous route"   -H "${URI_HEADER}: /api/v1/admin/x\\..\\..\\auth\\signin" -H "${METHOD_HEADER}: GET"
expect 401 "dot-segment traversal onto anonymous route" -H "${URI_HEADER}: /api/v1/admin/x/../../auth/signin" -H "${METHOD_HEADER}: GET"
expect 401 "percent-encoded slash"                      -H "${URI_HEADER}: /api/v1/auth%2fsignin" -H "${METHOD_HEADER}: GET"
expect 401 "absolute URL"                               -H "${URI_HEADER}: http://evil.example/api/v1/auth/signin" -H "${METHOD_HEADER}: GET"
expect 401 "protocol-relative URL"                      -H "${URI_HEADER}: //evil.example/api/v1/auth/signin" -H "${METHOD_HEADER}: GET"
expect 401 "GET /api/v1/channel/info/alice without cookie (protected route)" -H "${URI_HEADER}: /api/v1/channel/info/alice" -H "${METHOD_HEADER}: GET"

exit $fail
