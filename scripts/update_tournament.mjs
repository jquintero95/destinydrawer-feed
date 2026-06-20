// Orchestrator for the Global Tournament 2026 live feed.
//
// Runs on a frequent cron (every ~5 min) but makes API calls only when needed.
// Source is football-data.org's FREE tier (FIFA World Cup, code "WC"); the limit
// there is ~10 requests/minute (no daily season cap), and the windowing below
// keeps us to ≤2 calls per run. See LIVE_TOURNAMENT_PLAN.md §4. Strategy:
//
//   1. Daily schedule pull (1 call) → cache kickoff windows.
//   2. Idle ticks (no live window) → no API calls, exit early.
//   3. Live window → fetch live fixtures (1 call), merge scores/status.
//   4. On any match flipping to FT → fetch standings (1 call), replace groups.
//   5. Per-day call counter hard-stops at the cap. On any API error/cap, the
//      last good tournament2026.json is kept untouched — the apps serve it as
//      "stale but valid". There is no live fallback source.
//   6. Diff-before-write: only rewrite tournament2026.json when data changed.
//
// State persists in scripts/.tournament-state.json (committed alongside output).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as provider from "./providers/footballData.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "tournament2026.json");
const STATE = path.join(__dirname, ".tournament-state.json");
const FAIR_PLAY_FILE = path.join(__dirname, "fair-play.json");

// Load fair-play deductions. Keys are canonical team names, values are negative
// integers (e.g. -1 per yellow card). Teams absent from the file default to 0.
function loadFairPlay() {
  try {
    const raw = JSON.parse(fs.readFileSync(FAIR_PLAY_FILE, "utf8"));
    return raw.teams && typeof raw.teams === "object" ? raw.teams : {};
  } catch {
    return {};
  }
}

const env = {
  FOOTBALL_DATA_TOKEN: process.env.FOOTBALL_DATA_TOKEN,
  COMPETITION: process.env.WC_COMPETITION || "WC", // FIFA World Cup
  SEASON: process.env.WC_SEASON || "2026",
  // Remotely-controlled free-access cutoff (ISO-8601). Apps read this from the
  // feed to decide when live/share stops being free. Edit in the workflow.
  FREE_UNTIL: process.env.FREE_UNTIL || "",
};

const DAILY_CAP = Number(process.env.DAILY_CALL_CAP || "95"); // headroom under 100
const MATCH_WINDOW_MS = 150 * 60 * 1000; // kickoff → +2h30m counts as "live"
const SCHEDULE_REFRESH_HOUR_UTC = 4;

// ---- small helpers -------------------------------------------------------

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const today = () => new Date().toISOString().slice(0, 10);

function loadState() {
  const s = readJSON(STATE, {});
  if (s.day !== today()) { s.day = today(); s.calls = 0; } // reset daily counter
  s.calls ??= 0;
  s.windows ??= [];        // [{startMs, endMs}]
  s.scheduleDay ??= "";    // day the schedule was last refreshed
  return s;
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); }

function canCall(state, n = 1) { return state.calls + n <= DAILY_CAP; }
function spend(state, n = 1) { state.calls += n; }

function inLiveWindow(state, now = Date.now()) {
  return state.windows.some((w) => now >= w.startMs && now <= w.endMs);
}

function buildWindows(fixtures) {
  return fixtures
    .filter((f) => f.kickoffUTC)
    .map((f) => {
      const start = new Date(f.kickoffUTC).getTime();
      return { startMs: start, endMs: start + MATCH_WINDOW_MS };
    });
}

// Stable stringify (sorted keys) so diffing ignores key ordering.
function stable(obj) {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

// Recompute ranks within each group after a merge (points, GD, GF, name).
function reRank(groups) {
  for (const g of groups) {
    g.standings.sort((a, b) =>
      b.points - a.points || b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor || a.team.localeCompare(b.team));
    g.standings.forEach((s, i) => { s.rank = i + 1; });
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  let doc = readJSON(OUTPUT, null);

  if (!env.FOOTBALL_DATA_TOKEN) {
    console.warn("FOOTBALL_DATA_TOKEN not set — nothing to do.");
    return;
  }

  // Paid plan: fetch everything on every run. football-data's /matches returns
  // ALL matches (incl. live & finished scores) in one call, and /standings gives
  // the authoritative table — so two calls fully refresh the feed each run, with
  // no windowing/cap fragility. On error, the last good JSON is kept untouched.
  try {
    const fixtures = await provider.fetchAllFixtures(env);   // all matches, current state
    // DIAGNOSTIC: status breakdown + any matches that already carry a score.
    const byStatus = {};
    for (const f of fixtures) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    const withScore = fixtures.filter((f) => f.homeScore != null).length;
    console.log(`[matches] statuses=${JSON.stringify(byStatus)} withScore=${withScore}`);

    // Team→group + team→flag from fixtures.
    const teamGroup = new Map();
    const teamFlag = new Map();
    for (const f of fixtures) {
      if (f.group) { teamGroup.set(f.home, f.group); teamGroup.set(f.away, f.group); }
      teamFlag.set(f.home, f.homeFlag); teamFlag.set(f.away, f.awayFlag);
    }
    // Compute standings ourselves from finished matches. football-data's own
    // /standings table lags behind its match results, so deriving the table from
    // the scores keeps it instant and always consistent with what's shown.
    const fairPlay = loadFairPlay();
    const groups = computeStandings(fixtures, teamGroup, teamFlag, fairPlay);
    console.log(`[standings] computed ${groups.length} groups from results.`);

    const before = doc ? contentKey(doc) : "";
    const next = rebuildDoc(doc, fixtures, groups);          // REPLACE matches + groups
    if (env.FREE_UNTIL) next.freeUntil = env.FREE_UNTIL;
    next.tournamentStatus = "group_stage";

    // Commit only when the actual content changed (ignore the timestamp), so we
    // don't churn a commit every 5 minutes when nothing moved.
    if (contentKey(next) !== before) {
      next.lastUpdated = new Date().toISOString();
      writeOutput(next);
      const active = fixtures.filter((f) => f.status !== "NS").length;
      console.log(`Updated: ${fixtures.length} matches (${active} live/finished), ${groups.length} groups.`);
    } else {
      console.log(`No change: ${fixtures.length} matches, ${groups.length} groups.`);
    }
  } catch (e) {
    console.warn("Update failed — keeping last good JSON:", e.message);
  }
}

// Stable stringify of the document EXCLUDING `lastUpdated`, so we can detect real
// content changes without the timestamp always making it look different.
function contentKey(doc) {
  const { lastUpdated, ...rest } = doc;
  return stable(rest);
}

// Build group standings from the match results (only FINISHED matches count),
// independent of the provider's own — and slower-to-update — standings table.
function computeStandings(fixtures, teamGroup, teamFlag, fairPlay = {}) {
  const table = new Map(); // team -> stats
  const ensure = (name) => {
    if (!table.has(name)) {
      table.set(name, {
        team: name, flag: teamFlag.get(name) || "",
        played: 0, won: 0, drawn: 0, lost: 0,
        goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, rank: 0,
        fairPlay: fairPlay[name] ?? 0,
      });
    }
    return table.get(name);
  };
  // Seed every team in a group so groups are complete even before any games.
  for (const name of teamGroup.keys()) ensure(name);

  for (const f of fixtures) {
    if (f.status !== "FT" || f.homeScore == null || f.awayScore == null) continue;
    if (!f.group) continue; // group-stage matches only (skip knockout fixtures)
    const h = ensure(f.home), a = ensure(f.away);
    h.played++; a.played++;
    h.goalsFor += f.homeScore; h.goalsAgainst += f.awayScore;
    a.goalsFor += f.awayScore; a.goalsAgainst += f.homeScore;
    if (f.homeScore > f.awayScore) { h.won++; h.points += 3; a.lost++; }
    else if (f.homeScore < f.awayScore) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  for (const t of table.values()) t.goalDifference = t.goalsFor - t.goalsAgainst;

  const byLetter = new Map();
  for (const [name, stats] of table) {
    const letter = teamGroup.get(name);
    if (!letter) continue;
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(stats);
  }
  return [...byLetter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, rows]) => {
      rows.sort((a, b) =>
        b.points - a.points || b.goalDifference - a.goalDifference ||
        b.goalsFor - a.goalsFor || a.team.localeCompare(b.team));
      rows.forEach((r, i) => { r.rank = i + 1; });
      return { letter, standings: rows };
    });
}

// Rebuild the document from the authoritative full fixture list (+ optional
// standings), REPLACING matches and groups. Used on the daily schedule refresh
// so the feed is a clean mirror of the source — no stale/seed accumulation.
function rebuildDoc(doc, fixtures, groups) {
  const base = doc && typeof doc === "object" ? doc : emptyDoc();
  if (groups && groups.length) base.groups = groups;

  const teamGroup = new Map();
  for (const g of base.groups || []) for (const s of g.standings) teamGroup.set(s.team, g.letter);

  base.matches = fixtures
    .map((f) => ({
      id: f.id,
      group: f.group || teamGroup.get(f.home) || teamGroup.get(f.away) || null,
      home: f.home, away: f.away,
      homeScore: f.homeScore, awayScore: f.awayScore,
      status: f.status, kickoffUTC: f.kickoffUTC, minute: f.minute,
    }))
    .sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));
  base.schemaVersion ||= 1;
  return base;
}

// Merge incoming fixtures into the document's match list, preserving any matches
// not present in this batch (e.g. a live batch only contains in-progress games).
function mergeFixtures(doc, fixtures) {
  const base = doc && typeof doc === "object" ? doc : emptyDoc();
  const byId = new Map((base.matches || []).map((m) => [m.id, m]));
  // Build team→group from current groups (feed-driven membership).
  const teamGroup = new Map();
  for (const g of base.groups || []) for (const s of g.standings) teamGroup.set(s.team, g.letter);

  for (const f of fixtures) {
    const group = f.group || teamGroup.get(f.home) || teamGroup.get(f.away) || null;
    byId.set(f.id, {
      id: f.id, group,
      home: f.home, away: f.away,
      homeScore: f.homeScore, awayScore: f.awayScore,
      status: f.status, kickoffUTC: f.kickoffUTC, minute: f.minute,
    });
  }
  base.matches = [...byId.values()].sort(
    (a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));
  base.schemaVersion ||= 1;
  return base;
}

function emptyDoc() {
  return { schemaVersion: 1, lastUpdated: new Date().toISOString(),
           tournamentStatus: "not_started", freeUntil: env.FREE_UNTIL || null,
           groups: [], matches: [] };
}

function writeOutput(doc) {
  fs.writeFileSync(OUTPUT, JSON.stringify(doc, null, 2) + "\n");
  console.log("Wrote", path.basename(OUTPUT));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
