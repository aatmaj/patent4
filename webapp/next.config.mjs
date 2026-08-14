/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with a minimal server.js and only the node_modules
  // actually reached by the traced imports. That is what the Cloud Run image
  // copies, so the runtime layer carries no build tooling and no dev deps.
  output: 'standalone',
};

export default nextConfig;
