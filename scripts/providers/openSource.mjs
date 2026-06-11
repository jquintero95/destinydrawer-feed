// Open-source worldcup2026 provider — FALLBACK source.
//
// Used only when API-Football errors, rate-limits, or the daily cap is reached.
// It returns a COMPLETE normalized document (groups + matches) so the
// orchestrator can write it directly. Because the free community feed's exact
// shape may change, this transform is deliberately defensive and isolated here.
//
// Configure the base URL via env (OPEN_SOURCE_BASE). The reference project is
// https://github.com/rezarahiminia/worldcup2026 — VERIFY the endpoint paths and
// field names against the live feed before relying on this in production.

import { resolveTeam } from "../teams.mjs";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-source feed ${url} -> HTTP ${res.status}`);
  return res.json();
}

function mapStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("final") || s === "ft" || s.includes("finished")) return "FT";
  if (s.includes("half")) return "HT";
  if (s.includes("live") || s.includes("progress") || s.includes("playing")) return "LIVE";
  return "NS";
}

// Extracts an A–L letter from various possible group representations.
function letterFrom(raw) {
  if (!raw) return null;
  const m = String(raw).match(/([A-L])\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Fetches and normalizes the full feed.
 * Expected (defensive) shapes:
 *   GET {base}/matches  -> [{ id, group, homeTeam, awayTeam, homeScore, awayScore, status, date }]
 *   GET {base}/groups   -> [{ letter|name, teams:[{ name, played, win, draw, lose, gf, ga, points, rank }] }]
 * Field names are coerced loosely; adjust here if the real feed differs.
 */
export async function fetchFullFeed(env) {
  const base = (env.OPEN_SOURCE_BASE || "").replace(/\/$/, "");
  if (!base) throw new Error("OPEN_SOURCE_BASE is not set");

  const [rawGroups, rawMatches] = await Promise.all([
    getJSON(`${base}/groups`),
    getJSON(`${base}/matches`),
  ]);

  const groups = (Array.isArray(rawGroups) ? rawGroups : rawGroups.groups || [])
    .map((g) => {
      const letter = letterFrom(g.letter ?? g.name ?? g.group);
      if (!letter) return null;
      const standings = (g.teams || g.standings || [])
        .map((t) => {
          const team = resolveTeam(t.name ?? t.team);
          if (!team) return null;
          const gf = num(t.gf ?? t.goalsFor ?? t.for);
          const ga = num(t.ga ?? t.goalsAgainst ?? t.against);
          return {
            team: team.name,
            flag: team.flag,
            played: num(t.played ?? t.mp),
            won: num(t.win ?? t.won ?? t.w),
            drawn: num(t.draw ?? t.drawn ?? t.d),
            lost: num(t.lose ?? t.lost ?? t.l),
            goalsFor: gf,
            goalsAgainst: ga,
            goalDifference: num(t.goalDifference ?? t.gd ?? gf - ga),
            points: num(t.points ?? t.pts),
            rank: num(t.rank ?? t.position),
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.rank || 99) - (b.rank || 99));
      return { letter, standings };
    })
    .filter(Boolean)
    .sort((a, b) => a.letter.localeCompare(b.letter));

  const matches = (Array.isArray(rawMatches) ? rawMatches : rawMatches.matches || [])
    .map((m, i) => {
      const home = resolveTeam(m.homeTeam ?? m.home ?? m.home_name);
      const away = resolveTeam(m.awayTeam ?? m.away ?? m.away_name);
      if (!home || !away) return null;
      return {
        id: Number(m.id ?? i),
        group: letterFrom(m.group),
        home: home.name,
        away: away.name,
        homeScore: m.homeScore ?? m.home_score ?? null,
        awayScore: m.awayScore ?? m.away_score ?? null,
        status: mapStatus(m.status),
        kickoffUTC: m.date ?? m.kickoff ?? m.utcDate,
        minute: m.minute ?? null,
      };
    })
    .filter(Boolean);

  return {
    schemaVersion: 1,
    lastUpdated: new Date().toISOString(),
    tournamentStatus: inferStatus(groups, matches),
    groups,
    matches,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inferStatus(groups, matches) {
  const anyPlayed = groups.some((g) => g.standings.some((s) => s.played > 0));
  if (!anyPlayed) return "not_started";
  return "group_stage";
}
