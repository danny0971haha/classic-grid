import { runLoop } from "../loop.js";
import {
  applyCanaryProfileDefaults,
  createExtendedCanaryExecutor,
  emptyCanaryOfficialBundle,
  getCanaryOfficialCache,
} from "../venues/extendedFactory.js";

applyCanaryProfileDefaults();
const once = process.argv.includes("--once");
await runLoop({
  once,
  createExecutor: createExtendedCanaryExecutor,
  refreshOfficialStats: async () => emptyCanaryOfficialBundle(),
  getOfficialCache: getCanaryOfficialCache,
});
