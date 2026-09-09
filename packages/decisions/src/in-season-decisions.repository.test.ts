import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { restOfSeasonProjectionSetOrderBy } from "./in-season-decisions.js";

function compiledOrderBy(managedProfileKey: string | null): string {
  return new PgDialect().sqlToQuery(
    sql`select 1 order by ${sql.join(restOfSeasonProjectionSetOrderBy(managedProfileKey), sql`, `)}`,
  ).sql;
}

describe("restOfSeasonProjectionSetOrderBy", () => {
  it("does not emit PostgreSQL's invalid positional ORDER BY 0 without a managed profile", () => {
    const query = compiledOrderBy(null);

    expect(query).not.toMatch(/order by\s+0(?:\s|,|$)/u);
    expect(query).toContain('order by "projection_sets"."as_of_week" desc');
  });

  it("prefers an exact scoring profile when one is available", () => {
    const query = compiledOrderBy('[{"statId":"receptions","points":1,"bonuses":[]}]');

    expect(query).toContain("order by case when");
    expect(query).toContain(`"projection_sets"."metadata"->>'scoringProfileKey'`);
  });
});
