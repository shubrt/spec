#!/usr/bin/env bash
# Captures the empirical evidence Task A2 of the plan asks for, once a real
# Clerk instance (see SETUP.md) and a running zpecs web service exist. This script is
# deliberately outside `vp test` and CI — it talks to a live Clerk instance
# and reads a live server, neither of which exists at the time Task A2 was
# written. Nothing here is a stand-in for that evidence: every section either
# prints the real thing or fails loudly and stops, on the theory that a
# script that prints something plausible-looking on missing credentials is
# worse than one that refuses to run.
#
# Usage:
#   CLERK_PUBLISHABLE_KEY=pk_live_... \
#   ZPECS_BASE_URL=http://localhost:3004 \
#   ZPECS_ACCESS_TOKEN=eyJ... \
#     libs/api/src/integration/clerk/verify.sh
#
# CLERK_PUBLISHABLE_KEY is required. ZPECS_BASE_URL defaults to
# http://localhost:3004 (apps/web's default PORT). ZPECS_ACCESS_TOKEN is
# optional — omit it to skip section 4 (token claim inspection); every other
# section still runs.

set -euo pipefail

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v bun >/dev/null 2>&1 || fail "bun is required (used to decode base64url and pretty-print JSON) and is not on PATH."
command -v curl >/dev/null 2>&1 || fail "curl is required and is not on PATH."

: "${CLERK_PUBLISHABLE_KEY:=}"
if [ -z "${CLERK_PUBLISHABLE_KEY}" ]; then
  fail "CLERK_PUBLISHABLE_KEY is not set. Export the real pk_test_/pk_live_ key from the Clerk dashboard (see SETUP.md) — there is nothing this script can check without it."
fi
if [ "${CLERK_PUBLISHABLE_KEY}" = "pk_test_placeholder_not_wired_in_yet" ]; then
  fail "CLERK_PUBLISHABLE_KEY is still the .env placeholder. Complete SETUP.md steps 1-4 and put the real key in apps/web/.env (exported into this shell) before running this script."
fi
case "${CLERK_PUBLISHABLE_KEY}" in
  pk_test_*|pk_live_*) ;;
  *) fail "CLERK_PUBLISHABLE_KEY does not start with pk_test_ or pk_live_ — got a value that is not a Clerk publishable key." ;;
esac

ZPECS_BASE_URL="${ZPECS_BASE_URL:-http://localhost:3004}"

FAPI_URL="$(bun -e '
  const key = process.env.CLERK_PUBLISHABLE_KEY;
  const normalized = key.replace(/^pk_(test|live)_/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  console.log(`https://${atob(padded).replace(/\$/, "")}`);
')"

echo "== Derived Clerk Frontend API domain =="
echo "${FAPI_URL}"
echo

echo "== 1. Clerk instance's real authorization-server metadata =="
echo "GET ${FAPI_URL}/.well-known/oauth-authorization-server"
curl -sS -f "${FAPI_URL}/.well-known/oauth-authorization-server" | bun -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(d), null, 2)));
' || fail "Could not fetch Clerk's own authorization-server metadata. Check CLERK_PUBLISHABLE_KEY and network access."
echo

echo "== 2. zpecs' protected-resource metadata (RFC 9728) =="
echo "GET ${ZPECS_BASE_URL}/.well-known/oauth-protected-resource/mcp"
curl -sS -f "${ZPECS_BASE_URL}/.well-known/oauth-protected-resource/mcp" | bun -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(d), null, 2)));
' || fail "Could not fetch zpecs' own protected-resource metadata. Is apps/web running at ${ZPECS_BASE_URL}?"
echo

echo "== 3. zpecs' authorization-server passthrough =="
echo "GET ${ZPECS_BASE_URL}/.well-known/oauth-authorization-server"
curl -sS -f "${ZPECS_BASE_URL}/.well-known/oauth-authorization-server" | bun -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(d), null, 2)));
' || fail "Could not fetch zpecs' own authorization-server passthrough. Is apps/web running at ${ZPECS_BASE_URL}?"
echo

echo "== 4. Access token claims: does org_id / org_role appear? =="
if [ -z "${ZPECS_ACCESS_TOKEN:-}" ]; then
  echo "SKIPPED: ZPECS_ACCESS_TOKEN is not set. This step needs a real access token"
  echo "issued by completing the OAuth flow with an MCP client against the now-live"
  echo "Clerk instance — there is no way to script obtaining one. Re-run with"
  echo "ZPECS_ACCESS_TOKEN=<token> once you have completed that flow once."
else
  bun -e '
    const token = process.env.ZPECS_ACCESS_TOKEN;
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.error("FAIL: ZPECS_ACCESS_TOKEN does not look like a JWT (expected 3 dot-separated segments).");
      process.exit(1);
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    console.log(JSON.stringify(payload, null, 2));
    console.log();
    console.log(`org_id present:   ${Object.prototype.hasOwnProperty.call(payload, "org_id")}`);
    console.log(`org_role present: ${Object.prototype.hasOwnProperty.call(payload, "org_role")}`);
  ' || fail "Could not decode ZPECS_ACCESS_TOKEN."
fi
