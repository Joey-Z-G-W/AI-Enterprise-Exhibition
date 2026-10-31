import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/opentalking": {
    target: "http://127.0.0.1:8210",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/opentalking/, ""),
  },
  "/guide": {
    target: "http://127.0.0.1:8010",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/guide/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5290, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 5290, strictPort: true, proxy },
});
