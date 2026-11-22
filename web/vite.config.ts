import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { DEV_API_PORT, DEV_WEB_PORT, firstBindablePort } from "./devPort.ts";
import { dropOwnOrigin } from "./devProxy.ts";

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // See devPort.ts: the first port from 15173 that Windows has not reserved.
    // A build never listens, so it does not probe.
    port: command === "serve" ? await firstBindablePort(DEV_WEB_PORT) : DEV_WEB_PORT,
    strictPort: true,
    proxy: {
      // See devProxy.ts: only the dev server's own Origin is dropped, so the
      // API's localhost guard still refuses every other site.
      "/api": {
        target: `http://127.0.0.1:${process.env.BUSINESS_FINDER_DEV_API_PORT ?? DEV_API_PORT}`,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", dropOwnOrigin),
      },
    },
  },
}));
