/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Serve install scripts with a plain-text content-type for `curl | sh` friendliness.
  async headers() {
    return [
      {
        source: '/install.sh',
        headers: [{ key: 'Content-Type', value: 'text/x-shellscript; charset=utf-8' }],
      },
      {
        source: '/install.ps1',
        headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      },
      {
        source: '/loader.mjs',
        headers: [{ key: 'Content-Type', value: 'application/javascript; charset=utf-8' }],
      },
      {
        source: '/bundle/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
