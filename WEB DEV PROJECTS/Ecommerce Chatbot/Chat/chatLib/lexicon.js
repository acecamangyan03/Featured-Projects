// lib/search/lexicon.js
// Brand & series aliases derived from your inventory (Export_Product_2025-10-19.csv)
// You can add more, but keep keys lowercase.

export const BRAND_ALIASES = {
  // "&honey" appears as "Honey" in your CSV
  "&honey": ["and honey","& honey","n honey","honey"],
  "honey":  ["&honey","and honey","& honey","hony","honie","huney"],

  // Himawari series (present in your CSV)
  "himawari": ["kracie himawari","sunflower","hinawari","himawary"],
  "volume & repair": ["volume repair","v&r","vol & repair"],
  "rich & repair":   ["rich repair","r&r"],
  "smooth & repair": ["smooth repair","s&r"],

  // Hada Labo
  "hada labo": ["hadalabo","hada-labo","rohto hada labo","gokujyun","gokujun","shirojyun"],
  "gokujyun":  ["gokujun","goku jyun","goku-jyun"],
  "premium":   ["prem","prm"],

  // Biore, Meiji, Kewpie (all present in CSV)
  "biore": ["bioré","bio re","b-ore"],
  "meiji": ["meji","meiji brand"],
  "kewpie": ["qpi","kew pe","cuepi"],

  // Common series/variants in your file
  "deep moist": ["deepmoist","dm","10","dp moist"],
  "melty":      ["moist repair","melty repair","melti"],
  "treatment":  ["conditioner","cond","condish","treat"],
  "shampoo":    ["shampu","shmp","sampoo"],
  "face wash":  ["facial wash","facial cleanser","cleanser","wash"],
  "toner":      ["lotion"],   // JP brands often call toners "lotion"
  "body wash":  ["sabon","sabun","body soap","shower gel"],
  "toothpaste": ["tooth paste","paste ngipin","ngipin paste"],

  // pack/size hints
  "ml": ["mL","milliliter","milliliters"],
  "g":  ["gram","grams"]
};

// category keywords → your Firestore categories
export const CATEGORY_KEYWORDS = {
  "snacks": ["snack","chips","choco","biscuit","cookie","candy","pretzel"],
  "juice & beverage": ["drink","juice","tea","coffee","matcha","ramune","beverage"],
  "hygiene": ["soap","shampoo","conditioner","treatment","toothpaste","body wash","toiletries","personal care"],
  "beauty & cosmetics": ["toner","serum","mask","lotion","skincare","skin care","cleanser","face wash"],
  "kitchen ingredients": ["sauce","oil","seasoning","kewpie","mayo","soy","vinegar","rice"],
};
