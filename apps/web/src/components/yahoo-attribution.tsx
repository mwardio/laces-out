import { ExternalLink } from "lucide-react";

export function YahooAttribution() {
  return (
    <a
      className="yahoo-attribution"
      href="https://sports.yahoo.com/fantasy/"
      target="_blank"
      rel="noreferrer"
      aria-label="Fantasy data provided by Yahoo Fantasy (opens Yahoo Fantasy)"
    >
      <span className="yahoo-attribution__mark" aria-hidden="true">
        <img src="/providers/yahoo-fantasy.svg" width="174" height="28" alt="" />
      </span>
      <span>Fantasy data provided by Yahoo Fantasy</span>
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}
