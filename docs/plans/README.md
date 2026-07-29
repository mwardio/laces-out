# Implementation records

These documents preserve design decisions, rollout gates, and measured implementation results. They
are engineering records rather than installation instructions or promises that every described
feature is enabled.

For current product behavior, start with the repository [README](../../README.md). Operators should
use [operations.md](../operations.md), [security.md](../security.md), and the
[provider notes](../provider-notes/).

| Record                                                                 | Current status                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [ESPN live draft sync](./ESPN_LIVE_DRAFT_SYNC_PLAN.md)                 | Implemented behind a default-off flag; authenticated live-room validation remains         |
| [League scoring normalization](./LEAGUE_SCORING_NORMALIZATION_PLAN.md) | Implemented and verified                                                                  |
| [Remaining enhancements](./REMAINING_ENHANCEMENTS_PT1.md)              | Proposed roadmap and implementation inventory                                             |
| [Rest-of-season availability](./ROS_AVAILABILITY_PLAN.md)              | Evidence work complete through WP4b; re-admission remains                                 |
| [ROS gate and D/ST](./ROS_GATE_AND_DST_PLAN.md)                        | Completed implementation record                                                           |
| [Schedule intelligence](./SCHEDULE_INTELLIGENCE_PLAN.md)               | Implemented under the earlier “Schedule Edge” working name; shipped UI is Matchup Outlook |
| [Prime-time polish](./prime-time-polish-plan.md)                       | Historical product-design record                                                          |

Some records cite earlier internal roadmaps that are intentionally not part of the public
documentation set. The checked-in code, tests, evidence artifacts, main README, and operator
documentation are authoritative when an older plan and the current release differ.
