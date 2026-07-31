import type { NextConfig } from "next";

interface WorkspaceWebpackConfig {
  readonly resolve: {
    extensionAlias?: Record<string, readonly string[]>;
  };
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  expireTime: 7200,
  transpilePackages: [
    "@fantasy/contracts",
    "@fantasy/domain",
    "@fantasy/engine-draft",
    "@fantasy/rankings",
  ],
  poweredByHeader: false,
  typedRoutes: true,
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
