// Standalone web viewer — boots the UI without running any trials.
// Use this to browse runs/*.jsonl after a run has ended.
//
//   bun run scripts/web.ts            # serves on $WEB_PORT or 3000
//   WEB_PORT=4000 bun run scripts/web.ts

import { startWebServer } from "../web";

const PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 3000;
const w = startWebServer(PORT);
console.log(`Web UI: ${w.url}`);
console.log("Browse runs in the 'Runs' tab. Ctrl-C to exit.");
