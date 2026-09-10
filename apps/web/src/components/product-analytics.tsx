"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { captureProductPage } from "../lib/product-analytics";

export function ProductAnalytics() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) void captureProductPage(pathname);
  }, [pathname]);
  return null;
}
