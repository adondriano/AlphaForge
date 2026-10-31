/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Lint is run separately in CI; never block a production build on lint noise.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
