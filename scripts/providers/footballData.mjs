// football-data.org (v4) provider — sole source.
//
// The FIFA World Cup competition (code "WC", id 2000) is on football-data.org's
// FREE tier, so it covers the 2026 tournament at no cost (unlike API-Football's
// free tier, which excludes the current season).
//
// Exposes the same fetcher API the orchestrator expects. football-data has a
// single competition /matches endpoint that returns ALL matches (including any
// in-play scores), so both "all fixtures" and "live" map to one call.
//
// Auth: free personal token in the `X-Auth-Token` header.
// Docs: https://docs.football-data.org/general/v4/
// Rate limit (free): ~10 requests/minute. We make ≤2 per run.

import { resolveTeam } from "../teams.mjs";

const BASE = "https://api.football-data.org/v4";

function headers(env) {
  if (!env.FOOTBALL_DATA_TOKEN) throw new Error("FOOTBALL_DATA_TOKEN is not set");
  return { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN };
}

async function get(path, env) {
  const res = await fetch(`${BASE}${path}`, { headers: headers(env) });
  if (res.status === 429) throw new Error("football-data rate limit (429)");
  if (!res.ok) throw new Error(`football-data ${path} -> HTTP ${res.status}`);
  return res.json();
}

// football-data status enum -> our 4-state model.
function mapStatus(status) {
  switch (status) {
    case "IN_PLAY": return "LIVE";
    case "PAUSED":  return "HT";
    case "FINISHED":
    case "AWARDED": return "FT";
    default:        return "NS"; // SCHEDULED/TIMED/SUSPENDED/POSTPONED/CANCELLED
  }
}

// "GROUP_A" / "Group A" / "A" -> "A"
function letterFromGroup(raw) {
  if (!raw) return null;
  const m = String(raw).match(/GROUP[_ ]?([A-L])\b/i) || String(raw).match(/\b([A-L])\b/i);
  return m ? m[1].toUpperCase() : null;
}

function normalizeMatch(m) {
  const home = resolveTeam(m?.homeTeam?.name);
  const away = resolveTeam(m?.awayTeam?.name);
  if (!home || !away) return null; // unknown / non-tournament team
  return {
    id: m.id,
    group: letterFromGroup(m.group),
    home: home.name,
    away: away.name,
    homeFlag: home.flag,
    awayFlag: away.flag,
    homeScore: m?.score?.fullTime?.home ?? null,
    awayScore: m?.score?.fullTime?.away ?? null,
    status: mapStatus(m.status),
    kickoffUTC: m.utcDate, // ISO-8601 UTC
    minute: m.minute ?? null,
  };
}

async function fetchMatches(env) {
  const season = env.SEASON ? `?season=${env.SEASON}` : "";
  const json = await get(`/competitions/${env.COMPETITION}/matches${season}`, env);
  return (json.matches ?? []).map(normalizeMatch).filter(Boolean);
}

// Both map to the single /matches call (it already includes in-play scores).
export const fetchAllFixtures = fetchMatches;
export const fetchLiveFixtures = fetchMatches;

/** Group standings -> [{ letter, standings:[row...] }] + team→group map. */
export async function fetchStandings(env) {
  const json = await get(`/competitions/${env.COMPETITION}/standings${env.SEASON ? `?season=${env.SEASON}` : ""}`, env);
  // DIAGNOSTIC: reveal the raw standings shape so we can see why parsing yields 0.
  const raw = json.standings ?? [];
  console.log(`[standings] season=${json?.season?.id ?? "?"} blocks=${raw.length}` +
    ` types=[${[...new Set(raw.map((b) => b.type))].join(",")}]` +
    ` groups=[${[...new Set(raw.map((b) => b.group))].join(",")}]` +
    ` stages=[${[...new Set(raw.map((b) => b.stage))].join(",")}]` +
    ` rows0=${raw[0]?.table?.length ?? 0}`);
  const blocks = raw.filter((s) => s.type === "TOTAL");
  const groupsByLetter = new Map();
  const teamGroup = new Map();

  for (const block of blocks) {
    const letter = letterFromGroup(block.group);
    if (!letter) continue;
    for (const row of block.table ?? []) {
      const team = resolveTeam(row?.team?.name);
      if (!team) continue;
      teamGroup.set(team.name, letter);
      const entry = {
        team: team.name,
        flag: team.flag,
        played: row.playedGames ?? 0,
        won: row.won ?? 0,
        drawn: row.draw ?? 0,
        lost: row.lost ?? 0,
        goalsFor: row.goalsFor ?? 0,
        goalsAgainst: row.goalsAgainst ?? 0,
        goalDifference: row.goalDifference ?? (row.goalsFor ?? 0) - (row.goalsAgainst ?? 0),
        points: row.points ?? 0,
        rank: row.position ?? 0,
      };
      if (!groupsByLetter.has(letter)) groupsByLetter.set(letter, []);
      groupsByLetter.get(letter).push(entry);
    }
  }

  const groups = [...groupsByLetter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, standings]) => ({
      letter,
      standings: standings.sort((a, b) => a.rank - b.rank),
    }));

  return { groups, teamGroup };
}
