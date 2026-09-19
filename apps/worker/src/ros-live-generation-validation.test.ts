import { describe, expect, it } from "vitest";
import { runFirstPartyTeamDefenseBacktest } from "@laces-out/projections";
import { calibrateFirstPartyRosPlayerHistory } from "./first-party-ros-candidate-provider.js";
import { restoreRosLiveCalibration } from "./ros-live-generation-validation.js";

function fixture() {
  return {
    player: calibrateFirstPartyRosPlayerHistory({ trainingHistory: [], schedules: [] }),
    defenseByDefinition: {
      "yahoo-2022-v1": runFirstPartyTeamDefenseBacktest([]).calibration,
      "espn-2019-v1": runFirstPartyTeamDefenseBacktest([]).calibration,
    },
  };
}

describe("provider-specific cached live defense calibration", () => {
  it("restores both explicit provider fits and detaches cached ownership", () => {
    const saved = fixture();
    const restored = restoreRosLiveCalibration(saved);
    expect(restored).toEqual(saved);
    expect(restored.defenseByDefinition).not.toBe(saved.defenseByDefinition);
  });

  it("rejects a legacy provider-neutral calibration", () => {
    const saved = fixture();
    expect(() =>
      restoreRosLiveCalibration({
        player: saved.player,
        defense: saved.defenseByDefinition["yahoo-2022-v1"],
      }),
    ).toThrow(TypeError);
  });

  it("rejects an incomplete or unknown provider set before reuse", () => {
    const saved = fixture();
    expect(() =>
      restoreRosLiveCalibration({
        ...saved,
        defenseByDefinition: { "yahoo-2022-v1": saved.defenseByDefinition["yahoo-2022-v1"] },
      }),
    ).toThrow();
    expect(() =>
      restoreRosLiveCalibration({
        ...saved,
        defenseByDefinition: {
          ...saved.defenseByDefinition,
          "espn-old": saved.defenseByDefinition["espn-2019-v1"],
        },
      }),
    ).toThrow();
  });

  it("validates the second provider fit instead of trusting the reference fit", () => {
    const saved = fixture();
    expect(() =>
      restoreRosLiveCalibration({
        ...saved,
        defenseByDefinition: {
          ...saved.defenseByDefinition,
          "espn-2019-v1": {
            ...saved.defenseByDefinition["espn-2019-v1"],
            modelVersion: "obsolete",
          },
        },
      }),
    ).toThrow();
  });
});
