const ESPN_CANDIDATE_POOL_NOTE =
  /^Evaluated \d+ projected players confirmed in ESPN's latest available-player feeds\.$/;

/** Hides the redundant ESPN feed sentence while retaining all other waiver notes. */
export function visibleWaiverNotes(notes: readonly string[]): readonly string[] {
  return notes.filter((note) => !ESPN_CANDIDATE_POOL_NOTE.test(note));
}
