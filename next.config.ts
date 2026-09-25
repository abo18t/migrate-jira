import path from "path";
import type { NextConfig } from "next";

// Pin the root to this project: a lockfile higher up (e.g. ~/package-lock.json)
// would otherwise nest server.js deep inside dist/.
const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
