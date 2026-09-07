import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL("./src/dashboard/web/", import.meta.url));

export default defineConfig({
  root: dashboardRoot,
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": dashboardRoot },
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(dashboardRoot, "index.html"),
        marketing: resolve(dashboardRoot, "marketing.html"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "marketing" ? "marketing.js" : "app.js"),
        assetFileNames: (asset) =>
          asset.names?.includes("style.css") || asset.name === "style.css"
            ? "dashboard.css"
            : "assets/[name][extname]",
      },
    },
  },
});
