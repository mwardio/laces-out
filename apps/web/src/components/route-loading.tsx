import { LoaderCircle } from "lucide-react";

/** Streamed into the shell while a route's server payload is in flight, so
    navigation on a slow connection shows intent instead of an empty frame. */
export function RouteLoading() {
  return (
    <div className="route-loading" role="status" aria-label="Loading page">
      <LoaderCircle size={22} aria-hidden="true" />
    </div>
  );
}
