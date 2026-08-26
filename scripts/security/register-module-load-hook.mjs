import { register } from "node:module";

register(new URL("./module-load-hook.mjs", import.meta.url));
