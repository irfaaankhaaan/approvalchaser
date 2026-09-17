import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Database drivers are required at runtime, not bundled. `pg` carries
  // optional native bindings, and PGlite loads its WASM through
  // `new URL(..., import.meta.url)` — bundling either one rewrites those
  // paths and the driver fails to start.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  async headers() {
    return [
      {
        // The client approval page is the only public surface. Lock it down.
        source: "/approve/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Approval links must never end up in a search index or a referrer.
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
