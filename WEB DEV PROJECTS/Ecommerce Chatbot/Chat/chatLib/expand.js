// lib/search/expand.js
import { normalizeText, tokenizeQuery } from "./normalize";
import { BRAND_ALIASES, CATEGORY_KEYWORDS } from "./lexicon";

function expandByAliases(tokens) {
  const out = new Set(tokens);

  // alias → canonical (both ways)
  const canonToAliases = BRAND_ALIASES;
  const aliasToCanon = new Map();
  Object.entries(canonToAliases).forEach(([canon, aliases]) => {
    const c = normalizeText(canon);
    out.add(c);
    (aliases || []).forEach(a => aliasToCanon.set(normalizeText(a), c));
  });

  // map tokens through alias table
  tokens.forEach(t => {
    const canon = aliasToCanon.get(t);
    if (canon) out.add(canon);
    // also add back aliases for recall (help “deepmoist” ⇄ “deep moist”)
    const aliases = canonToAliases[canon];
    if (aliases) aliases.forEach(a => out.add(normalizeText(a)));
  });

  return Array.from(out);
}

export function detectCategory(tokens) {
  const tset = new Set(tokens);
  for (const [category, keys] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keys.some(k => tset.has(normalizeText(k)))) return category
  }
  return null;
}

export function expandQuery(raw) {
  const base = tokenizeQuery(raw);
  const expanded = expandByAliases(base);
  return {
    tokens: expanded,
    category: detectCategory(expanded)
  };
}
