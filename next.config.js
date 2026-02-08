/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/icon-192.png",
        headers: [{ key: "Content-Type", value: "image/png" }],
      },
      {
        source: "/icon-512.png",
        headers: [{ key: "Content-Type", value: "image/png" }],
      },
      {
        source: "/icon-maskable-512.png",
        headers: [{ key: "Content-Type", value: "image/png" }],
      },
    ];
  },

  // ✅ This fixes the TWA requirement:
  // forces /.well-known/assetlinks.json to be served correctly
  async rewrites() {
    return [
      {
        source: "/.well-known/assetlinks.json",
        destination: "/api/assetlinks",
      },
    ];
  },
};

module.exports = nextConfig;
