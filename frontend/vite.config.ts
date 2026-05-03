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
        adminLogin: resolve(__dirname, "admin-login.html"),
      },
    },
  },
});
