import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts"],
    dts: true,
    sourcemap: true,
    // `bun` is a runtime builtin provided by the Bun runtime, not an npm
    // package — keep it external so the packer doesn't try to resolve it.
    deps: {
      neverBundle: ["bun"],
    },
  },
});
