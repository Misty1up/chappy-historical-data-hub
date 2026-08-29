import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const out = resolve(root, "dist-web");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(root, "web"), out, { recursive: true });
copyFileSync(resolve(root, "dist", "src", "web", "contract.js"), resolve(out, "contract.js"));
copyFileSync(resolve(root, "config", "symbol_registry.json"), resolve(out, "symbol_registry.json"));
console.log(`Web static output: ${out}`);
