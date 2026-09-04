"use client";

import { useEffect } from "react";

export function AppStoreRedirect({ destination }: { readonly destination: string }) {
  useEffect(() => {
    window.location.replace(destination);
  }, [destination]);

  return (
    <noscript>
      <p>
        <a href={destination}>Open Laces Out in the App Store</a>
      </p>
    </noscript>
  );
}
