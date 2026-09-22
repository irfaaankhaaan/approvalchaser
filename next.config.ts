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
    // Every page reachable by URL alone, with nothing else standing in
    // front of it: the client approval page and its reminder-link variant
    // (a signed token is the only credential), the agency detail view (a
    // signed token, minted for one hour), and the dashboard (no credential
    // at all — see its own in-page warning). None of them may be framed,
    // indexed, or leak a referrer.
    const noFrameNoIndex = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
    ];
    return [
      { source: "/approve/:path*", headers: noFrameNoIndex },
      { source: "/a/:path*", headers: noFrameNoIndex },
      { source: "/dashboard/:path*", headers: noFrameNoIndex },
    ];
  },
};

export default nextConfig;
