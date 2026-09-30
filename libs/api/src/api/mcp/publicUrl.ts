import { env } from "../../_/env";

/** Stable public identifiers shared by discovery, challenges, and token audience checks. */
export const MCP_RESOURCE_URL = `${env.SPEC_PUBLIC_URL}/mcp`;
export const PROTECTED_RESOURCE_METADATA_URL = `${env.SPEC_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
