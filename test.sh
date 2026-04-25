#!/bin/bash
# Smoke test for a locally-running checkpoint401 server.
# Adjust SERVER_URL, header names, and route paths to match your setup.

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
URI_HEADER="${URI_HEADER:-X-Forwarded-Uri}"
METHOD_HEADER="${METHOD_HEADER:-X-Forwarded-Method}"

echo "Testing GET /api/v1/auth/signin (should pass via authFuncAnonymous)..."
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" \
  -H "${URI_HEADER}: /api/v1/auth/signin" \
  -H "${METHOD_HEADER}: GET" \
  "$SERVER_URL/"

echo "Testing GET /unconfigured/path (should 404)..."
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" \
  -H "${URI_HEADER}: /unconfigured/path" \
  -H "${METHOD_HEADER}: GET" \
  "$SERVER_URL/"
