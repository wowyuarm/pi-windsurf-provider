import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWindsurfProvider } from "./src/provider.ts";

export default function (pi: ExtensionAPI) {
  registerWindsurfProvider(pi);
}
