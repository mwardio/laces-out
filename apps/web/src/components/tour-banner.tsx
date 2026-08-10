import { Info } from "lucide-react";

import { TOUR_BANNER } from "../lib/copy";

export function TourBanner() {
  return (
    <div className="tour-banner" role="status">
      <Info size={17} aria-hidden="true" />
      <span className="tour-banner__copy">
        <strong>{TOUR_BANNER.title}</strong>
        <span>{TOUR_BANNER.detail}</span>
      </span>
    </div>
  );
}
