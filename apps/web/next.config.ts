import type { NextConfig } from "next";

interface WorkspaceWebpackConfig {
  readonly resolve: {
    extensionAlias?: Record<string, readonly string[]>;
  };
}

const isMiniRemoteValidation = process.env.LACES_REMOTE_PLATFORM === "darwin-arm64";

/** Why the configured public origin cannot be the one search engines and unfurlers should see. */
function publicOriginProblem(value: string | undefined): string | null {
  if (!value) return "NEXT_PUBLIC_SITE_URL is unset";
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return `NEXT_PUBLIC_SITE_URL is not a URL (${value})`;
  }
  // `URL` normalizes an IPv6 host to bracketed lowercase, so `[::1]` is the spelling to match.
  if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(origin.hostname)) {
    return `NEXT_PUBLIC_SITE_URL points at localhost (${value})`;
  }
  if (origin.protocol !== "https:") return `NEXT_PUBLIC_SITE_URL is not https (${value})`;
  return null;
}

let warnedAboutPublicOrigin = false;

/**
 * A production build bakes the public origin into every canonical link, sitemap entry, and social
 * URL, so a wrong value ships as wrong metadata. This is a warning rather than an error because
 * `npm run runtime:smoke` builds against localhost on purpose. Next may evaluate this config more
 * than once per build; the module-level flag keeps it to a single warning.
 */
function warnAboutPublicOrigin(): void {
  if (warnedAboutPublicOrigin || process.env.NODE_ENV !== "production") return;
  const problem = publicOriginProblem(process.env.NEXT_PUBLIC_SITE_URL?.trim());
  if (!problem) return;
  warnedAboutPublicOrigin = true;
  console.warn(
    `\n  WARNING  ${problem}: canonical, sitemap, and social URLs will point at the wrong origin. Set PUBLIC_URL (NEXT_PUBLIC_SITE_URL) to the canonical https origin and rebuild.\n`,
  );
}

warnAboutPublicOrigin();

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
