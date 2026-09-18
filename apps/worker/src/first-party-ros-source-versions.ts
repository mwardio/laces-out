import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Select each captured source version as a pair; checksums are not globally unique source IDs. */
export function rosSourceVersionPredicate(
  sources: readonly { readonly id: string; readonly checksum: string }[],
  sourceColumn: SQLWrapper,
  checksumColumn: SQLWrapper,
): SQL | undefined {
  return or(
    ...sources.map((source) =>
      and(sql`${sourceColumn} = ${source.id}`, sql`${checksumColumn} = ${source.checksum}`),
    ),
  );
}
