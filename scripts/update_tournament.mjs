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

    // Team→group map from fixtures (football-data's standings table isn't split
    // by group, so we use this to bucket it).
    const teamGroup = new Map();
    for (const f of fixtures) {
      if (f.group) { teamGroup.set(f.home, f.group); teamGroup.set(f.away, f.group); }
    }
    const { groups } = await provider.fetchStandings(env, teamGroup);

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
