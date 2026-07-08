import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.JUNREI_SERVER_PORT ?? "7867";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.JUNREI_WEB_PORT ?? 5873),
    proxy: {
      "/api": `http://localhost:${serverPort}`,
    },
  },
});
