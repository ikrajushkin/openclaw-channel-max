import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { maxChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(maxChannelPlugin);
