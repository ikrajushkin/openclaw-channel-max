import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { maxChannelPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime-store.js";

export default defineChannelPluginEntry({
  id: "max",
  name: "MAX",
  description: "Канал мессенджера MAX для OpenClaw",
  plugin: maxChannelPlugin,
  setRuntime: setMaxRuntime,
});
