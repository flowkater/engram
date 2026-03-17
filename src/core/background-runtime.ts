import { resolveBackgroundJobConfig, type BackgroundJobConfig } from "./runtime-leases.js";

export interface BackgroundRuntimeState {
  enabled: boolean;
  backgroundConfig: BackgroundJobConfig;
}

export function resolveBackgroundRuntime(
  env: NodeJS.ProcessEnv = process.env
): BackgroundRuntimeState {
  const backgroundConfig = resolveBackgroundJobConfig(env);
  return {
    enabled: backgroundConfig.backgroundEnabled,
    backgroundConfig,
  };
}
