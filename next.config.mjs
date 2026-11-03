/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets a second dev server (e.g. Playwright's mock-provider server) run without clobbering .next
  distDir: process.env.NEXT_DIST_DIR || ".next"
};
export default nextConfig;
