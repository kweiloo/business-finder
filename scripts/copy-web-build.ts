import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const web = path.join(root, "web");
const dist = path.join(root, "dist");

cpSync(path.join(web, "dist"), path.join(dist, "web"), { recursive: true });

type Manifest = { name: string; version: string; license?: string; dependencies?: Record<string, string> };

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest;
}

function packageDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === root || path.dirname(dir) === dir) return undefined;
  }
}

const notices = new Map<string, string>();
function addNotices(from: string, names: string[]): void {
  for (const name of names) {
    const dir = packageDir(from, name);
    if (!dir) continue;
    const pkg = manifest(dir);
    const key = `${pkg.name}@${pkg.version}`;
    if (notices.has(key)) continue;
    const licenses = readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && /^(licen[cs]e|copying|notice|ofl)([.-].+)?$/i.test(item.name))
      .map((item) => item.name)
      .sort()
      .map((file) => `${file}\n${readFileSync(path.join(dir, file), "utf8").trim()}`);
    notices.set(key, [key, `License: ${pkg.license ?? "See package"}`, ...licenses].join("\n\n"));
    addNotices(dir, Object.keys(pkg.dependencies ?? {}));
  }
}

addNotices(root, Object.keys(manifest(root).dependencies ?? {}));
addNotices(web, [...Object.keys(manifest(web).dependencies ?? {}), "tailwindcss"]);
writeFileSync(path.join(dist, "THIRD-PARTY-NOTICES.txt"), [...notices.values()].sort().join("\n\n---\n\n") + "\n");
