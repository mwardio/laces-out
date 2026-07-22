# Fantasy Football Calculator ADP source

This package reads the official Fantasy Football Calculator ADP REST API. The source publishes
mock-draft-derived ADP for multiple scoring formats, team counts, seasons, and positions.

Fantasy Football Calculator documents the API as free for personal and commercial use, requests a
link or mention as attribution, and asks consumers not to poll frequently because the data updates
once per day. Those terms and the live API behavior were rechecked on 2026-07-21. Consumers must
render `FFC_ATTRIBUTION` with a link to `FFC_ATTRIBUTION_URL` and schedule no more than a daily
refresh unless the source's published guidance changes.

- [Official ADP REST API documentation](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api)
- [Fantasy Football Calculator](https://fantasyfootballcalculator.com/)

The upstream currently returns JSON with a `text/html` content type. The adapter accepts only that
known exception or `application/json`, then validates the complete response envelope and each row.
