#!/usr/bin/env bash
# Captures live evidence for the canonical Clerk instance and a running
# zpecs web service (see SETUP.md). This script deliberately stays outside `vp test`
# and CI because it talks to live services. Every required check either proves
# the real configuration or fails loudly; it never substitutes fixture data.
#
# Usage:
#   CLERK_PUBLISHABLE_KEY=pk_live_... \
#   ZPECS_BASE_URL=http://localhost:3004 \
#   ZPECS_ACCESS_TOKEN=eyJ... \
#     libs/api/src/integration/clerk/verify.sh
#
# CLERK_PUBLISHABLE_KEY is required. ZPECS_BASE_URL defaults to
# http://localhost:3004 (apps/web's default PORT). ZPECS_ACCESS_TOKEN is
# optional — omit it to skip section 4 (safe token-claim inspection); every
# other section still runs. The token and its complete payload are never
# printed.

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
readonly EXPECTED_SCOPES_JSON='["openid","profile","email","user:org:read"]'
export EXPECTED_SCOPES_JSON

check_authorization_server_metadata() {
  local source_name="$1"

  METADATA_SOURCE="${source_name}" bun -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      let metadata;
      try {
        metadata = JSON.parse(input);
      } catch {
        console.error(`FAIL: ${process.env.METADATA_SOURCE} did not return JSON.`);
        process.exit(1);
      }

      const expectedScopes = JSON.parse(process.env.EXPECTED_SCOPES_JSON);
      const registrationEndpoint = metadata.registration_endpoint;
      if (typeof registrationEndpoint !== "string" || registrationEndpoint.length === 0) {
        console.error(
          `FAIL: ${process.env.METADATA_SOURCE} has no registration_endpoint; Clerk DCR is not active.`,
        );
        process.exit(1);
      }

      if (!Array.isArray(metadata.scopes_supported)) {
        console.error(`FAIL: ${process.env.METADATA_SOURCE} has no scopes_supported array.`);
        process.exit(1);
      }
      const missingScopes = expectedScopes.filter(
        (scope) => !metadata.scopes_supported.includes(scope),
      );
      if (missingScopes.length > 0) {
        console.error(
          `FAIL: ${process.env.METADATA_SOURCE} does not support required zpecs scope(s): ${missingScopes.join(", ")}.`,
        );
        process.exit(1);
      }

      console.log(JSON.stringify(metadata, null, 2));
      console.log();
      console.log(`DCR registration endpoint present: ${registrationEndpoint}`);
      console.log(`All required zpecs scopes supported: ${expectedScopes.join(" ")}`);
    });
  '
}

check_protected_resource_metadata() {
  bun -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      let metadata;
      try {
        metadata = JSON.parse(input);
      } catch {
        console.error("FAIL: zpecs protected-resource metadata did not return JSON.");
        process.exit(1);
      }

      const expectedScopes = JSON.parse(process.env.EXPECTED_SCOPES_JSON);
      if (
        !Array.isArray(metadata.scopes_supported) ||
        JSON.stringify(metadata.scopes_supported) !== JSON.stringify(expectedScopes)
      ) {
        console.error(
          `FAIL: zpecs scopes_supported must be exactly ${JSON.stringify(expectedScopes)} in that order.`,
        );
        process.exit(1);
      }

      console.log(JSON.stringify(metadata, null, 2));
      console.log();
      console.log(`zpecs advertises exactly its four required scopes: ${expectedScopes.join(" ")}`);
    });
  '
}

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
curl -sS -f "${FAPI_URL}/.well-known/oauth-authorization-server" \
  | check_authorization_server_metadata "Clerk authorization-server metadata" \
  || fail "Clerk metadata did not prove DCR and all four required zpecs scopes. Check SETUP.md and the Clerk Dashboard."
echo

echo "== 2. zpecs' protected-resource metadata (RFC 9728) =="
echo "GET ${ZPECS_BASE_URL}/.well-known/oauth-protected-resource/mcp"
curl -sS -f "${ZPECS_BASE_URL}/.well-known/oauth-protected-resource/mcp" \
  | check_protected_resource_metadata \
  || fail "zpecs' protected-resource metadata is unavailable or its scopes differ from the required four. Is apps/web running at ${ZPECS_BASE_URL}?"
echo

echo "== 3. zpecs' authorization-server passthrough =="
echo "GET ${ZPECS_BASE_URL}/.well-known/oauth-authorization-server"
curl -sS -f "${ZPECS_BASE_URL}/.well-known/oauth-authorization-server" \
  | check_authorization_server_metadata "zpecs authorization-server passthrough" \
  || fail "zpecs' authorization-server passthrough did not prove DCR and all four required scopes. Is apps/web running at ${ZPECS_BASE_URL}?"
echo

echo "== 4. Safe access-token organization-claim check =="
if [ -z "${ZPECS_ACCESS_TOKEN:-}" ]; then
  echo "SKIPPED: ZPECS_ACCESS_TOKEN is not set. This step needs a real access token"
  echo "issued by completing the OAuth flow with an MCP client. Re-run with"
  echo "ZPECS_ACCESS_TOKEN=<token> after completing that flow once."
else
  bun -e '
    const token = process.env.ZPECS_ACCESS_TOKEN;
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.log(JSON.stringify({ token_present: true, token_format: "opaque" }, null, 2));
      console.error(
        "FAIL: The verified access token is opaque, so zpecs cannot read org_id through its current direct-claim path. Implement the documented userinfo fallback before accepting the live flow.",
      );
      process.exit(1);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      console.error("FAIL: ZPECS_ACCESS_TOKEN has three segments but no readable JSON payload.");
      process.exit(1);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      console.error("FAIL: ZPECS_ACCESS_TOKEN payload is not a JSON object.");
      process.exit(1);
    }

    const stringClaim = (name) =>
      typeof payload[name] === "string" && payload[name].length > 0 ? payload[name] : null;
    const orgId = stringClaim("org_id");
    const orgRole = stringClaim("org_role");
    console.log(
      JSON.stringify(
        {
          token_present: true,
          token_format: "jwt",
          org_id_present: orgId !== null,
          org_id: orgId,
          org_name: stringClaim("org_name"),
          org_slug: stringClaim("org_slug"),
          org_role_present: orgRole !== null,
          org_role: orgRole,
        },
        null,
        2,
      ),
    );

    if (orgId === null) {
      console.error(
        "FAIL: The JWT has no non-empty org_id despite the required user:org:read flow. Implement the documented userinfo fallback before accepting the live flow.",
      );
      process.exit(1);
    }
    if (orgRole === null) {
      console.log("INFO: org_role is absent. Role-based gates remain out of scope, so this does not block the MVP.");
    }
  ' || fail "Access-token verification did not prove the required org_id claim. The complete token and payload were not printed."
fi
