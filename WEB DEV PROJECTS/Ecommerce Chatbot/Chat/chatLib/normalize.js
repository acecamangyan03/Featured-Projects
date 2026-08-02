// lib/search/normalize.js
export function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")     // strip accents
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  // en
  "do","does","did","you","have","is","are","the","a","an","of","for","on","in","to",
  "please","pls","got","any","some","your","my","me","show","find","want","need",
  "with","and","or","price","cost","how","much","under","below","less","than",

  // taglish helpers
  "meron","may","kayo","ka","po","ba","paki","lang","naman","eto","ito","yan","yun",
]);

export function tokenizeQuery(text) {
  const t = normalizeText(text);
  return Array.from(new Set(t.split(" ").filter(w => w && !STOP_WORDS.has(w))));
}
