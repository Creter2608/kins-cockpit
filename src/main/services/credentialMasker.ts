/**
 * src/main/services/credentialMasker.ts
 * Deterministic Zero-Exposure masking utility for API credentials.
 */

export function maskCredential(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 8) {
    return "****";
  }

  let prefix = "";
  if (trimmed.startsWith("sk-proj-")) {
    prefix = "sk-proj-";
  } else if (trimmed.startsWith("sk-")) {
    prefix = "sk-";
  }

  const suffix = trimmed.slice(-4);
  if (prefix) {
    return `${prefix}****...****${suffix}`;
  }

  return `****...****${suffix}`;
}

export interface McpKeyExtractionResult {
  readonly key?: string;
  readonly error?: "malformed" | "conflicting";
}

export function extractOpenAiKeyFromMcpJson(rawConfig: string): McpKeyExtractionResult {
  try {
    const parsed: unknown = JSON.parse(rawConfig);
    const discoveredKeys = new Set<string>();
    if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
      const servers = (parsed as { mcpServers?: unknown }).mcpServers;
      if (servers && typeof servers === "object") {
        for (const serverConfig of Object.values(servers as Record<string, unknown>)) {
          if (serverConfig && typeof serverConfig === "object" && "env" in serverConfig) {
            const envObj = (serverConfig as { env?: unknown }).env;
            if (envObj && typeof envObj === "object") {
              const val = (envObj as Record<string, unknown>).OPENAI_API_KEY;
              if (typeof val === "string" && val.trim().length > 0) {
                discoveredKeys.add(val.trim());
              }
            }
          }
        }
      }
    }
    if (discoveredKeys.size === 0) return {};
    if (discoveredKeys.size > 1) return { error: "conflicting" };
    const [singleKey] = Array.from(discoveredKeys);
    return singleKey ? { key: singleKey } : {};
  } catch {
    return { error: "malformed" };
  }
}
