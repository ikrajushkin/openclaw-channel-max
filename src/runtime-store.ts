import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

let current: PluginRuntime | undefined;

/** Ядро отдаёт рантайм при загрузке плагина; до этого момента его нет. */
export function setMaxRuntime(runtime: PluginRuntime): void {
  current = runtime;
}

export function getMaxRuntime(): PluginRuntime {
  if (!current) {
    throw new Error(
      "max: рантайм плагина ещё не внедрён ядром — вызов сделан слишком рано",
    );
  }
  return current;
}

export function peekMaxRuntime(): PluginRuntime | undefined {
  return current;
}
