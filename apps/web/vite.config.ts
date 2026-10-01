import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    // Only used with PORTLESS=0; portless injects its own --port otherwise.
    port: 3005,
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
    nitro({
      // Railway terminates TLS but serves Nitro's public assets unchanged. Build
      // both variants so Nitro can negotiate a compressed response at runtime.
      compressPublicAssets: { gzip: true, brotli: true },
    }),
  ],
});
