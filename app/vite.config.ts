import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { managedApps } from "@microsoft/managed-apps-vite-plugin";
import { viteSingleFile } from "vite-plugin-singlefile";

const SAMPLE_DIR = "public/sample";
const DEMO_SAMPLE_DIR = "demo-public/sample";
const SAMPLE_ID = "virtual:embedded-sample";
// The single-file build is committed here so customers can download it from the repo.
const FILE_OUT_DIR = "download";
const FILE_NAME = "Consumption-Central-App.html";

// In the single-file build there's no server to fetch public/sample from, so the sample CSVs
// listed in its manifest are gzipped into the page. Other builds get null and fetch them as before.
function embeddedSample(embed: boolean, sampleDir = SAMPLE_DIR): Plugin {
  return {
    name: "embedded-sample",
    resolveId: (id) => (id === SAMPLE_ID ? "\0" + SAMPLE_ID : undefined),
    load(id) {
      if (id !== "\0" + SAMPLE_ID) return;
      if (!embed) return "export default null;";
      const names = JSON.parse(readFileSync(`${sampleDir}/manifest.json`, "utf8")) as string[];
      const files = Object.fromEntries(
        names.map((f) => [f, gzipSync(readFileSync(`${sampleDir}/${f}`), { level: 9 }).toString("base64")]),
      );
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

function demoSampleLabel(): Plugin {
  return {
    name: "demo-sample-label",
    transform(code, id) {
      if (!id.split("?")[0].replaceAll("\\", "/").endsWith("/src/data/load.ts")) return;
      return code.replace(
        /buildDataset\(parsed,\s*(['"])[^'"]*\1,\s*true\)/,
        "buildDataset(parsed, 'Synthetic demo data', true)",
      );
    },
  };
}

function demoNotices(): Plugin {
  return {
    name: "demo-notices",
    generateBundle() {
      const modules = ["react", "react-dom", "scheduler", "papaparse"];
      const notices = modules.map((name) => {
        const directory = join("node_modules", name);
        const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
          name: string;
          version: string;
          license?: string;
        };
        const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"]
          .map((file) => join(directory, file))
          .find((file) => existsSync(file));
        if (!licenseFile) throw new Error(`Missing license file for ${metadata.name}`);
        return `${metadata.name}@${metadata.version} (${metadata.license ?? "license not specified"})\n${readFileSync(licenseFile, "utf8").trim()}`;
      });
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-NOTICES.txt",
        source: notices.join("\n\n---\n\n") + "\n",
      });
      this.emitFile({
        type: "asset",
        fileName: "LICENSE",
        source: readFileSync("../LICENSE", "utf8"),
      });
    },
  };
}

// Makes the single-file build self-contained: the favicon becomes a data URI and the page
// gets a descriptive file name. Rolldown forbids assigning to the bundle, so the page is
// deleted and re-emitted.
function singleFileFinish(fileName = FILE_NAME): Plugin {
  return {
    name: "single-file-finish",
    enforce: "post",
    generateBundle(_, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      delete bundle["index.html"];
      const icon = `data:image/svg+xml;base64,${readFileSync("public/favicon.svg").toString("base64")}`;
      const source = String(page.source).replace(/href="[^"]*favicon\.svg"/, `href="${icon}"`);
      this.emitFile({ type: "asset", fileName, source });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const file = mode === "file";
  const demo = mode === "demo";
  return {
    base: demo ? "/demo/consumption-central/" : undefined,
    publicDir: demo ? false : undefined,
    plugins: file
      ? [react(), embeddedSample(true), viteSingleFile({ removeViteModuleLoader: true }), singleFileFinish()]
      : demo
        ? [
            react(),
            embeddedSample(true, DEMO_SAMPLE_DIR),
            demoSampleLabel(),
            viteSingleFile({ removeViteModuleLoader: true }),
            singleFileFinish("index.html"),
            demoNotices(),
          ]
      : [react(), embeddedSample(false), managedApps()],
    build: file
      ? { outDir: FILE_OUT_DIR, copyPublicDir: false }
      : demo
        ? { outDir: "../demo/consumption-central", copyPublicDir: false, emptyOutDir: true }
        : undefined,
  };
});