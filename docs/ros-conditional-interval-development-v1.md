# Conditional ROS interval development candidate

Status: isolated, reviewed implementation; no historical evaluation or release qualification yet.
The module is not exported by the projections package and cannot authorize publication. Existing
ROS means, raw outcome vectors, scoring rules, admission requirements and deployed behavior remain
unchanged. A passing solver certificate establishes numerical optimality, not predictive accuracy.

The method identifier is `prior-regularized-strength-conditional-quantile-residuals-v1` and its
development evidence contract is `ros-conditional-interval-development-v1`. This is a separate
contract from `season-prior-weighted-quantile-residuals-v1`; their artifacts are not interchangeable.

## Fixed candidate

Fit each position × horizon × strategy × exact scoring identity independently, using only completed
prior seasons. Retain equal-season, equal-cutoff-within-season, equal-player-within-cutoff rational
weights and the existing minimum support: one prior season, 18 rows, three cutoffs and three blocks.
Use the same rows for all three endpoints. Validate supplied current/future rows, but exclude their
targets and covariates from every fitted quantity and evidence digest. Duplicate forecasts,
incomplete prior seasons, malformed values and zero scheduled games are errors, never silent drops.

For raw mean `m`, ordered quantiles `q15/q50/q85`, scheduled games `g` and target `y`, compute:

1. `S = sum(w * (q85-q15)/g)`, exclusively from prior forecasts.
2. `h=m/g`, `v=1/g`, their weighted means, and `c=Cov(h,v)/Var(v)`.
3. `z=clip((h-mean(h)-c*(v-mean(v)))/S,-2,2)`.
4. For each `tau` in `{.15,.50,.85}`, `r=(y-q_tau)/(g*S)`.
5. Minimize `sum(w*pinball_tau(r-a-b*z))+b*b/4`.

The slope penalty, feature, clipping and weights are fixed; there is no hyperparameter search.
Use the midpoint of the entire minimizing intercept interval. The rational row denominator is
passed to the solver so binary approximations to weights cannot change an exact mass tie.

When every prior `g` is equal, set `c=0` and permit application only at that same `g`. This restriction
repairs the original proposal's overly broad additive affine claim: a constant-volume prior sample
cannot identify the effect of adding a common total-point offset at a different live volume.
With varying prior games, `c'=A*c+B`, `S'=abs(A)*S`, and `z'=sign(A)*z` under `X'=A*X+B`.
Negative `A` reverses endpoint order. These properties have controlled tests, including an unseen
valid game count and clipped features. They do not permit sharing fits between different scoring
profiles whose transformations are not uniform affine changes to totals.

`S=0`, unresolved volume variance, finite-input arithmetic overflow, or an uncertified solver
result makes the candidate unavailable. Intermediates must be finite before clipping. Tiny positive
scales are allowed if the actual arithmetic remains finite and certifiable. The raw-domain checks
reject nonfinite observations, unordered quantiles, and noninteger/out-of-window scheduled games.

## Solver and evidence

`certified-regularized-quantile-2d-v1` searches the scalar slope in `[-4,4]`. For each slope it derives
the weighted-quantile intercept interval and jointly assigns dual mass among tied observations.
The independent certifier recomputes dual box feasibility, intercept mass, slope stationarity,
complementarity, objective precision and primal-dual gap from the original rows. Its dual is
`sum(alpha*r)-square(sum(alpha*z))`, with `sum(alpha)=0` and
`w*(tau-1) <= alpha <= w*tau`.

Fixed limits and dimensionless tolerances are declared in `CONDITIONAL_QUANTILE_NUMERICS`:

| Control                                           | Value                         |
| ------------------------------------------------- | ----------------------------- |
| Maximum rows / iterations                         | 6,000 / 96                    |
| Rational mass bit limit                           | 8,192                         |
| Weight normalization / dual mass tolerance        | 1e-12 / 1e-12                 |
| Near-atom residual / slope stationarity tolerance | 1e-10 / 1e-11                 |
| Complementarity / primal-dual gap tolerance       | 2e-10 / 1e-9                  |
| Objective roundoff ceiling                        | 2.5e-10                       |
| Dual moment search tolerance                      | 1e-13                         |
| Box / allocation / objective roundoff units       | 16 / 32 / 32 machine epsilons |

The evidence binds canonical prior raw means, quantiles, targets, identities, schedules, exact
weights, preprocessing, features, residuals and all three coefficient/certificate sets. Preparation
checks the supplied payload checksum, independently reconstructs preprocessing and certificates,
and checks the reconstructed checksum. JSON object key order is immaterial; array order remains
meaningful. It returns a detached executable snapshot so later receipt mutation cannot alter an
already prepared fit. Source authenticity and complete cohort identity are separate caller duties;
a checksum is not a signature or an admission decision.

Apply `q_tau + g*S*(a_tau+b_tau*z)` and sort the three resulting values. Record the unsorted values,
permutation, crossing flag and maximum movement; grade the sorted endpoints that are returned.
Preserve the raw mean exactly. Sorting establishes order, not coverage or better predictive loss.

`chronological-conditional-ros-development-v1` applies this candidate to the original audit before
adding each complete training season. It returns both strategies for every audit row, the unchanged
v7 mean-policy selection, per-year fits and final live fits. Its eight mean-selector settings are
literal frozen values, with no caller override. Additional training rows cannot enter the audit or
mean selector. Forecast identities retain the original physical input checksum.

The adapter preserves the existing explicit structural-zero training exclusion: prior forecasts
with no scheduled games are named in each cell's exclusion evidence instead of being passed to
the low-level fit, which rejects zero denominators. Zero-game audit rows remain present and
unavailable. Original and broader-training coverage/convergence failures are retained separately;
a successful numerical correction cannot clear them or substitute a passing broader-cohort
diagnostic for a failed original-audit diagnostic.

## Historical evaluation prerequisite

Before any historical fitting, freeze implementation and protocol hashes plus exact candidate,
retained and training report bytes, source/corpus identities, scoring rules and the full cohort.
The intended original evaluation remains 3,264 forecasts; broader training, if used, remains the
authenticated composition of 2,720 original non-DST and 2,176 complete-team DST forecasts.
Fit 2023 from 2022, 2024 from 2022–23, 2025 from 2022–24, and any 2026 live candidate from 2022–25.

Keep all existing support, mean, physical/numerical, coverage/tail and matched benchmark gates.
Evaluate both strategies and the unchanged mean policy choices, and retain original diagnostic
failures. Do not tune this candidate's feature, penalty, thresholds or cohort after grading it.
The 2022–25 results already informed development; this evaluation cannot be represented as
untouched confirmation. A separate pinned confirmation design is required before adoption.

The objective family is supported by [Koenker and Hallock](https://www.aeaweb.org/articles?id=10.1257/jep.15.4.143)
and [Steinwart and Christmann](https://arxiv.org/pdf/1102.2101); quantile rearrangement is discussed
by [Chernozhukov et al.](https://arxiv.org/abs/0704.3649). These references do not establish this
feature's engineering constants, football calibration, or independence of overlapping cutoffs.
