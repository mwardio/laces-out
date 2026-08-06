import type { TeamId } from "@laces-out/domain";

export interface SnakeOrderOptions {
  readonly thirdRoundReversal?: boolean;
}

export function createSnakePickOrder(
  teamIds: readonly TeamId[],
  rounds: number,
  options: SnakeOrderOptions = {},
): readonly TeamId[] {
  if (teamIds.length < 2) {
    throw new RangeError("A snake draft requires at least two teams");
  }
  if (new Set(teamIds).size !== teamIds.length) {
    throw new Error("Snake draft team IDs must be unique");
  }
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    throw new RangeError("Snake draft rounds must be a positive integer");
  }

  const forward = [...teamIds];
  const reverse = [...teamIds].reverse();
  const order: TeamId[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    let roundOrder: readonly TeamId[];
    if (options.thirdRoundReversal === true) {
      roundOrder = round === 1 || (round >= 4 && round % 2 === 0) ? forward : reverse;
    } else {
      roundOrder = round % 2 === 1 ? forward : reverse;
    }
    order.push(...roundOrder);
  }

  return order;
}
