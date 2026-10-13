import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Not for search engines. The proxy sets this too; this covers the static
  // assets it skips (_next/static, favicon).
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" }] }];
  },
};

export default nextConfig;
