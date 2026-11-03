import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("../demo/consumption-central-report-src", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [{
    name: "report-demo-notices",
    generateBundle() {
      const metadata = JSON.parse(readFileSync(new URL("./node_modules/papaparse/package.json", import.meta.url), "utf8"));
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-NOTICES.txt",
        source: `${metadata.name}@${metadata.version} (${metadata.license})\n${readFileSync(new URL("./node_modules/papaparse/LICENSE", import.meta.url), "utf8").trim()}\n`,
      });
    },
  }],
  build: {
    outDir: fileURLToPath(new URL("../demo/consumption-central-report", import.meta.url)),
    emptyOutDir: false,
  },
  ssr: { noExternal: true },
});
