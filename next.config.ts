import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker
  output: 'standalone',

  // Optional: Configure external packages if needed
  // experimental: {
  //   serverComponentsExternalPackages: ['pg', 'drizzle-orm'],
  // },
};

export default nextConfig;
