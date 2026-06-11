// API-Football (api-sports.io) provider — PRIMARY source.
//
// Exposes granular fetchers so the orchestrator can control call volume to stay
// inside the free tier (~100 req/day). Each function returns data already
// normalized to the app's schema vocabulary (canonical names + flags).
//
// Docs: https://www.api-football.com/documentation-v3
// World Cup league id is 1; pass season via env (e.g. 2026).

import { resolveTeam } from "../teams.mjs";

const BASE = "https://v3.football.api-sports.io";

function headers(env) {
  if (!env.API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY is not set");
  return { "x-apisports-key": env.API_FOOTBALL_KEY };
}

async function get(path, env) {
  const res = await fetch(`${BASE}${path}`, { headers: headers(env) });
  if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors || {}).length) {
    throw new Error(`API-Football ${path} -> ${JSON.stringify(json.errors)}`);
  }
  return json.response ?? [];
}

// Map API-Football short status codes to our 4-state model.
function mapStatus(short) {
  switch (short) {
    case "HT": return "HT";
    case "1H": case "2H": case "ET": case "BT": case "P": case "LIVE": case "INT":
      return "LIVE";
    case "FT": case "AET": case "PEN":
      return "FT";
    default:
      return "NS"; // NS/TBD/PST/CANC/etc. — treat as not-yet-counted
  }
}

function normalizeFixture(f) {
  const home = resolveTeam(f?.teams?.home?.name);
  const away = resolveTeam(f?.teams?.away?.name);
  if (!home || !away) return null; // outside our 48-team set / unknown name
  return {
    id: f.fixture.id,
    home: home.name,
    away: away.name,
    homeFlag: home.flag,
    awayFlag: away.flag,
    homeScore: f.goals?.home ?? null,
    awayScore: f.goals?.away ?? null,
    status: mapStatus(f?.fixture?.status?.short),
    kickoffUTC: f.fixture.date, // already ISO-8601 UTC
    minute: f?.fixture?.status?.elapsed ?? null,
  };
}

/** All fixtures for the tournament (used for schedule + the base match list). */
export async function fetchAllFixtures(env) {
  const resp = await get(`/fixtures?league=${env.LEAGUE_ID}&season=${env.SEASON}`, env);
  return resp.map(normalizeFixture).filter(Boolean);
}

/** Only the currently-live fixtures (1 call covers all concurrent matches). */
export async function fetchLiveFixtures(env) {
  const resp = await get(`/fixtures?league=${env.LEAGUE_ID}&season=${env.SEASON}&live=all`, env);
  return resp.map(normalizeFixture).filter(Boolean);
}

/** Group standings, normalized to [{ letter, standings:[row...] }] + team→group map. */
export async function fetchStandings(env) {
  const resp = await get(`/standings?league=${env.LEAGUE_ID}&season=${env.SEASON}`, env);
  const league = resp?.[0]?.league;
  const blocks = league?.standings ?? []; // array of group-arrays
  const groupsByLetter = new Map();
  const teamGroup = new Map();

  for (const block of blocks) {
    for (const row of block) {
      const team = resolveTeam(row?.team?.name);
      if (!team) continue;
      const letter = letterFromGroup(row.group);
      if (!letter) continue;
      teamGroup.set(team.name, letter);
      const entry = {
        team: team.name,
        flag: team.flag,
        played: row.all?.played ?? 0,
        won: row.all?.win ?? 0,
        drawn: row.all?.draw ?? 0,
        lost: row.all?.lose ?? 0,
        goalsFor: row.all?.goals?.for ?? 0,
        goalsAgainst: row.all?.goals?.against ?? 0,
        goalDifference: row.goalsDiff ?? (row.all?.goals?.for ?? 0) - (row.all?.goals?.against ?? 0),
        points: row.points ?? 0,
        rank: row.rank ?? 0,
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

// "Group A" / "Group: A" / "A" -> "A"
function letterFromGroup(raw) {
  if (!raw) return null;
  const m = String(raw).match(/([A-L])\b/i);
  return m ? m[1].toUpperCase() : null;
}
