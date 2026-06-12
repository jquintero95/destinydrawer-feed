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
  const state = loadState();
  const now = Date.now();
  let doc = readJSON(OUTPUT, null);
  let changed = false;

  // Stamp the configured free-access cutoff so it rides in the feed (and in
  // every diff). Setting it here means a FREE_UNTIL change alone triggers a
  // commit on the next run.
  if (doc && env.FREE_UNTIL && doc.freeUntil !== env.FREE_UNTIL) {
    doc.freeUntil = env.FREE_UNTIL;
    changed = true;
  }

  // (1) Daily schedule refresh — learn today's kickoff windows (1 call).
  const hourUTC = new Date(now).getUTCHours();
  const needSchedule = state.scheduleDay !== today() && hourUTC >= SCHEDULE_REFRESH_HOUR_UTC;
  if (needSchedule && env.FOOTBALL_DATA_TOKEN && canCall(state)) {
    try {
      const fixtures = await provider.fetchAllFixtures(env);
      spend(state);
      state.windows = buildWindows(fixtures);
      state.scheduleDay = today();

      // Also pull authoritative standings on the daily refresh so the table is
      // correct even before any in-play tick (1 extra call).
      let groups = null;
      if (canCall(state)) {
        ({ groups } = await provider.fetchStandings(env));
        spend(state);
      }

      // REPLACE matches + groups from the authoritative feed (don't merge — that
      // would let stale/seed entries accumulate). This is the source of truth.
      doc = rebuildDoc(doc, fixtures, groups);
      doc.lastUpdated = new Date().toISOString();
      doc.tournamentStatus ||= "group_stage";
      changed = true;
      console.log(`Schedule refreshed: ${fixtures.length} fixtures, ${(groups || []).length} groups, ${state.windows.length} windows.`);
    } catch (e) {
      console.warn("Schedule refresh failed:", e.message);
    }
  }

  // (2) Idle — no live match. Exit without spending calls.
  if (!inLiveWindow(state, now)) {
    if (changed && doc) writeOutput(doc);
    saveState(state);
    console.log("Idle tick — no live window. Calls used today:", state.calls);
    return;
  }

  // (3) Live window — fetch from API-Football. On any error/cap, keep the last
  // good JSON untouched (no fallback source; apps serve it as stale-but-valid).
  try {
    if (!env.FOOTBALL_DATA_TOKEN) throw new Error("no API token");
    if (!canCall(state)) throw new Error("daily cap reached");

    const live = await provider.fetchLiveFixtures(env);
    spend(state);
    const before = doc ? stable(doc) : "";
    doc = mergeFixtures(doc, live);

    // (4) Standings only when a match just finished (authoritative recompute).
    const someFinished = live.some((m) => m.status === "FT");
    if (someFinished && canCall(state)) {
      const { groups } = await provider.fetchStandings(env);
      spend(state);
      if (groups.length) { doc.groups = groups; }
    } else if (doc.groups) {
      reRank(doc.groups);
    }
    doc.lastUpdated = new Date().toISOString();
    doc.tournamentStatus ||= "group_stage";
    if (stable(doc) !== before) changed = true;
    console.log(`Live tick: ${live.length} live fixtures. Calls used today: ${state.calls}`);
  } catch (err) {
    console.warn("Update skipped:", err.message, "— keeping last good JSON.");
  }

  if (changed && doc) writeOutput(doc);
  saveState(state);
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
