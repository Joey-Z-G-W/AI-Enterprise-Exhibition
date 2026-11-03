import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const guideBusinessPort = process.env.GUIDE_BUSINESS_PORT ?? "8010";
if (guideBusinessPort !== "8010" && guideBusinessPort !== "8011") {
  throw new Error("GUIDE_BUSINESS_PORT must be 8010 or 8011");
}

const proxy = {
  "/opentalking": {
    target: "http://127.0.0.1:8210",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/opentalking/, ""),
  },
  "/guide": {
    target: `http://127.0.0.1:${guideBusinessPort}`,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/guide/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5290, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 5290, strictPort: true, proxy },
});
