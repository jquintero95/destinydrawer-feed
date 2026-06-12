// Canonical team table for the Global Tournament 2026 live feed.
//
// The iOS/Android apps join a user's draw to the feed BY FLAG EMOJI, and the
// app's draw template (`TemplateProvider.worldCup2026Teams`) uses these exact
// flags. So the single most important job of the data pipeline is to map each
// provider's team name to the correct flag here. The canonical English `name`
// must match the keys in `TemplateProvider.worldCup2026Groups`.
//
// `aliases` lists the alternate spellings different providers use (API-Football,
// the open-source feed, etc.) so normalization is provider-agnostic.

export const TEAMS = [
  { name: "United States",        flag: "🇺🇸", aliases: ["USA", "United States of America", "US"] },
  { name: "Mexico",               flag: "🇲🇽", aliases: [] },
  { name: "Canada",               flag: "🇨🇦", aliases: [] },
  { name: "Germany",              flag: "🇩🇪", aliases: [] },
  { name: "France",               flag: "🇫🇷", aliases: [] },
  { name: "Spain",                flag: "🇪🇸", aliases: [] },
  { name: "England",              flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", aliases: [] },
  { name: "Portugal",             flag: "🇵🇹", aliases: [] },
  { name: "Netherlands",          flag: "🇳🇱", aliases: ["Holland"] },
  { name: "Belgium",              flag: "🇧🇪", aliases: [] },
  { name: "Croatia",              flag: "🇭🇷", aliases: [] },
  { name: "Switzerland",          flag: "🇨🇭", aliases: [] },
  { name: "Austria",              flag: "🇦🇹", aliases: [] },
  { name: "Türkiye",              flag: "🇹🇷", aliases: ["Turkey", "Turkiye"] },
  { name: "Bosnia & Herzegovina", flag: "🇧🇦", aliases: ["Bosnia and Herzegovina", "Bosnia-Herzegovina", "Bosnia"] },
  { name: "Sweden",               flag: "🇸🇪", aliases: [] },
  { name: "Czech Republic",       flag: "🇨🇿", aliases: ["Czechia"] },
  { name: "Scotland",             flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", aliases: [] },
  { name: "Norway",               flag: "🇳🇴", aliases: [] },
  { name: "Brazil",               flag: "🇧🇷", aliases: [] },
  { name: "Argentina",            flag: "🇦🇷", aliases: [] },
  { name: "Uruguay",              flag: "🇺🇾", aliases: [] },
  { name: "Colombia",             flag: "🇨🇴", aliases: [] },
  { name: "Ecuador",              flag: "🇪🇨", aliases: [] },
  { name: "Paraguay",             flag: "🇵🇾", aliases: [] },
  { name: "Morocco",              flag: "🇲🇦", aliases: [] },
  { name: "Senegal",              flag: "🇸🇳", aliases: [] },
  { name: "Egypt",                flag: "🇪🇬", aliases: [] },
  { name: "South Africa",         flag: "🇿🇦", aliases: [] },
  { name: "Ivory Coast",          flag: "🇨🇮", aliases: ["Côte d'Ivoire", "Cote d'Ivoire"] },
  { name: "Tunisia",              flag: "🇹🇳", aliases: [] },
  { name: "Algeria",              flag: "🇩🇿", aliases: [] },
  { name: "Cape Verde",           flag: "🇨🇻", aliases: ["Cape Verde Islands", "Cabo Verde"] },
  { name: "Ghana",                flag: "🇬🇭", aliases: [] },
  { name: "Japan",                flag: "🇯🇵", aliases: [] },
  { name: "South Korea",          flag: "🇰🇷", aliases: ["Korea Republic", "Republic of Korea", "Korea"] },
  { name: "Australia",            flag: "🇦🇺", aliases: [] },
  { name: "Saudi Arabia",         flag: "🇸🇦", aliases: [] },
  { name: "Iran",                 flag: "🇮🇷", aliases: ["IR Iran", "Iran Islamic Republic"] },
  { name: "Qatar",                flag: "🇶🇦", aliases: [] },
  { name: "Uzbekistan",           flag: "🇺🇿", aliases: [] },
  { name: "Jordan",               flag: "🇯🇴", aliases: [] },
  { name: "Panama",               flag: "🇵🇦", aliases: [] },
  { name: "Haiti",                flag: "🇭🇹", aliases: [] },
  { name: "Curacao",              flag: "🇨🇼", aliases: ["Curaçao"] },
  { name: "New Zealand",          flag: "🇳🇿", aliases: [] },
  { name: "DR Congo",             flag: "🇨🇩", aliases: ["Congo DR", "Democratic Republic of Congo", "DR Congo (Kinshasa)"] },
  { name: "Iraq",                 flag: "🇮🇶", aliases: [] },
];

// Build a normalized-lookup index: lowercased name/alias -> {name, flag}.
const INDEX = (() => {
  const map = new Map();
  for (const t of TEAMS) {
    const keys = [t.name, ...t.aliases];
    for (const k of keys) map.set(norm(k), { name: t.name, flag: t.flag });
  }
  return map;
})();

function norm(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z& ]/g, "")
    .trim();
}

/** Resolves any provider team name to { name, flag }, or null if unknown. */
export function resolveTeam(providerName) {
  if (!providerName) return null;
  return INDEX.get(norm(providerName)) ?? null;
}
