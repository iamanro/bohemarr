import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// `bun run dev:web` proxies the API to a Bohemarr running on the default port.
export default defineConfig({
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  server: { proxy: { "/v1": "http://127.0.0.1:8787", "/api": "http://127.0.0.1:8787" } },
})
