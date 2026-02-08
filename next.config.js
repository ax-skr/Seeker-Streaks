/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/manifest.webmanifest",
        headers: [
          {
            key: "Content-Type",
            value: "application/manifest+json",
          },
        ],
      },
      {
        source: "/icon-192.png",
        headers: [
          {
            key: "Content-Type",
            value: "image/png",
          },
        ],
      },
      {
        source: "/icon-512.png",
        headers: [
          {
            key: "Content-Type",
            value: "image/png",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
