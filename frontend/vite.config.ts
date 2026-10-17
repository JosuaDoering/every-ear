import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // Caddy fronts us with HTTPS — accept its proxied requests.
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        listener: resolve(__dirname, "index.html"),
        translator: resolve(__dirname, "translator.html"),
        translatorLogin: resolve(__dirname, "translator-login.html"),
        admin: resolve(__dirname, "admin.html"),
        adminEvent: resolve(__dirname, "admin-event.html"),
        adminLanguages: resolve(__dirname, "admin-languages.html"),
        adminAi: resolve(__dirname, "admin-ai.html"),
        adminSettings: resolve(__dirname, "admin-settings.html"),
        adminLogin: resolve(__dirname, "admin-login.html"),
      },
    },
  },
});
