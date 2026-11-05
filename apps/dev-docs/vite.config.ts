import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { stdioTrafficApiPlugin, featureBoundaryGraphPlugin } from "./vite-adapters/index.js";

export default defineConfig({
  plugins: [stdioTrafficApiPlugin(), featureBoundaryGraphPlugin(), react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: { port: 5186 },
});
