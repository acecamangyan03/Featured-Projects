/* chatcomponents/chatApi.js */
/* Enhanced API functions with comprehensive e-commerce features */
import {
  getFirestore,
  collection,
  query,
  where,
  limit,
  getDocs,
  addDoc,
  orderBy,
  serverTimestamp,
  startAfter,
  writeBatch,
  Timestamp,
  documentId           // <-- add this
} from "firebase/firestore"
import { expandQuery } from "../pages/api/Chat/chatLib/expand";
import { normalizeText } from "../pages/api/Chat/chatLib/normalize";



const API_TIMEOUT = 60000; // 30 seconds
const MAX_RETRIES = 2;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const CHAT_ENDPOINT = `${API_BASE}/api/Chat/geminiChat`;
const IMAGE_SEARCH_ENDPOINT = `${API_BASE}/api/Chat/imageSearch`;
const TRACK_ENDPOINT = `${API_BASE}/api/Chat/trackOrder`;


// Enhanced product context building with Firestore-only sourcing

// --- add below your imports/constants in chatApi.js ---

// Text helpers used by buildProductContext (case/typo tolerant)
function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _tokens(s) {
  const parts = _norm(s).split(/\s+/).filter(Boolean);
  return Array.from(new Set(parts));
}

function _firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function _scoreProduct(item, terms) {
  const name = _norm(item.name || "");
  const cat  = _norm(item.category || "");
  const desc = _norm(item.description || "");
  let score = 0;

  for (const t of terms) {
    if (!t) continue;
    if (name.startsWith(t)) score += 2;       // strong signal
    if (name.includes(t))   score += 3;       // name match
    if (desc.includes(t))   score += 1;       // description hint
    if (cat.includes(t))    score += 0.5;     // category hint
  }
  return score;
}

// Builds a small product set from client Firestore (no admin SDK).
export async function buildProductContext(
  searchTerms = [],
  budget = null,
  category = null,
  onSale = false,
  newArrivals = false,
  followupProductHint = ""
) {
  const db = getFirestore();

  // FIXED: Accept either array or string; dedupe + normalize terms
  let terms;
  if (Array.isArray(searchTerms)) {
    // Clean array: remove empty strings and normalize
    terms = searchTerms
      .map(t => _norm(String(t || "")))
      .filter(t => t.length >= 2); // FIXED: Filter out single chars
  } else {
    // String input: tokenize properly
    terms = _tokens(String(searchTerms || ""));
  }
  
  // CRITICAL: Remove duplicates and limit to reasonable size
  terms = Array.from(new Set(terms)).slice(0, 8);

  // very light synonyms to help intent like salty/savory
  const syns = new Set(terms);
  if (syns.has("savory") || syns.has("salty")) { 
    syns.add("salty"); 
    syns.add("savory"); 
  }

  const snap = await getDocs(query(collection(db, "products"), limit(200)));
  
  const candidates = [];
  snap.forEach(doc => {
    const v = doc.data() || {};
    const name = _firstNonEmpty(v.productName, v.name, doc.id) || "";
    const cat  = String(v.category || "");
    const desc = String(v.description || "");
    const priceNow = Number(_firstNonEmpty(v.discountedPrice, v.price, 0)) || 0;

    const item = {
      id: doc.id,
      name,
      category: cat,
      description: desc,
      price: priceNow,
      originalPrice: v.isDiscountEnabled ? Number(v.price || 0) : null,
      isDiscountEnabled: !!v.isDiscountEnabled || v.discountedPrice != null,
      isNewArrival: !!v.isNewArrival,
      stock: Number(v.stock || 0),
      imageUrl: v.imageUrl || ""
    };

    // hard filters first
    if (onSale && !item.isDiscountEnabled) return;
    if (newArrivals && !item.isNewArrival) return;

    // ✅ ENHANCED: Exact category match for image search
    if (category) {
      const itemCat = _norm(cat);
      const filterCat = _norm(category);
      
      // Exact match required (no partial matches)
      if (itemCat !== filterCat) return;
    }

    if (budget != null && item.price > Number(budget)) return;

    // score relevance (or keep if no terms given)
    const score =
      (terms.length ? _scoreProduct(item, Array.from(syns)) : 1) +
      (followupProductHint && _norm(name).includes(_norm(followupProductHint)) ? 5 : 0);

    if (terms.length === 0 || score > 0) candidates.push({ score, item });
  });

  // rank by score, then stock, then price
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (b.item.stock > 0) - (a.item.stock > 0) ||
      a.item.price - b.item.price
  );

  return candidates.slice(0, 6).map(x => x.item);
}


// Lightweight INFO composer: numbered, short, safe
function composeInfoReply(product) {
  if (!product) {
    return {
      reply: "1) Allergens: Unknown\n2) Ingredients: Unknown\n3) Nutrition: Unknown\n4) Notes: Unknown"
    };
  }

  const nm = String(product.productName || "").toLowerCase();
  const desc = String(product.description || "").toLowerCase();

  // heuristic hints (never overclaim)
  let allergens = "Unknown";
  // latte very likely involves milk
  if (/\blatte\b/.test(nm) || /\bmilk\b/.test(desc)) allergens = "Milk (likely) – please confirm on label.";
  // explicit indicators in name/desc
  if (/\balmond\b/.test(nm + " " + desc)) allergens = "Tree nuts (almond) – please confirm on label.";
  if (/\bpeanut\b/.test(nm + " " + desc)) allergens = "Peanuts – please confirm on label.";
  if (/\bsoy\b/.test(nm + " " + desc)) allergens = "Soy (likely lecithin) – confirm on label.";
  if (/\bgluten\b/.test(desc)) allergens = "Gluten – confirm on label.";

  return {
    reply: [
      `1) Allergens: ${allergens}`,
      `2) Ingredients: Unknown`,
      `3) Nutrition: Unknown`,
      `4) Notes: ${product.category ? `Category: ${product.category}` : "—"}`
    ].join("\n")
  };
}


// Extract search parameters from user message
function parseSearchQuery(message) {
  const STOP = new Set([
    "do","you","have","is","are","the","a","an","of","for","on","in","to","please","pls",
    "got","any","some","your","my","me","show","find","want","need","with","and","or"
  ]);
  const text = String(message || "").toLowerCase().replace(/[^\w\s]/g, " ");
  let terms = text.split(/\s+/).filter(t => t && !STOP.has(t));

  // light synonyms → improve fuzzy hit rate
  const syn = new Set(terms);
  if (syn.has("savory")) syn.add("salty");
  if (syn.has("latte")) syn.add("milk"); // bumps milk checks
  terms = Array.from(syn);

  const searchTerms = terms.filter(t => t.length > 1).slice(0, 6);

  const onSale = /\b(sale|discount|promo|on sale)\b/.test(text);
  const newArrivals = /\b(new|new arrival|latest|recent)\b/.test(text);
  const budget = parseBudget(text);
  const category = parseCategory(text);
  return { searchTerms, budget, category, onSale, newArrivals };
}


function parseBudget(text) {
  const matches = [
    text.match(/under\s+(\d+)/i),
    text.match(/below\s+(\d+)/i),
    text.match(/less\s+than\s+(\d+)/i),
    text.match(/(\d+)\s+pesos?\s+or\s+less/i)
  ].find(match => match)
  
  return matches ? Number(matches[1]) : null
}

function parseCategory(text) {
  const categories = {
    "juice": "Juice & Beverage",
    "beverage": "Juice & Beverage",
    "drink": "Juice & Beverage",
    "kitchen": "Kitchen Ingredients", 
    "ingredient": "Kitchen Ingredients",
    "cooking": "Kitchen Ingredients",
    "snack": "Snacks",
    "chips": "Snacks",
    "candy": "Snacks",
    "personal": "Personal Care",
    "hygiene": "Personal Care",
    "care": "Personal Care"
  }
  
  for (const [keyword, category] of Object.entries(categories)) {
    if (text.includes(keyword)) {
      return category
    }
  }
  
  return null
}

// Helper functions
const withTimeout = (promise, timeoutMs) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// [LEARN] retrieve last conversation turn for continuity
async function getLastConversationTurn(userId) {
  if (!userId) return null;
  try {
    const db = getFirestore();
    const q = query(
      collection(db, "chat_logs"),
      where("userId", "==", userId),
      orderBy("ts", "desc"),
      limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    
    const last = snap.docs[0].data();
    return {
      userMessage: last.message || "",
      intent: last.intent || "CHAT",
      products: Array.isArray(last.products) ? last.products : [],
      timestamp: last.ts
    };
  } catch (err) {
    console.warn("[chatApi] getLastConversationTurn failed (non-fatal):", err?.message);
    return null;
  }
}

// [LEARN] — persist a tiny interaction log so we can learn over time.
// [LEARN][TTL] write tiny log with a 30-day expiry and sample pruning
async function rememberInteraction({ userId, message, intent, reply, products, filters }) {
  if (!userId) return;
  try {
    const db = getFirestore();

    // auto-delete after 30 days via Firestore TTL policy
    const expireAt = Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const ref = await addDoc(collection(db, "chat_logs"), {
      userId,
      message: String(message || "").slice(0, 500),
      intent: String(intent || "CHAT"),
      products: Array.isArray(products)
        ? products.slice(0, 6).map(p => ({
            id: p.id, name: p.name, category: p.category,
            price: Number(p.discountedPrice ?? p.price ?? 0) || 0
          }))
        : [],
      filters: filters || null,
      replyPreview: String(reply || "").slice(0, 280),
      ts: serverTimestamp(),
      expireAt                       // <-- TTL field
    });

    // keep at most the latest 50 logs per user, prune occasionally
    const MAX_PER_USER = 50;
    if (Math.random() < 0.15) {      // prune ~15% of writes
      const first = await getDocs(query(
        collection(db, "chat_logs"),
        where("userId", "==", userId),
        orderBy("ts", "desc"),
        limit(MAX_PER_USER)
      ));
      const cutoff = first.docs[first.docs.length - 1];
      if (cutoff) {
        const stale = await getDocs(query(
          collection(db, "chat_logs"),
          where("userId", "==", userId),
          orderBy("ts", "desc"),
          startAfter(cutoff),
          limit(50)
        ));
        if (!stale.empty) {
          const batch = writeBatch(db);
          stale.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }
    }
  } catch (err) {
    console.warn("[chatApi] rememberInteraction failed (non-fatal):", err?.message);
  }
}


// [LEARN] optional explicit feedback logging
export async function logFeedback({ userId, intent, positive }) {
  if (!userId) return;
  try {
    const db = getFirestore();
    await addDoc(collection(db, "chat_logs"), {
      userId,
      type: "feedback",
      intent: String(intent || "CHAT"),
      positive: !!positive,
      ts: serverTimestamp()
    });
  } catch (err) {
    console.warn("[chatApi] logFeedback failed (non-fatal):", err?.message);
  }
}


// [LEARN] — read last N logs and derive soft “signals” (fav categories, typical budget)
async function deriveUserSignals(userId) {
  if (!userId) return null;
  try {
    const db = getFirestore();
    const q = query(
      collection(db, "chat_logs"),
      where("userId", "==", userId),
      orderBy("ts", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);

    const catCounts = Object.create(null);
    let seenBudget = null;

    snap.forEach(doc => {
      const d = doc.data() || {};
      // count categories from previously shown products
      (Array.isArray(d.products) ? d.products : []).forEach(p => {
        const c = (p.category || "").trim();
        if (!c) return;
        catCounts[c] = (catCounts[c] || 0) + 1;
      });
      // pick smallest budget we’ve seen in filters (as a conservative preference)
      const b = d?.filters?.budget;
      if (Number.isFinite(b)) {
        seenBudget = Math.min(seenBudget ?? b, b);
      }
    });

    const favCats = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([c]) => c);

    return { favCats, budget: seenBudget || null };
  } catch (err) {
    console.warn("[chatApi] deriveUserSignals failed (non-fatal):", err?.message);
    return null;
  }
}


// Enhanced chat function with Firestore-only context
export async function sendChat({
  message: originalMessage, 
  userId,
  history,
  followupContext = null,
  followupProductHint = "",
  base64Image = null,
  mimeType = null
}) {
  const endpoints = [CHAT_ENDPOINT];
  let lastError = null;
  
  // --- START MODIFICATION ---
  let messageToSend = originalMessage; // Use this for the final chat call

  // 1. Validate input (text OR image required)
   if ((!messageToSend || typeof messageToSend !== "string" || !messageToSend.trim()) && !base64Image) {
    throw new Error("Please enter a message or upload an image.");
  }

  // 2. If image is present, call imageSearch first
  if (base64Image) {
    console.log("[sendChat] Image detected, calling imageSearch endpoint...");
    
    try {
      const imgController = new AbortController();
      const imgTimeoutId = setTimeout(() => imgController.abort(), API_TIMEOUT);
  
      const imgResponse = await fetch(IMAGE_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          base64Image: base64Image,
          mimeType: mimeType,
          message: originalMessage,
        }),
        signal: imgController.signal,
      });
  
      clearTimeout(imgTimeoutId);
  
      if (!imgResponse.ok) {
        let errorDetail = "Image analysis failed.";
        try {
          const errJson = await imgResponse.json();
          errorDetail = errJson.error || `Image analysis failed (${imgResponse.status}).`;
        } catch {}
        throw new Error(errorDetail);
      }
  
      const imgData = await imgResponse.json();
      
      // === NEW: Check if we got products from imageSearch ===
      if (imgData.products && imgData.products.length > 0) {
        console.log(`[sendChat] ✅ imageSearch returned ${imgData.products.length} products directly!`);
        
        // Build a friendly message based on search strategy
        let introMessage = "";
        if (imgData.searchStrategy === 'exact_match') {
          introMessage = `Uy! Here's what I found, I hope you like itt 🎯`;
        } else if (imgData.searchStrategy === 'category_fallback') {
          introMessage = `I couldn't find that exact product, but here are similar items from our ${imgData.structured?.category || 'selection'}! ✨`;
        } else {
          introMessage = `Here's what I found! 📦`;
        }
        
        // Return IMMEDIATELY with products (skip geminiChat call)
        return {
          intent: "SEARCH",
          reply: introMessage,
          products: imgData.products,
          totalFound: imgData.products.length,
          comparison: false,
          categories: [],
          userPreferences: {},
          suggestions: []
        };
      }
      
      // === Fallback: Use text query if no products ===
      if (imgData.productDescription) {
        const primaryQuery = imgData.structured?.brand && imgData.structured?.variant
          ? `${imgData.structured.brand} ${imgData.structured.variant}`.trim()
          : imgData.productDescription;
        
        messageToSend = primaryQuery;
        console.log(`[sendChat] Using vision query for geminiChat: "${messageToSend}"`);
      } else {
        throw new Error("Image analysis did not return a description.");
      }
  
    } catch (imgError) {
      console.error("[sendChat] imageSearch call failed:", imgError);
      if (!originalMessage || !originalMessage.trim()) {
        throw imgError;
      }
      console.warn("[sendChat] Proceeding with original text message due to image search failure.");
    }
  }
  // --- END MODIFICATION ---

  // Validate input
  if ((!originalMessage || typeof originalMessage !== "string" || !originalMessage.trim()) && !base64Image) { // <-- MODIFIED
    throw new Error("Please enter a message or upload an image.");
  }

  for (const url of endpoints) { // Still using CHAT_ENDPOINT here
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // --- Context building logic using potentially updated messageToSend ---
      const { tokens: searchTerms, category: detectedCategory } = expandQuery(messageToSend); // Use potentially updated message

      const onSale = /\b(sale|promo|discount|deal)s?\b/i.test(messageToSend); // Use messageToSend
      const newArrivals = /\b(new|new\s*arrivals?|latest)\b/i.test(messageToSend); // Use messageToSend

      const budgetMatch =
        messageToSend.match(/\b(?:under|below|less\s*than)\s*₱?\s*(\d+(?:\.\d+)?)/i) || // Use messageToSend
        messageToSend.match(/₱\s*(\d+(?:\.\d+)?)/i); // Use messageToSend

      const parsedBudget = budgetMatch ? Number(budgetMatch[1]) : null;
      const parsedCategory = detectedCategory || null; // From expandQuery based on messageToSend

      // --- [LEARN] pull lightweight user signals + last turn for continuity ---
      let learnSignals = null;
       let lastTurn = null;
       try {
         [learnSignals, lastTurn] = await Promise.all([
           deriveUserSignals(userId),
           getLastConversationTurn(userId)
         ]);
       } catch { /* non-fatal */ }

        // Detect if current message is a direct answer to bot's last question
        const isDirectAnswer = lastTurn &&
          !originalMessage.toLowerCase().match(/\b(show|find|search|track|compare|recommend)\b/) && // <-- FIX HERE
          (Date.now() - (lastTurn.timestamp?.toMillis?.() || 0)) < 120000 // within 2min

        // --- Prefer explicit user query > learned signals (SAFE fallbacks) ---
        // NOTE: removes any reference to a non-existent `filters` and undefined vars.
        const effectiveBudget =
          Number.isFinite(Number(parsedBudget))
            ? Number(parsedBudget)
            : (Number.isFinite(Number(learnSignals?.budget)) ? Number(learnSignals.budget) : null);

        const effectiveCategory =
          parsedCategory ?? (learnSignals?.favCats?.[0] ?? null);

        // --- Build Firestore-only product context once (FIX: single call, safe args) ---
        let clientContext = null; // Initialize clientContext
       const hasSearchHint =
         (Array.isArray(searchTerms) ? searchTerms.length > 0 : Boolean(searchTerms)) ||
         effectiveBudget !== null ||
         Boolean(effectiveCategory) ||
         Boolean(onSale) ||
         Boolean(newArrivals);

       if (hasSearchHint) {
           // This call now correctly uses searchTerms derived from messageToSend
           const products = await buildProductContext(
             searchTerms,
             effectiveBudget,
             effectiveCategory,
             onSale,
             newArrivals,
             followupProductHint // Pass the original hint here if needed for scoring
           );

           if (Array.isArray(products) && products.length) {
            const prefsLine = learnSignals?.favCats?.length
              ? `\nUser preferences: likes ${learnSignals.favCats.join(", ")}${effectiveBudget ? `, prefers ≤ ₱${effectiveBudget}` : ""}.`
              : (effectiveBudget
                  ? `\nUser preferences: prefers ≤ ₱${effectiveBudget}.`
                  : "");

            clientContext =
              products
                .map((p) => {
                  const priceText = p.originalPrice
                    ? `₱${p.price} (was ₱${p.originalPrice})`
                    : `₱${p.price}`;
                  const tags = [
                    p.isDiscountEnabled ? "SALE" : null,
                    p.isNewArrival ? "NEW" : null
                  ]
                    .filter(Boolean)
                    .join("/");
                  const tagStr = tags ? ` - ${tags}` : "";
                  const stockText = p.stock > 0 ? "✅ in stock" : "❌ out";
                  return `• ${p.name} - ${priceText} - ${stockText} - ${p.category}${tagStr}`;
                })
                .join("\n") + prefsLine;
          }
        }

        // --- Use provided follow-up context if product context is empty ---
        if ((!clientContext || clientContext.trim().length === 0) && followupContext) {
          clientContext = String(followupContext);
        }

        

        // --- Request with timeout & retries (unchanged) ---
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

        const response = await fetch(url, { // url is CHAT_ENDPOINT
          method: "POST",
          headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
          },
          body: JSON.stringify({
              message: messageToSend.trim(), // Send the final message (text or from image)
              userId,
              history: Array.isArray(history) ? history.slice(-10) : [],
              clientContext,
              followupContext: followupContext ?? null,
              followupProductHint: followupProductHint ?? null,
              // NO base64Image or mimeType sent to geminiChat anymore
          }),
          signal: controller.signal
      });

        clearTimeout(timeoutId);


        if (!response.ok) {
          let detail = response.statusText || `HTTP ${response.status}`;
          let code = null;
          try {
            const j = await response.json();
            detail = j.error || detail;
            code = j.errorCode || null;   // <-- preserve typed server code
          } catch {}
          const err = new Error(detail);
          err.code = code;
          err.status = response.status;
          // Don't retry on 4xx (except 429)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw err;
          }
          throw err;
        }        

        const data = await response.json();

        // --- [LEARN] persist minimal interaction (unchanged) ---
        try {
          await rememberInteraction({
            userId,
            message: originalMessage, // <--- FIX: Use originalMessage (what the user typed/sent initially)
            intent: data.intent || "CHAT",
            reply: data.reply || "",
            products: Array.isArray(data.products) ? data.products.slice(0, 6) : [],
            filters: {
              budget: effectiveBudget,
              category: effectiveCategory,
              onSale,
              newArrivals
            }
          });
        } catch {
          /* non-fatal */
        }

        // --- Normalized return (unchanged fields) ---
        return {
          intent: data.intent || "CHAT",
          reply: data.reply || "I could not understand that. Please rephrase.",
          products: Array.isArray(data.products) ? data.products.slice(0, 6) : [],
          categories: Array.isArray(data.categories) ? data.categories : [],
          totalFound: data.totalFound || 0,
          comparison: Boolean(data.comparison),
          userPreferences: data.userPreferences || {},
          suggestions: Array.isArray(data.suggestions) ? data.suggestions : []
        };        
      } catch (e) {
        lastError = e;
        if (e.name === "AbortError") {
          lastError = new Error("Request timed out. Please try again.");
          break;
        }
        if (e.message.includes("400") || e.message.includes("401") || e.message.includes("403")) {
          break; // don't retry client errors
        }
        // exponential backoff
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }
  }

  // If we get here, all attempts failed
  // Add this tiny helper near the top of sendChat (or inline here)
  const _isCredsErr = (e) => {
    const m = String(e?.message || "").toLowerCase();
    return (
      m.includes("no_default_credentials") ||
      m.includes("db_init_failed") ||
      m.includes("default credentials")  // server message pass-through
    );
  };
  
  // ... later, right BEFORE your final `throw new Error(...)`:
  if (lastError?.response && typeof lastError.response.json === "function") {
    try {
      const j = await lastError.response.json();
      if (j?.errorCode === "NO_DEFAULT_CREDENTIALS" || j?.errorCode === "DB_INIT_FAILED") {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[dev] Firestore admin credentials missing. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or use your adminApp local config. " +
            "See: https://cloud.google.com/docs/authentication/getting-started"
          );
        }
        throw new Error("I’m having trouble reaching our database right now. Please try again shortly.");
      }
    } catch (_) {
      // ignore JSON parse issues; fall through to the generic mapper below
    }
  }
  
  
  // REPLACE your existing "throw new Error(...)" block with this:
  throw new Error(
    lastError?.code === "NO_DEFAULT_CREDENTIALS" || lastError?.code === "DB_INIT_FAILED" ||
    String(lastError?.message || "").toLowerCase().includes("default credentials")
      ? "I’m having trouble reaching our database right now. Please try again shortly."
      : /_norm\s+is\s+not\s+defined|referenceerror:/i.test(String(lastError?.message || ""))
        ? "A quick update is in progress on our side. Please try again in a moment."
        : lastError?.message?.toLowerCase?.().includes("timeout")
          ? "Request timed out. Please try again."
          : lastError?.message?.includes?.("404")
            ? "Service unavailable. Please try again shortly."
            : (lastError?.message || "Something went wrong. Please try again.")
  );

}


// Enhanced order tracking with better error handling
export async function trackOrder({ orderId, idToken }) {
  const endpoints = ["/api/Chat/trackOrder"]
  let lastError = null

  if (!orderId && !idToken) {
    throw new Error("Provide an Order ID or sign in.")
  }

  for (const url of endpoints) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT)

        const headers = { "Content-Type": "application/json", "Accept": "application/json" }
        if (idToken) headers.Authorization = `Bearer ${idToken}`

        const r = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ orderId: orderId || null }),
          signal: controller.signal
        })

        clearTimeout(timeoutId)

        if (!r.ok) {
          let detail = `HTTP ${r.status}`
          try { const j = await r.json(); detail = j.error || detail } catch {}
          if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(detail)
          throw new Error(detail)
        }

        const data = await r.json()
        return {
          found: !!data.found,
          message: data.message || (data.found ? "Order found" : "Order not found"),
          orderID: data.orderID || null,
          status: data.status || null,
          placedAt: data.placedAt || null,
          trackingNumber: data.trackingNumber || null,
          totalAmount: data.totalAmount || null,
          totalItems: data.totalItems || null,
          items: Array.isArray(data.items) ? data.items : []
        }
      } catch (e) {
        lastError = e
        console.error("Track order client error", e)
        if (e.name === "AbortError") { lastError = new Error("Request timed out. Please try again."); break }
        if (e.message.includes("401") || e.message.includes("403") || e.message.includes("404")) break
        if (attempt < MAX_RETRIES) await delay(Math.pow(2, attempt) * 1000)
      }
    }
  }

  throw new Error(lastError?.message || "Order tracking error")
}

// New function: Get product recommendations
export async function getRecommendations({ category, budget, userId }) {
  try {
    const { searchTerms } = parseSearchQuery(category || "")
    const products = await buildProductContext(searchTerms, budget, category)
    
    return {
      success: true,
      products: products.slice(0, 8),
      totalFound: products.length
    }
  } catch (error) {
    console.error("Recommendations error:", error)
    return {
      success: false,
      products: [],
      totalFound: 0,
      error: "Unable to get recommendations at this time"
    }
  }
}

// New function: Check product availability
export async function checkAvailability({ productName, productId }) {
  const db = getFirestore()
  
  try {
    let productQuery
    
    if (productId) {
      // Direct ID lookup would require doc() method
      productQuery = query(collection(db, "products"), where(documentId(), "==", productId))
    } else {
      // Search by name
      productQuery = query(collection(db, "products"), limit(10))
    }
    
    const snapshot = await getDocs(productQuery)
    const products = []
    
    snapshot.forEach(doc => {
      const data = doc.data()
      const name = data.productName || data.name || ""
      
      if (!productName || name.toLowerCase().includes(productName.toLowerCase())) {
        products.push({
          id: doc.id,
          name: name,
          stock: Number(data.stock || 0),
          price: Number(data.discountedPrice || data.price || 0),
          available: Number(data.stock || 0) > 0
        })
      }
    })
    
    return {
      success: true,
      products: products,
      totalFound: products.length
    }
    
  } catch (error) {
    console.error("Availability check error:", error)
    return {
      success: false,
      products: [],
      totalFound: 0,
      error: "Unable to check availability at this time"
    }
  }
}

// Helper function to check API health
export async function checkApiHealth() {
  try {
    const response = await withTimeout(
      fetch('/api/health', { 
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      }),
      5000
    );
    
    if (response.ok) {
      const data = await response.json();
      return data.status === 'ok';
    }
    return false;
  } catch (error) {
    console.error('Health check failed:', error);
    return false;
  }
}