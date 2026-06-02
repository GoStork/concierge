import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

export default defineConfig({
  plugins: [
    react(),
    // Replit-specific dev plugins. Only load when actually running on
    // Replit. Outside Replit, runtimeErrorOverlay turns every benign
    // window.error event (including CORS-veiled iOS Chrome errors with
    // no details) into a screen-blocking "(unknown runtime error)"
    // modal, which is what was breaking ngrok-served dev for mobile.
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          runtimeErrorOverlay(),
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            if (id.includes("react-router") || id.includes("@remix-run") || id.includes("wouter")) {
              return "vendor-router";
            }
            if (id.includes("@tanstack") || id.includes("zod") || id.includes("react-hook-form")) {
              return "vendor-utils";
            }
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    allowedHosts: [".ngrok-free.app", ".ngrok.io"],
    hmr: process.env.VITE_HMR_HOST
      ? {
          protocol: "wss",
          host: process.env.VITE_HMR_HOST,
          clientPort: 443,
        }
      : true,
  },
});
