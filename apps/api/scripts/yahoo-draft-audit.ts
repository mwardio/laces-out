import { createHash } from "node:crypto";

import { loadEnvironment } from "@laces-out/config";
import { YahooFantasyReadClient, parseYahooDraftResultsXml } from "@laces-out/connector-yahoo";
import {
  createDatabase,
  fantasyTeams,
  leagueSeasons,
  playerExternalIds,
  providerConnections,
  providerLeagueLinks,
  rosterSlotRules,
} from "@laces-out/db";
import { parseCredentialKey } from "@laces-out/security";
import { and, asc, eq, inArray } from "drizzle-orm";

import { YahooConnectionService } from "../src/yahoo-connection.js";

/**
 * Authorized-artifact inventory for selection diagnostics only. This command intentionally has no
 * admission mode: neither a successful process exit nor `structuralCandidate` satisfies the
 * independently retained board, implementation-freeze, or every-prefix confirmation gates.
 */

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function formatFor(value: string): "snake" | "auction" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("auction")) return "auction";
  if (normalized.includes("snake") || normalized.includes("standard")) return "snake";
  return null;
}

function safeXmlShape(xml: string): readonly string[] {
  const tags = new Set<string>();
  for (const match of xml.matchAll(
    /<\/?(?:[A-Za-z_][A-Za-z0-9_.-]*:)?([A-Za-z_][A-Za-z0-9_.-]*)[\s/>]/gu,
  )) {
    const tag = match[1];
    if (tag !== undefined) tags.add(tag);
  }
  return [...tags].sort().slice(0, 100);
}

function safeDraftEnvelope(xml: string): Readonly<Record<string, unknown>> {
  const status = /<draft_status>\s*([A-Za-z_-]{1,32})\s*<\/draft_status>/u.exec(xml)?.[1] ?? null;
  const resultsTag = /<draft_results\b([^>]*)>/u.exec(xml)?.[0] ?? null;
  const count = resultsTag === null ? null : (/\bcount="(\d{1,5})"/u.exec(resultsTag)?.[1] ?? null);
  return {
    draftStatus: status,
    draftResultsPresent: resultsTag !== null,
    draftResultsSelfClosing: resultsTag?.endsWith("/>") ?? false,
    declaredCount: count === null ? null : Number(count),
  };
}

function safeKeeperEnvelope(xml: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const match of xml.matchAll(
    /<([A-Za-z_][A-Za-z0-9_.-]*keeper[A-Za-z0-9_.-]*)>\s*([^<]{0,32})\s*<\/\1>/giu,
  )) {
    const key = match[1]?.toLowerCase();
    const raw = match[2]?.trim().toLowerCase();
    if (key !== undefined) {
      result[key] =
        raw !== undefined && /^(?:\d{1,5}|true|false|yes|no)$/u.test(raw) ? raw : "present";
    }
  }
  return result;
}

const DIAGNOSTIC_LIMITS = [
  "This command does not accept or compare an independently retained Yahoo final-board manifest.",
  "This command does not establish that an artifact was held out until after the implementation freeze.",
  "This command does not run every cumulative prefix through the frozen production reconciler.",
] as const;

function structuralBlockers(input: {
  readonly postdraft: boolean;
  readonly collectionComplete: boolean;
  readonly expectedPickCountMatches: boolean;
  readonly configuredTeamCountMatches: boolean;
  readonly exactTeamMappings: boolean;
  readonly exactPlayerMappings: boolean;
  readonly noExplicitKeeperContradiction: boolean;
  readonly costShapeValid: boolean;
}): readonly string[] {
  const blockers: string[] = [];
  if (!input.postdraft) blockers.push("Yahoo does not report a completed draft.");
  if (!input.collectionComplete) blockers.push("The cumulative collection is incomplete.");
  if (!input.expectedPickCountMatches)
    blockers.push("The observed pick count does not fill the configured draft room.");
  if (!input.configuredTeamCountMatches)
    blockers.push("The observed board does not include every configured team.");
  if (!input.exactTeamMappings) blockers.push("One or more Yahoo team keys are unresolved.");
  if (!input.exactPlayerMappings) blockers.push("One or more Yahoo player keys are unresolved.");
  if (!input.noExplicitKeeperContradiction)
    blockers.push("Yahoo explicitly marked one or more keeper picks.");
  if (!input.costShapeValid)
    blockers.push("The observed cost fields do not match the draft format.");
  return blockers;
}

const environment = loadEnvironment();
if (
  environment.NEXT_PUBLIC_YAHOO_ACCESS_STATUS !== "available" ||
  !environment.YAHOO_CLIENT_ID ||
  !environment.YAHOO_CLIENT_SECRET ||
  !environment.CREDENTIAL_ENCRYPTION_KEY
) {
  throw new Error("Yahoo server credentials and the Yahoo release gate are required");
}

const requestedFormat = process.argv.find((argument) => argument.startsWith("--format="))?.slice(9);
if (requestedFormat && requestedFormat !== "snake" && requestedFormat !== "auction") {
  throw new Error("--format must be snake or auction");
}

const database = createDatabase(environment.DATABASE_URL, 2);
const tokens = new YahooConnectionService({
  database: database.db,
  credentialKey: parseCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY),
  clientId: environment.YAHOO_CLIENT_ID,
  clientSecret: environment.YAHOO_CLIENT_SECRET,
  redirectUri: environment.YAHOO_REDIRECT_URI,
});
const client = new YahooFantasyReadClient();

try {
  const targets = await database.db
    .select({
      leagueSeasonId: leagueSeasons.id,
      externalKey: leagueSeasons.externalKey,
      season: leagueSeasons.season,
      draftType: leagueSeasons.draftType,
      teamCount: leagueSeasons.teamCount,
      connectionId: providerConnections.id,
      connectionUserId: providerConnections.userId,
    })
    .from(providerLeagueLinks)
    .innerJoin(leagueSeasons, eq(providerLeagueLinks.leagueSeasonId, leagueSeasons.id))
    .innerJoin(providerConnections, eq(providerLeagueLinks.connectionId, providerConnections.id))
    .where(and(eq(leagueSeasons.provider, "yahoo"), eq(providerConnections.health, "healthy")))
    .orderBy(asc(leagueSeasons.season), asc(leagueSeasons.id), asc(providerConnections.createdAt));

  const seen = new Set<string>();
  const results: Record<string, unknown>[] = [];
  for (const target of targets) {
    if (seen.has(target.leagueSeasonId)) continue;
    seen.add(target.leagueSeasonId);
    const format = formatFor(target.draftType);
    if (format === null || (requestedFormat && requestedFormat !== format)) continue;
    const accessToken = await tokens.getAccessToken(target.connectionUserId, target.connectionId, {
      minimumValiditySeconds: 120,
    });
    const artifact = await client.getLeagueDraftResults({ accessToken }, target.externalKey);
    const settingsArtifact = await client.getLeagueSettings({ accessToken }, target.externalKey);
    const keeperSettings = safeKeeperEnvelope(settingsArtifact.xml);
    let snapshot;
    try {
      snapshot = parseYahooDraftResultsXml(artifact.xml, {
        expectedLeagueKey: target.externalKey,
      });
    } catch (error) {
      results.push({
        league: fingerprint(target.leagueSeasonId),
        season: target.season,
        format,
        diagnosticOutcome: "parser-rejected",
        structuralCandidate: false,
        selectionGateComplete: false,
        releaseAdmission: false,
        structuralBlockers: ["The strict Yahoo draftresults parser rejected this artifact."],
        parserErrorClass: error instanceof Error ? error.name : "UnknownError",
        rawArtifactChecksumSha256: createHash("sha256").update(artifact.xml, "utf8").digest("hex"),
        artifactBytes: Buffer.byteLength(artifact.xml, "utf8"),
        draftEnvelope: safeDraftEnvelope(artifact.xml),
        keeperSettings,
        xmlTags: safeXmlShape(artifact.xml),
        requirementsNotEvaluatedByThisDiagnostic: DIAGNOSTIC_LIMITS,
      });
      continue;
    }
    const teamKeys = [...new Set(snapshot.picks.map((pick) => pick.teamKey))];
    const playerKeys = [...new Set(snapshot.picks.map((pick) => pick.playerKey))];
    const [mappedTeams, mappedPlayers, slotRows] = await Promise.all([
      teamKeys.length === 0
        ? Promise.resolve([])
        : database.db
            .select({ key: fantasyTeams.externalKey })
            .from(fantasyTeams)
            .where(
              and(
                eq(fantasyTeams.leagueSeasonId, target.leagueSeasonId),
                inArray(fantasyTeams.externalKey, teamKeys),
              ),
            ),
      playerKeys.length === 0
        ? Promise.resolve([])
        : database.db
            .select({ key: playerExternalIds.externalId })
            .from(playerExternalIds)
            .where(
              and(
                eq(playerExternalIds.source, "yahoo"),
                eq(playerExternalIds.verified, true),
                inArray(playerExternalIds.externalId, playerKeys),
              ),
            ),
      database.db
        .select({ code: rosterSlotRules.slotCode, count: rosterSlotRules.count })
        .from(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, target.leagueSeasonId)),
    ]);
    const rosterSize = slotRows
      .filter((row) => !["IR", "TAXI", "TAXI_SQUAD"].includes(row.code.trim().toUpperCase()))
      .reduce((sum, row) => sum + row.count, 0);
    const expectedPickCount = target.teamCount * rosterSize;
    const costShapeValid =
      format === "auction"
        ? snapshot.picks.every((pick) => Number.isSafeInteger(pick.cost) && pick.cost !== null)
        : snapshot.picks.every((pick) => pick.cost === null);
    const checks = {
      postdraft: snapshot.status === "postdraft",
      collectionComplete: snapshot.collectionComplete,
      expectedPickCountMatches: snapshot.observedCount === expectedPickCount,
      configuredTeamCountMatches: teamKeys.length === target.teamCount,
      exactTeamMappings: mappedTeams.length === teamKeys.length,
      exactPlayerMappings: mappedPlayers.length === playerKeys.length,
      noExplicitKeeperContradiction: snapshot.picks.every((pick) => pick.keeper !== true),
      costShapeValid,
    };
    const blockers = structuralBlockers(checks);
    const structuralCandidate = blockers.length === 0;
    results.push({
      league: fingerprint(target.leagueSeasonId),
      season: target.season,
      format,
      diagnosticOutcome: structuralCandidate ? "structural-candidate" : "structurally-blocked",
      structuralCandidate,
      selectionGateComplete: false,
      releaseAdmission: false,
      providerStatus: snapshot.status,
      declaredCount: snapshot.declaredCount,
      observedCount: snapshot.observedCount,
      expectedPickCount,
      distinctTeams: teamKeys.length,
      configuredTeams: target.teamCount,
      exactTeamMappings: mappedTeams.length,
      exactPlayerMappings: mappedPlayers.length,
      explicitlyMarkedKeeperPicks: snapshot.picks.filter((pick) => pick.keeper === true).length,
      unclassifiedKeeperPicks: snapshot.picks.filter((pick) => pick.keeper === null).length,
      costShapeValid,
      keeperSettings,
      artifactChecksum: snapshot.checksumSha256,
      structuralChecks: checks,
      structuralBlockers: blockers,
      requirementsNotEvaluatedByThisDiagnostic: DIAGNOSTIC_LIMITS,
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        evidenceClass: "selection-diagnostic-only",
        releaseAdmission: false,
        exitCodeMeaning: "The diagnostic completed; it is never a release-admission result.",
        admissionRequirementsNotEvaluated: DIAGNOSTIC_LIMITS,
        results,
      },
      null,
      2,
    )}\n`,
  );
  if (results.length === 0) process.exitCode = 1;
} finally {
  await database.close();
}
