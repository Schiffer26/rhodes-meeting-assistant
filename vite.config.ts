import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sandbox preview opt-in.
 *
 * Normal local development binds to localhost and keeps Vite's default host
 * validation — nothing else is allowed in. Only when RHODES_SANDBOX_PREVIEW=1
 * is exported explicitly (the hosted Arena preview container) does the server
 * bind 0.0.0.0 and accept the proxy host, because the preview proxy forwards a
 * public hostname that Vite would otherwise reject.
 *
 *   npm run dev                                  → localhost only
 *   RHODES_SANDBOX_PREVIEW=1 npm run dev         → sandbox preview
 */
const sandboxPreview = process.env.RHODES_SANDBOX_PREVIEW === "1";

const sandboxHost = sandboxPreview
  ? { host: true, allowedHosts: [".e2b.app"] as string[] }
  : {};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: { ...sandboxHost },
  preview: { ...sandboxHost },
});
