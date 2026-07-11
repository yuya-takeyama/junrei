import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.JUNREI_SERVER_PORT ?? process.env.JUNREI_PORT ?? "7867";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.JUNREI_WEB_PORT ?? 5873),
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
    },
  },
});
