declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type PlayerId = Brand<string, "PlayerId">;
export type LeagueId = Brand<string, "LeagueId">;
export type TeamId = Brand<string, "TeamId">;
export type RosterSlotId = Brand<string, "RosterSlotId">;
export type DraftEventId = Brand<string, "DraftEventId">;
export type ConnectionId = Brand<string, "ConnectionId">;

function makeId<Name extends string>(value: string, label: Name): Brand<string, Name> {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty string without surrounding whitespace`);
  }

  return value as Brand<string, Name>;
}

export const playerId = (value: string): PlayerId => makeId(value, "PlayerId");
export const leagueId = (value: string): LeagueId => makeId(value, "LeagueId");
export const teamId = (value: string): TeamId => makeId(value, "TeamId");
export const rosterSlotId = (value: string): RosterSlotId => makeId(value, "RosterSlotId");
export const draftEventId = (value: string): DraftEventId => makeId(value, "DraftEventId");
export const connectionId = (value: string): ConnectionId => makeId(value, "ConnectionId");
