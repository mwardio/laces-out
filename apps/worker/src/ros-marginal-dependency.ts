export type RosMarginalDependency = "bundle" | "candidate" | "previous" | "training";
export type RosMarginalDependencyReason = "unconfigured" | "missing" | "corrupt" | "incompatible";
export interface RosMarginalDependencyDiagnostic {
  readonly dependency: RosMarginalDependency;
  readonly reason: RosMarginalDependencyReason;
}
/** Only closed, secret-free names enter the ledger; OS paths and provider credentials do not. */
export class RosMarginalDependencyError extends Error {
  constructor(readonly diagnostic: RosMarginalDependencyDiagnostic) {
    super(
      `ROS marginal ${diagnostic.dependency} dependency is ${diagnostic.reason}; prepare and pin the shared evidence bundle`,
    );
    this.name = "RosMarginalDependencyError";
  }
}
