import type { NextConfig } from "next";

interface WorkspaceWebpackConfig {
  readonly resolve: {
    extensionAlias?: Record<string, readonly string[]>;
  };
}

const isMiniRemoteValidation = process.env.LACES_REMOTE_PLATFORM === "darwin-arm64";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  expireTime: 7200,
  transpilePackages: [
    "@laces-out/contracts",
    "@laces-out/domain",
    "@laces-out/engine-draft",
    "@laces-out/rankings",
  ],
  poweredByHeader: false,
  typedRoutes: true,
  ...(isMiniRemoteValidation ? { experimental: { cpus: 2 } } : {}),
  redirects() {
    return Promise.resolve([
      {
        source: "/opengraph-image.jpg",
        destination: "/opengraph-image",
        permanent: true,
      },
    ]);
  },
  webpack(config: WorkspaceWebpackConfig): WorkspaceWebpackConfig {
    // Workspace packages use NodeNext's emitted `.js` specifiers while their
    // development exports point at TypeScript source. Resolve both shapes so
    // the browser bundle and the Node bundles share the same package surface.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
