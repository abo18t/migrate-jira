import fs from "fs";
import path from "path";

const root = path.resolve(".");
const dist = path.join(root, "dist");

// Clean dist
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// Copy .next/standalone → dist
fs.cpSync(path.join(root, ".next/standalone"), dist, { recursive: true });

// Copy .next/static → dist/.next/static
fs.cpSync(path.join(root, ".next/static"), path.join(dist, ".next/static"), { recursive: true });

// Copy public → dist/public
if (fs.existsSync(path.join(root, "public"))) {
  fs.cpSync(path.join(root, "public"), path.join(dist, "public"), { recursive: true });
}

console.log("✅ dist/ ready — copy to target machine and run: node server.js");
