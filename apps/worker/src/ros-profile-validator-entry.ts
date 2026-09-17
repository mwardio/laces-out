// A standalone entry keeps the CPU-heavy historical replay outside the queue worker event loop.
// The child receives only an exact scoring key and public source-cache configuration.
import "../scripts/validate-first-party-ros.js";
