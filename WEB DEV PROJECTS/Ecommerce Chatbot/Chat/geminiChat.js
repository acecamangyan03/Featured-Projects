  /* src/pages/api/Chat/geminiChat.js */
  import { GoogleGenerativeAI } from "@google/generative-ai";
  import { normalizeText, tokenizeQuery } from "./chatLib/normalize";
  import { expandQuery } from "./chatLib/expand";

  export const config = {
    api: { bodyParser: { sizeLimit: "10mb" } }
  };

  // Global request budget (keep well under your client fetch timeout)
  const REQUEST_DEADLINE_MS = Number(process.env.CHAT_DEADLINE_MS || 12000);

  // Vision compare caps
  const VISION_CANDIDATE_CAP = 60;   // max products to visually compare
  const VISION_BATCH_SIZE     = 5;    // smaller batches = faster first result
  const VISION_MIN_SCORE      = 0.65; // be pickier so we stop early


  // === Model routing (CHAT vs SEARCH vs INFO) ===
  const MODEL_CHAT   = process.env.GEMINI_MODEL_CHAT   || "gemini-2.5-flash";
  const MODEL_SEARCH = process.env.GEMINI_MODEL_SEARCH || "gemini-2.5-pro";
  const MODEL_INFO   = process.env.GEMINI_MODEL_INFO   || "gemini-2.5-pro";

  const MODEL_VISION = process.env.GEMINI_MODEL_VISION || "gemini-2.5-flash"


    // Base client (required)
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    // Optional separate Pro key (for -pro models)
    const genAIPro = process.env.GOOGLE_API_KEY_PRO
      ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY_PRO)
      : genAI;

  // Helper: choose key/project by model tier
  function getGenAIForModel(modelName = "") {
    const m = String(modelName || "").toLowerCase();
    const isPro = m.includes("-pro");
    return (isPro && process.env.GOOGLE_API_KEY_PRO) ? genAIPro : genAI;
  }

  function makeDeadline(ms) {
    const start = Date.now();
    return {
      left() { return Math.max(0, ms - (Date.now() - start)); },
      expired() { return (Date.now() - start) >= ms; }
    };
  }

  // --- network helpers ---
  async function fetchWithTimeout(url, { timeoutMs = 5000, ...opts } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  

  async function fetchImageAsBase64(url) {
    const r = await fetchWithTimeout(url, { timeoutMs: 5000 }); // fast fail
    if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type")
      || (url.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    return { b64: buf.toString("base64"), mime: ct };
  }
  
  
  // Batch an array into chunks of size n
  function chunk(arr, n=8) {
    const out = [];
    for (let i=0; i<arr.length; i+=n) out.push(arr.slice(i, i+n));
    return out;
  }

  // Compare one query image against a batch of candidate images.
  // Returns [{ id, score, reason }], score in [0..1], higher = more similar.
  async function geminiImageCompareBatch({
    queryBase64,
    queryMime = "image/jpeg",
    candidates = [], // [{id, name, imageUrl}]
    model = MODEL_VISION
  }) {
    if (!candidates.length) return [];

    // Schema for strict JSON back
    const responseSchema = {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              score: { type: "number" },  // 0..1
              reason: { type: "string" }
            },
            required: ["id","score"]
          }
        }
      },
      required: ["matches"]
    };

    // Build model client
    const client = getGenAIForModel(model).getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema
      },
      systemInstruction: {
        parts: [{
          text: [
            "You compare retail packshots. Score visual similarity 0..1:",
            "1. Exact same product/variant/pack -> 0.85–1.00",
            "2. Same brand + same line but different variant -> 0.60–0.84",
            "3. Different brand or clearly different product -> 0.00–0.59",
            "Use packaging cues: logo, colors, flavor text (e.g., matcha), shape, size, language.",
            "Prefer exact matches; penalize wrong flavor or pack-size even with similar colors.",
            "Return JSON only."
          ].join(" ")
        }]
      }
    });

    // Build content (one query image + all candidate images with their ids)
    const parts = [
      { text: "Query image (what the customer sent):" },
      { inlineData: { data: queryBase64, mimeType: queryMime } },
      { text: "Candidates to score (return a match object for each id):" }
    ];

    // We must inline candidate images
    const resolved = [];
    for (const c of candidates) {
      if (!c.imageUrl) continue;
      try {
        const { b64, mime } = await fetchImageAsBase64(c.imageUrl);
        parts.push({ text: `id=${c.id} | name=${c.name || ""}` });
        parts.push({ inlineData: { data: b64, mimeType: mime } });
        resolved.push(c);
      } catch {
        /* skip broken image */
      }
    }

    if (resolved.length === 0) return [];

    // Call Gemini once for this batch
    const { response } = await client.generateContent({ contents: [{ role: "user", parts }] });
    const txt = response.text() || "";
    const parsed = tryParseJson(txt);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];

    // Attach back any missing info and clamp scores
    return matches
      .map(m => ({
        id: String(m.id),
        score: Math.max(0, Math.min(1, Number(m.score || 0))),
        reason: String(m.reason || "")
      }))
      .filter(m => resolved.some(c => String(c.id) === m.id));
  }

  // Convenience: score many candidates by batching (to keep tokens down)
  async function geminiImageCompareMany({ queryBase64, queryMime, candidates, perBatch = 6 }) {
    const out = [];
    for (const group of chunk(candidates, perBatch)) {
      const r = await geminiImageCompareBatch({ queryBase64, queryMime, candidates: group });
      out.push(...r);
    }
    return out;
  }


  async function normalizeIncomingImage({ base64Image, dataUrl, imageUrl, mimeType }) {
    // 1) data URL (preferred from web UIs)
    const data = dataUrl || base64Image;
    if (data && /^data:/i.test(String(data))) {
      const m = String(data).match(/^data:([^;]+);base64,(.+)$/i);
      if (!m) throw new Error("Invalid data URL");
      return { base64: m[2], mime: m[1] };
    }
  
    // 2) raw base64 (no prefix)
    if (base64Image) {
      const stripped = String(base64Image).replace(/^data:[^;]+;base64,/, "");
      return { base64: stripped, mime: mimeType || "image/jpeg" };
    }
  
    // 3) remote URL (fetch & convert)
    if (imageUrl) {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const mt = r.headers.get("content-type") || mimeType || "image/jpeg";
      return { base64: buf.toString("base64"), mime: mt };
    }
  
    return null;
  }
  

  async function pickAvailableVisionModel() {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?key=" + process.env.GOOGLE_API_KEY
    );
    const { models = [] } = await res.json();
    const names = models.map(m => m.name);
    return names.find(n => /gemini-2\.(5|0)-flash$/.test(n)) || "gemini-2.5-flash";
  }
  


  let _adminApp = null;

  // === GLOBAL: strict product facts schema (used across safeDescribeProductsJSON, groundedFactsJSON, INFO) ===
  const FACTS_RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      resolvedProduct: {
        type: "object",
        properties: {
          name: { type: "string" },
          brand: { type: "string" },
          size: { type: "string" },
          note: { type: "string" }
        }
      },
      ingredients: { type: "array", items: { type: "string" } },
      allergens: { type: "array", items: { type: "string" } },
      nutrition: {
        type: "object",
        properties: {
          servingBasis: { type: "string" },
          energyKcal: { type: "number" },
          proteinG: { type: "number" },
          fatG: { type: "number" },
          carbsG: { type: "number" },
          sugarG: { type: "number" },
          sodiumMg: { type: "number" }
        }
      },
      skincareEffects: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["resolvedProduct", "ingredients", "allergens", "nutrition", "skincareEffects", "notes"]
  };


  function isCredentialsError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
      msg.includes("could not load the default credentials") ||
      msg.includes("application default credentials") ||
      msg.includes("invalid_grant")
    );
  }
    // ---------------- Helper: Conversational Comparison ----------------
    // --- Helper: language-aware intro + ID-locked product blurbs (hallucination-safe)
    async function composeIntroAndBlurbs({
      introPrompt,
       products,
       model,
       history,
       isFollowup = false,
       listMode = "auto" // "auto" | "none"
     }) {
      let introText = "";
      if (!isFollowup && introPrompt) {
        try {
          introText = await callGemini("gemini-2.0-flash", SystemRules, history.slice(-4), introPrompt, ""); // No context needed for intro
          introText = normalizeModelReply(introText || "");
        } catch {
          introText = ""; // Fallback to no intro if LLM fails
        }
      }

      // Skip any product iteration entirely if caller requests no list.
      if (listMode === "none") {
        return introText;
      }

      // If no products, just return the intro (or empty string).
      if (!Array.isArray(products) || products.length === 0) {
        return introText;
      }
      // Append blurbs that are strictly allowlisted by product IDs
      let listText = "";
      try {
        const aiForBlurbs = getGenAIForModel(model);
        const { text, ok } = await safeDescribeProductsJSON(aiForBlurbs, { model, products });
        if (ok && text) {
            listText = text; // Use the formatted list+blurbs from safeDescribe
        } else {
            // --- Start Change: Call fallback list builder with NO prefix ---
            listText = buildDeterministicProductList(products, ""); // Pass empty string as prefix
            // --- End Change ---
        }
      } catch {
        // --- Start Change: Call fallback list builder with NO prefix in catch block too ---
        listText = buildDeterministicProductList(products, ""); // Pass empty string as prefix
        // --- End Change ---
      }

      return introText ? `${introText}\n${listText}` : listText;
    }


    // === FOOLPROOF: LLM may only describe known products by ID ===
    async function safeDescribeProductsJSON(genAIClient, {
      
      model = MODEL_CHAT,
      products,                 // array from Firestore search (already filtered)
      locale = "en"
    }) {
      if (!Array.isArray(products) || products.length === 0) return { text: "", ok: true };

      // Build allowlist lookups
      const allowById = new Map();
      for (const p of products) {
        const now = Number(p.discountedPrice ?? p.price ?? 0);
        allowById.set(String(p.id), {
          id: String(p.id),
          name: String(p.name || p.productName || ""),
          category: String(p.category || ""),
          priceText: `₱${now.toFixed(2)}`
        });
      }

      // Short blurb schema used by safeDescribeProductsJSON
      const PRODUCT_BLURB_RESPONSE_SCHEMA = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                blurb: { type: "string" }
              },
              required: ["id", "blurb"]
            }
          }
        },
        required: ["items"]
      };
      const responseSchema = PRODUCT_BLURB_RESPONSE_SCHEMA;

      const m = genAIClient.getGenerativeModel({
        model,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema
        }
      });

      // We send ONLY whitelisted product fields + hard rules
      const input = {
        locale,
        products: products.map(p => ({
          id: String(p.id),
          name: String(p.name || p.productName || ""),
          category: String(p.category || ""),
          price: Number(p.discountedPrice ?? p.price ?? 0)
        }))
      };

      const system = [
        "You generate short, friendly blurbs for products already chosen from our database.",
        "You MUST only reference the provided products by ID. Do not invent or add any new items.",
        "Each blurb: helpful, 12–24 words, no markdown, no asterisks, no emojis, no brand new names.",
        "Do not mention flavors or variants not present in the given name."
      ].join(" ");

      const prompt = [
        "Write one concise shopping blurb per product in the list.",
        "Return JSON only, matching the provided schema.",
        "For each entry, keep it general but useful (value, taste profile, use-case).",
        "Input:",
        JSON.stringify(input)
      ].join("\n");

      const { response } = await m.generateContent({
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${prompt}` }]}]
      });

      // Parse JSON safely
      const raw = response.text() || "";
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (!parsed || !Array.isArray(parsed.items)) return { text: "", ok: false };

      // Validate: same length, all IDs allowed, no extras
      if (parsed.items.length !== products.length) return { text: "", ok: false };
      for (const it of parsed.items) {
        if (!allowById.has(String(it.id))) return { text: "", ok: false };
        // micro Guard: blurb must not contain any capitalized unknown product tokens
        const bl = String(it.blurb || "");
        const capWords = bl.match(/\b[A-Z][A-Za-z0-9’'()\-]{2,}\b/g) || [];
        for (const w of capWords) {
          // allow words appearing in the whitelisted product's name
          const allow = allowById.get(String(it.id));
          if (!allow.name.includes(w)) return { text: "", ok: false };
        }
      }

      // Render final text (order same as incoming to keep alignment with UI)
      const byId = new Map(parsed.items.map(x => [String(x.id), String(x.blurb)]));
      const lines = [];
      for (const p of products) {
        const blurb = byId.get(String(p.id)) || "";
        const price = Number(p.discountedPrice ?? p.price ?? 0);
        const was   = p.discountedPrice ? ` (was ₱${Number(p.price).toFixed(2)})` : "";
        const stock = Number(p.stock || 0) > 0 ? "✅ in stock" : "❌ Out of stock";
        lines.push(
          `• ${p.name} — ₱${price.toFixed(2)}${was} — ${stock} — ${p.category}\n  ${blurb}`
        );
      }
      return { text: lines.join("\n"), ok: true };
    }

    // Friendly two-product comparison (short format)
    async function buildConversationalComparison(left, right, geminiModel = null) {
      // Helper for basic info with highlight
      function info(p, addStock) {
        return [
          `🌟 ${p.name}:`,
          `- ₱${Number(p.discountedPrice ?? p.price).toFixed(2)}`,
          `- ${p.category}`,
          addStock ? '- Most stock!' : ""
        ].filter(Boolean).join('\n');
      }
    
      // Decide on most stock highlight
      const leftMostStock = left.stock > right.stock;
      const rightMostStock = right.stock > left.stock;
    
      // Compose Gemini prompt for dynamic, no-asterisk, two-line output per item
      let geminiTip = "";
      if (geminiModel) {
        const prompt = 
    `Write a shopper-friendly, *multi-use* comparison between these products. 
    For each, produce ONE list item per format below, with no markdown, no asterisks, and no static phrasing:
    
    1. [Product name]: ₱[price], [category]
    - For the [type of shopper, e.g. "savory snack lover" or "adventurous chocolate lover"]: [Unique, dynamic, concise reason this product is a good fit, in natural, conversational English.]
    
    Be sure the descriptions are brief, actionable, and different for every run.
    Example only:
    1. KitKat Choco Matcha: ₱90, Snacks
    - For the green tea fan: A sweet twist on classic KitKat!"
    
    Products:
    ${left.name}: ₱${Number(left.discountedPrice ?? left.price).toFixed(2)}, ${left.category}
    ${right.name}: ₱${Number(right.discountedPrice ?? right.price).toFixed(2)}, ${right.category}`;
    
        geminiTip = await callGemini(
                    geminiModel || "gemini-2.0-flash",
                    SystemRules,
                    [],           // no prior chat needed here
                    prompt,
                    ""            // no DB context
                  );
        if (typeof normalizeModelReply === "function") geminiTip = normalizeModelReply(geminiTip);
      } else {
        // fallback for demo/testing only, always dynamicize this if possible
        geminiTip = [
          `1. ${left.name}: ₱${Number(left.discountedPrice ?? left.price).toFixed(2)}, ${left.category}`,
          `- For the foodie: A classic Japanese variety, perfect for lively snack sessions!`,
          `2. ${right.name}: ₱${Number(right.discountedPrice ?? right.price).toFixed(2)}, ${right.category}`,
          `- For the sweet tooth: A playful, chocolatey treat with a unique twist.`
        ].join('\n');
      }
    
      return [
        "Let's help you pick! ✨",
        info(left, leftMostStock),
        info(right, rightMostStock),
        "",
        "Here's a comparison and tips for each item:",
        geminiTip
      ].join('\n');
    }
    
    



  // PATCH: strict JSON web-facts extractor with Google Search grounding
  async function groundedFactsJSON({ question, model = MODEL_INFO }) {
    const client = getGenAIForModel(model);
    const allow = String(process.env.ALLOW_WEB_GROUNDING ?? "false").toLowerCase() === "true";
    if (!allow) {
      console.log("[groundedFactsJSON] ALLOW_WEB_GROUNDING is false, skipping");
      return { json: null, citations: [] };
    }

    try {
      
      

      // FIXED: Schema with single types only (no arrays like ["string", "null"])
      const responseSchema = FACTS_RESPONSE_SCHEMA;

      // CRITICAL: Correct model configuration
      // Tools + JSON mime is unsupported → don't set responseMimeType/responseSchema here
      const geminiModel = client.getGenerativeModel({
        model,
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2 }
      });


      const prompt = `${question}

      CRITICAL INSTRUCTIONS:
      - Use Google Search tool to find this EXACT product from Japanese retail/manufacturer sites
      - Prioritize: ${process.env.FACT_SOURCES_ALLOWLIST || 'official manufacturer pages'}
      - OUTPUT LANGUAGE: ENGLISH ONLY. Translate/romanize non-English terms (e.g., 砂糖 -> sugar, 全粉乳 -> whole milk powder). Keep brand names in Latin script.
      - Return ONLY JSON matching the schema below
      - If a field is not found, use "" or []
      - DO NOT guess or invent information

      SCHEMA:
      ${JSON.stringify(responseSchema, null, 2)}`


      console.log("[groundedFactsJSON] Sending request with Google Search enabled");
      
      const result = await geminiModel.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });

      const response = result.response;
      const raw = response.text() || "";

      async function formatToSchema(_unused, raw, responseSchema) {
        const formatterClient = getGenAIForModel(MODEL_CHAT);
        const formatter = formatterClient.getGenerativeModel({
          model: MODEL_CHAT,
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema
          }
        });
      
        const fmt = await formatter.generateContent({
          contents: [{
            role: "user",
            parts: [{
              text: [
                "Convert the following into VALID JSON that matches the provided schema.",
                "Language requirement: ENGLISH ONLY. Translate/romanize any non-English text.",
                'If a field is missing, use empty string "" or empty array [].',
                "Only return JSON—no prose.",
                "",
                "Schema:",
                JSON.stringify(responseSchema),
                "",
                "Content:",
                raw
              ].join("\n")            
            }]
          }]
        });
      
        return fmt.response.text() || "";
      }
      

      // Extract grounding metadata
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      let citations = [];
      
      if (groundingMetadata?.groundingChunks) {
        console.log(`[groundedFactsJSON] Found ${groundingMetadata.groundingChunks.length} grounding chunks`);
        
        citations = groundingMetadata.groundingChunks
          .map(ch => {
            const uri = ch.web?.uri || "";
            if (!uri) return null;
            try {
              const u = new URL(uri);
              return { 
                type: "source", 
                uri, 
                domain: u.hostname, 
                title: ch.web?.title || u.hostname 
              };
            } catch { 
              return null; 
            }
          })
          .filter(Boolean);
        
        console.log(`[groundedFactsJSON] Citations:`, citations.map(c => c.domain));
      } else {
        console.warn("[groundedFactsJSON] No grounding metadata - Google Search may not be enabled");
      }

      // Parse JSON response
      const safe = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      let parsed = tryParseJson(safe) ?? null;

      if (!parsed || typeof parsed !== "object") {
        // Try strict formatter pass (no tools, schema-enforced)
        try {
          const formatted = await formatToSchema(genAI, raw, responseSchema);
          parsed = tryParseJson(formatted);
        } catch {}
      }

      if (!parsed || typeof parsed !== "object") {
        console.warn("[groundedFactsJSON] Parse failed after formatter, raw:", safe.slice(0, 300));
        return { json: null, citations };
      }

      // Normalize empty strings to arrays/nulls
      parsed.ingredients = Array.isArray(parsed.ingredients) 
        ? parsed.ingredients.filter(Boolean) 
        : [];
      parsed.allergens = Array.isArray(parsed.allergens) 
        ? parsed.allergens.filter(Boolean) 
        : [];
      parsed.nutrition = parsed.nutrition || {};
      parsed.skincareEffects = Array.isArray(parsed.skincareEffects) 
        ? parsed.skincareEffects.filter(Boolean) 
        : [];
      parsed.notes = Array.isArray(parsed.notes) 
        ? parsed.notes.filter(Boolean) 
        : [];

      // Filter by allowlist
      const allowlist = String(process.env.FACT_SOURCES_ALLOWLIST || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      
      const filteredCites = allowlist.length
        ? citations.filter(c => allowlist.some(dom => (c.domain || "").toLowerCase().includes(dom)))
        : citations;

      console.log(`[groundedFactsJSON] ✅ Success! allergens=${parsed.allergens.length}, ingredients=${parsed.ingredients.length}`);
      if (filteredCites.length) {
        console.log(`[groundedFactsJSON] ✅ ${filteredCites.length} allowlisted sources`);
      }

      return { json: parsed, citations: filteredCites };
    } catch (err) {
      console.error("[groundedFactsJSON] ❌ FAILED:", err?.message || err);
      return { json: null, citations: [] };
    }
  }
  
  async function callGeminiLLM(prompt) {
    return callGemini("gemini-2.0-flash", SystemRules, [], prompt, "");
  }


  async function getAdminDbOrNull() {
    try {
      if (!_adminApp) {
        // path from /api/Chat/geminiChat.js to /api/_lib/adminApp.js
        const mod = await import("../_lib/adminApp");
        _adminApp = mod.adminApp; // may be a function factory
      }
      
      // ✅ CRITICAL: Always call it as a function
      const app = typeof _adminApp === "function" ? _adminApp() : _adminApp;
      
      // ✅ Verify Firestore is accessible
      const db = app.firestore();
      
      // ✅ Quick connectivity test (non-blocking)
      try {
        await db.collection("products").limit(1).get();
      } catch (testErr) {
        console.error("[getAdminDbOrNull] Firestore connection test failed:", testErr.message);
        return { db: null, err: new Error("Database unreachable") };
      }
      
      return { db, err: null };
    } catch (err) {
      console.error("[getAdminDbOrNull] Initialization failed:", err.message);
      return { db: null, err };
    }
  }

  function isOnSaleNow(p) {
    const price = Number(p.price ?? 0);
    const disc  = Number(p.discountedPrice ?? NaN);
    // Real sale requires a finite discounted price that’s lower than base price
    const realDiscount = Number.isFinite(disc) && disc > 0 && disc < price;
    // If you still want to respect the flag, AND it:
    // return realDiscount && Boolean(p.isDiscountEnabled);
    return realDiscount;
  }

  const SYNONYM_MAP = new Map([
    ["matcha","matcha"],
    ["green tea","matcha"],     // treat green tea as matcha in catalog
    ["抹茶","matcha"],          // safety
    ["kit kat","kitkat"]        // normalize spacing
  ]);
  
  function normalizeHint(s="") {
    s = s.toLowerCase().trim();
    for (const [k,v] of SYNONYM_MAP) {
      if (s.includes(k)) s = s.replace(new RegExp(`\\b${k}\\b`, "g"), v);
    }
    return s.replace(/\s+/g," ").trim();
  }
  
  function visionCandidatesToQueries(cands=[]) {
    const qs = [];
    for (const c of cands.slice(0,3)) { // top 3 only
      const brand = normalizeHint(c.brand || "");
      const product = normalizeHint(c.product || "");
      const variant = normalizeHint(c.variant || "");
      const size = (c.size||"").replace(/\s+/g," ").trim();
  
      // Most specific → least specific
      if (brand && product && variant && size) qs.push(`${brand} ${product} ${variant} ${size}`);
      if (brand && product && variant)         qs.push(`${brand} ${product} ${variant}`);
      if (product && variant)                  qs.push(`${product} ${variant}`);
      if (brand && product)                    qs.push(`${brand} ${product}`);
      if (product)                             qs.push(product);
  
      // extra: keywords as a final probe
      if (Array.isArray(c.keywords) && c.keywords.length) {
        qs.push(normalizeHint(c.keywords.join(" ")));
      }
    }
    return Array.from(new Set(qs)).slice(0,8);
  }
  
  


  // --- Fuzzy helpers (add after imports) ---
  function _norm(s = "") {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ") // Keep alphanumeric + spaces
      .replace(/\s+/g, " ")
      .trim();
  }
  
  // ADD this new helper right after _norm:
  function _flexTokens(s = "") {
    const normalized = _norm(s);
    const words = normalized.split(" ").filter(Boolean);
    const tokens = new Set();
    
    // Add full words
    words.forEach(w => {
      if (w.length >= 2) tokens.add(w);
      // Add meaningful prefixes (3+ chars)
      if (w.length >= 4) {
        tokens.add(w.slice(0, 3));
        tokens.add(w.slice(0, 4));
      }
    });
    
    return Array.from(tokens);
  }

  // Tokenizer that ignores very short tokens
  function _tokens(s = "") {
    return _norm(s).split(" ").filter(t => t.length >= 2);
  }

  function _scoreProduct(p, terms) {
    // Score by name + category + description with lenient matching
    const name = _norm(p.productName || p.name || "");
    const cat = _norm(p.category || "");
    const desc = _norm(p.description || "");
    const searchable = `${name} ${cat} ${desc}`;
    
    let score = 0;
    
    for (const t of terms) {
      if (!t || t.length < 2) continue;
      
      // Exact word match in name = highest priority
      if (name.split(" ").includes(t)) {
        score += 10;
        continue;
      }
      
      // Substring match in name = high priority
      if (name.includes(t)) {
        score += 7;
        continue;
      }
      
      // Match in category
      if (cat.includes(t)) {
        score += 3;
        continue;
      }
      
      // Match in description or full searchable text
      if (searchable.includes(t)) {
        score += 2;
        continue;
      }
      
      // Partial prefix match (lenient for typos)
      const prefix = t.slice(0, Math.max(3, Math.ceil(t.length * 0.7)));
      if (prefix.length >= 3 && searchable.includes(prefix)) {
        score += 1;
      }
    }
    
    // Bonus for in-stock items
    if (Number(p.stock || 0) > 0) score += 2;
    if (p.isDiscountEnabled) score += 1;
    if (p.isNewArrival) score += 0.5;
    
    return score;
  }

  function validateNoOutsideProducts(reply, allowedProducts) {
    if (!reply || !allowedProducts || !allowedProducts.size) return true;
    
    const replyLower = String(reply).toLowerCase();
    
    // Look for product-like mentions (capitalized phrases)
    const productPattern = /\b[A-Z][A-Za-z0-9&'()\-\s]{2,}/g;
    let match;
    const suspiciousNames = new Set();
    
    while ((match = productPattern.exec(reply)) !== null) {
      const candidate = match[0].trim();
      const candidateLower = candidate.toLowerCase();
      
      // Skip common non-product words
      const skipWords = new Set(['the', 'available', 'products', 'items', 'category', 
        'stock', 'price', 'sale', 'new', 'arrival', 'beverage', 'snacks', 
        'ingredients', 'allergens', 'nutrition', 'unknown', 'philippines', 'fukushimart',
        'simang', 'chan', 'japanese', 'fukushima', 'peach', 'ramune', 'strawberry',
        'melon', 'grape', 'orange', 'lemon', 'mint', 'vanilla']);
      
      if (skipWords.has(candidateLower)) continue;
      
      // Check if this candidate matches any allowed product
      let found = false;
      for (const allowed of allowedProducts) {
        if (candidateLower.includes(allowed.toLowerCase()) || 
            allowed.toLowerCase().includes(candidateLower)) {
          found = true;
          break;
        }
      }
      
      if (!found && candidate.length > 3) {
        suspiciousNames.add(candidate);
      }
    }
    
    // If we found suspicious product names, validation fails
    return suspiciousNames.size === 0;
  }

  // ENHANCED: Strict product validation with zero tolerance for hallucination
  function strictValidateProductReply(reply, allowedProducts) {
    if (!reply || !allowedProducts || !allowedProducts.size) return true;
    
    const replyLower = String(reply).toLowerCase();
    
    // Build exhaustive forbidden product list (common hallucinations)
    const forbiddenProducts = new Set([
      'peach', 'strawberry', 'melon', 'grape', 'orange', 'lemon', 'mint', 'vanilla',
      'ramune', 'pocky', 'pretz', 'koala march', 'hello panda', 'yan yan',
      'banana', 'mango', 'blueberry', 'raspberry', 'pineapple', 'coconut',
      'green tea', 'sakura', 'yuzu', 'ume', 'wasabi', 'ginger', 'sesame'
    ]);
    
    // Check for forbidden flavor/product mentions
    for (const forbidden of forbiddenProducts) {
      const pattern = new RegExp(`\\b${forbidden}[\\s-]?(flavor|flavored|taste|candy|snack|chip)?\\b`, 'i');
      if (pattern.test(replyLower)) {
        // Check if it's part of an allowed product name
        let isAllowed = false;
        for (const allowed of allowedProducts) {
          if (allowed.toLowerCase().includes(forbidden)) {
            isAllowed = true;
            break;
          }
        }
        if (!isAllowed) {
          console.warn(`[HALLUCINATION DETECTED] Forbidden product mentioned: ${forbidden}`);
          return false;
        }
      }
    }
    
    // Validate capitalized product-like phrases
    const productPattern = /\b[A-Z][A-Za-z0-9&'()\-\s]{3,}/g;
    let match;
    const suspiciousNames = new Set();
    
    while ((match = productPattern.exec(reply)) !== null) {
      const candidate = match[0].trim();
      const candidateLower = candidate.toLowerCase();
      
      // Whitelist of allowed non-product terms
      const safeWords = new Set([
        'the', 'available', 'products', 'items', 'category', 'stock', 'price', 'sale',
        'new', 'arrival', 'beverage', 'snacks', 'ingredients', 'allergens', 'nutrition',
        'unknown', 'philippines', 'fukushimart', 'simang', 'chan', 'japanese', 'japan',
        'fukushima', 'tokyo', 'osaka', 'check', 'product', 'label', 'packaging', 'database',
        'formulations', 'change', 'origin', 'country', 'category', 'care', 'storage'
      ]);
      
      if (safeWords.has(candidateLower)) continue;
      
      // Must match an allowed product
      let found = false;
      for (const allowed of allowedProducts) {
        if (candidateLower.includes(allowed.toLowerCase()) || 
            allowed.toLowerCase().includes(candidateLower)) {
          found = true;
          break;
        }
      }
      
      if (!found && candidate.length > 3) {
        suspiciousNames.add(candidate);
      }
    }
    
    if (suspiciousNames.size > 0) {
      console.warn(`[HALLUCINATION DETECTED] Suspicious names: ${Array.from(suspiciousNames).join(', ')}`);
      return false;
    }
    
    return true;
  }

  /**
   * Builds deterministic product list text (DB-only, no LLM)
   */
  function buildDeterministicProductList(products, prefix = "Available products:") {
    if (!products || !products.length) {
      return "No matching products found. Try different keywords or browse our categories.";
    }
    
    const lines = [prefix];
    products.slice(0, 6).forEach(p => {
      const price = p.discountedPrice ?? p.price;
      const wasPrice = (Number(p.discountedPrice) > 0 && Number(p.discountedPrice) < Number(p.price))
        ? ` (was ₱${Number(p.price).toFixed(2)})`
        : "";
      const stock = p.stock > 0 ? `✅ ${p.stock} in stock` : "❌ Out of stock";
      lines.push(`• ${p.name} – ₱${Number(price).toFixed(2)}${wasPrice} – ${stock} – ${p.category}`);
    });
    
    return lines.join("\n");
  }

  function hasNonLatin(str="") {
    return /[^\u0000-\u007F]/.test(String(str));
  }

  async function ensureEnglishFacts(genAI, json, responseSchema) {
    const needs = [
      ...(json.ingredients||[]),
      ...(json.allergens||[]),
      ...(json.notes||[]),
      json?.resolvedProduct?.name||"",
      json?.resolvedProduct?.brand||"",
      json?.nutrition?.servingBasis||""
    ].some(hasNonLatin);
    if (!needs) return json;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema
      }
    });

    const { response } = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{
          text: [
            "Translate all string values in this JSON to NATURAL ENGLISH while preserving the structure exactly.",
            "Do NOT add or remove fields. Standardize common food names (e.g., 砂糖->sugar, 全粉乳->whole milk powder).",
            "Keep units and numbers. Keep brand names in Latin script.",
            "",
            "JSON to translate:",
            JSON.stringify(json)
          ].join("\n")
        }]
      }]
    });

    const txt = response.text() || "";
    return tryParseJson(txt) || json; // fall back if anything odd
  }


  /**
   * Compose INFO reply from DB fields only
   */
  function composeInfoFromDB(product) {
    if (!product) {
      return "1) Allergens: Unknown\n2) Ingredients: Unknown\n3) Nutrition: Unknown\n4) Notes: Product not found\nNote: Always check the product label.";
    }
    
    // Read from DB fields (these may not exist yet)
    const allergens = product.allergens ? String(product.allergens) : "Unknown";
    const ingredients = product.ingredients ? String(product.ingredients) : "Unknown";
    const nutrition = product.nutrition ? String(product.nutrition) : "Unknown";
    const notes = product.category ? `Category: ${product.category}` : "—";
    
    return [
      `1) Allergens: ${allergens}`,
      `2) Ingredients: ${ingredients}`,
      `3) Nutrition: ${nutrition}`,
      `4) Notes: ${notes}`,
      "Note: Always check the product label; formulations can change."
    ].join("\n");
  }




  /* === Recommendations helpers, tuned for your Firestore === */

  function parseOrderItems(orderDoc) {
    const items = []
    const lines = Array.isArray(orderDoc?.customerOrder) ? orderDoc.customerOrder : []
    for (const it of lines) {
      const qty = Number(it?.quantity ?? 1)
      const price = Number(it?.price ?? it?.originalPrice ?? 0)
      const id = String(it?.id || "").trim()
      const name = String(it?.name || "").trim()
      const category = String(it?.category || "").trim()
      const imageUrl = String(it?.imageUrl || "").trim()
      if (!name) continue
      items.push({ id, name, category, imageUrl, price, qty })
    }
    return items
  }

  function scoreOrder(orderDoc) {
    const status = String(orderDoc?.orderStatus || "").toLowerCase()

    // Robustly get a JS ms timestamp from Firestore Timestamp OR string
    const ts = orderDoc?.orderDate
    let ms = null
    if (ts?.toDate) {
      ms = ts.toDate().getTime()
    } else if (typeof ts?.seconds === "number") {
      ms = ts.seconds * 1000
    } else if (typeof ts?._seconds === "number") {
      ms = ts._seconds * 1000
    } else {
      ms = Date.parse(ts || "")
    }

    const now = Date.now()
    const ageDays = Number.isFinite(ms) ? Math.max(1, (now - ms) / 86400000) : 90

    const recencyW = 1 / Math.min(60, ageDays)  // newer orders weigh more
    const statusW = status.includes("complete")
      ? 1.5
      : status.includes("to pay")
      ? 0.7
      : 1

    return recencyW * statusW
  }


  function tallyFromOrders(orders) {
    const catScores = new Map()
    const prodScores = new Map()
    const paidPrices = []

    for (const o of orders) {
      const base = scoreOrder(o)
      const items = parseOrderItems(o)
      for (const it of items) {
        if (it.price) paidPrices.push(it.price)
        const cKey = it.category.toLowerCase()
        if (cKey) catScores.set(cKey, (catScores.get(cKey) || 0) + base * (it.qty || 1))
        const pKey = it.id || `${it.name}|${it.category}`
        prodScores.set(pKey, (prodScores.get(pKey) || 0) + base * (1 + (it.qty || 1) * 0.1))
      }
    }

    paidPrices.sort((a, b) => a - b)
    const mid = paidPrices.length ? paidPrices[Math.floor(paidPrices.length / 2)] : null

    return {
      topCategories: [...catScores.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      productHints: prodScores,            // not used for direct fetch, only weighting
      medianPaid: mid
    }
  }

  async function getRecentOrders(db, { userId, limit = 80 }) {
    try {
      if (userId) {
        const snap = await db.collection("orders")
          .where("userId", "==", userId)
          .orderBy("orderDate", "desc")
          .limit(Math.min(limit, 80))
          .get()
        if (!snap.empty) return snap.docs.map(d => d.data())
        // some older docs stored uid instead of userId
        const alt = await db.collection("orders")
          .where("uid", "==", userId)
          .orderBy("orderDate", "desc")
          .limit(Math.min(limit, 80))
          .get()
        return alt.docs.map(d => d.data())
      }
      const recent = await db.collection("orders")
        .orderBy("orderDate", "desc")
        .limit(Math.min(limit, 120))
        .get()
      return recent.docs.map(d => d.data())
    } catch (e) {
      console.error("getRecentOrders failed", e)
      return []
    }
  }

  function withinBudget(p, budget) {
    if (!budget) return true
    const priceNow = Number(p.discountedPrice ?? p.price ?? 0)
    if (!isFinite(budget)) return true
    return priceNow <= budget * 1.25            // allow a little headroom
  }

  async function fetchProductsForCategories(db, cats, { budget, boostSaleNew = true, limit = 24 }) {
    const results = []
    for (const cat of cats.slice(0, 5)) {
      const snap = await db.collection("products").where("category", "==", cat).limit(50).get()
      snap.forEach(doc => {
        const d = doc.data() || {}
        const priceNow = Number(d.discountedPrice ?? d.price ?? 0)
        results.push({
          id: doc.id,
          name: d.productName || d.name || doc.id,
          price: Number(d.price ?? 0),
          discountedPrice: d.discountedPrice ? Number(d.discountedPrice) : null,
          category: d.category || "",
          stock: Number(d.stock ?? 0),
          imageUrl: d.imageUrl || "",
          isNewArrival: Boolean(d.isNewArrival),
          isDiscountEnabled: Boolean(d.isDiscountEnabled),
          _score: 0,
          _priceNow: priceNow
        })
      })
    }

    // weight by sale/new, in-stock, and lower price
    for (const p of results) {
      let s = 0
      if (p.stock > 0) s += 1
      if (boostSaleNew && p.isDiscountEnabled) s += 1
      if (boostSaleNew && p.isNewArrival) s += 0.5
      s += 0.5 / Math.max(1, p._priceNow / 100) // cheaper gets a tiny bump
      p._score = s
    }

    // budget filter first
    const filtered = results.filter(p => withinBudget(p, budget))

    // sort by score desc, then price asc
    filtered.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score
      return a._priceNow - b._priceNow
    })

    // dedupe by id
    const seen = new Set()
    const out = []
    for (const p of filtered) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push(p)
      if (out.length >= limit) break
    }
    return out
  }

  async function getRecommendations(db, { userId, msgFilters, limit = 12 }) {
    const orders = await getRecentOrders(db, { userId, limit: 120 })
    const signals = tallyFromOrders(orders)

    // category seeds: message category first, then user/store top, then safe defaults
    const seeds = []
    const mfCat = String(msgFilters?.category || "").toLowerCase()
    if (mfCat) seeds.push(mfCat)
    for (const c of signals.topCategories) if (!seeds.includes(c)) seeds.push(c)
    for (const c of ["snacks", "juice & beverage", "coffee", "tea", "beauty & cosmetics"]) {
      if (!seeds.includes(c)) seeds.push(c)
    }

    // budget: from message if present, else from median paid
    const budget = Number(msgFilters?.maxPrice || signals.medianPaid || 0) || null

    const picks = await fetchProductsForCategories(
      db,
      seeds,
      { budget, limit, queryTokens: Array.isArray(msgFilters?.qTokens) ? msgFilters.qTokens : [] }
    )

    return picks
  }

  async function lookupProductInCatalog(db, q) {
    const hits = await searchProducts(db, q, {});
    return hits[0] || null;
  }
  /* === End recommendations helpers === */
  


  const SystemRules = [
    "You are Simang-Chan (シマンちゃん), a cheerful and bubbly e-commerce chatbot for Fukushimart, a Japanese store in the Philippines.",
    "Personality: Warm, helpful, and concise. Like a knowledgeable friend who respects your time.",
    "Tone: ALWAYS start in friendly English. ONLY switch to Taglish/Filipino mix if the user explicitly uses Filipino words first (po, naman, sige, grabe, etc.). Never assume the user wants Taglish unless they initiate it.",
    "Purpose: Assist with product info, recommendations, order tracking, and FAQs. Direct complex issues to human support.",
    "Emojis: Use them purposefully—1-2 per response max. 🎌 Japanese items, 🍜 food, 💄 beauty, ✨ recommendations.",

    "FORMATTING RULES:",
    "- NEVER use markdown symbols: NO ***, __, **, *, or other decorative symbols",
    "- Use emoji headings instead: 🎌 Product, ⚠️ Allergens, 📋 Ingredients, etc.",
    "- Keep paragraphs clean and readable",
    "- Use line breaks for clarity, not symbols",

    "CONVERSATIONAL FLOW:",
    "- Remember context from previous messages.",
    "- When user gives short answers after your questions, treat them as direct responses.",
    "- Keep responses concise—answer what's asked, nothing more.",
    "- DO NOT recommend products unless user explicitly asks for recommendations.",
    "- DO NOT offer products in FAQ responses unless the FAQ itself mentions them.",

    "DATA SOURCES & FLOW (IMPORTANT):",
    "- For product names, prices, availability, categories, and suggestions: USE ONLY the items provided in the CONTEXT block (DB-sourced). Never invent products, flavors, sizes, or prices.",
    "- Do NOT browse the web yourself. Web-grounded facts (ingredients, allergens, nutrition, certifications, shelf-life) are fetched by the server and will be provided to you as structured content.",
    "- If CONTEXT is empty, reply warmly without naming products; ask a short clarifying question instead.",
    "- For follow-ups like “that”, “this”, “matcha”, “what’s available?” rely on prior CONTEXT you receive; never introduce items that were not provided.",

    "CRITICAL RULES:",
    "- NEVER invent products, prices, flavors, or details. Use only provided data.",
    "- NEVER mention products not in the provided list. If unsure, say 'let me check what we have'.",
    "- NEVER promise notifications, restocks, or follow-ups. We don't have those features.",
    "- Avoid technical jargon like 'database', 'API', 'backend'; use user-friendly terms like 'my records', 'our system', 'inventory', 'catalog'.",
    "- For product info: Answer ONLY what user specifically asked (allergens? just allergens. ingredients? just ingredients.).",
    "- Always add disclaimer: 'Always check the product label'.",
    "- Stay brief: 2-3 sentences max unless showing product lists.",
    "- Products from Japan unless database says otherwise.",
    "- Prices in pesos: ₱199 format.",
    "- Be honest about limitations: 'Not in our database' > guessing.",
    "- When answering FAQs, stick to the answer WITHOUT adding product suggestions."
  ].join(' ');


  const FAQ_DECK = {
    // === SHIPPING & DELIVERY (do NOT use "ingredient" or "allergen" terms) ===
    "shipping|delivery|ship": `📦 We deliver via Lalamove in the Philippines! Most orders arrive ~2-3 days after payment. Fees depend on your location!`,
    
    "shipping address|change address": `🏠 If it hasn't shipped yet, message Support and we'll try to update it! Already on the way? You'll need to place a new order with the correct address.`,
    
    "international|ship abroad|overseas": `🌏 We ship nationwide in the Philippines only for now!`,
    
    "pickup|store location|visit": `🗺️ Visit us at 1288 San Andres Bukid, Malate, Manila! Want directions?`,
    
    // === ORDERS & ACCOUNT ===
    "cancel order|change order": `⏱️ We'll try before it ships! Guest: Use Track Order → Cancel/Change. Logged-in: Profile → Orders. (Already packed/shipped? Options are limited.)`,
    
    "guest checkout|need account": `🎯 An account is optional but saves your info for faster checkout next time!`,
    
    "invoice|receipt|vat": `📧 We email your receipt after purchase! You can also screenshot from Profile → Orders as proof.`,
    
    "combine orders|split shipment": `📦 Sorry, we can't combine orders or split shipments. Each ships separately!`,
    
    // === PAYMENT & PRICING ===
    "payment methods|how pay|pay how": `💳 Cards, e-wallets (GCash, GrabPay, Maya), and online banking (BPI)!`,
    
    "cod|cash delivery": `💰 COD isn't available, but you can use cards, e-wallets, or online banking at checkout!`,
    
    "payment secure|safe pay|secure pay": `🔐 Yes! PayMongo handles payments with PCI-DSS Level 1 security and encryption. Your info is safe!`,
    
    "price match|price adjust|adjust price|match price": `🏷️ We don't offer price matching or post-purchase adjustments. Check our Facebook for promos!`,
    
    "taxes|tax included": `✅ Yes, taxes are included unless stated otherwise at checkout!`,
    
    "promo code|discount code": `🎁 Follow our Facebook page for the latest promos! I can also suggest bundle deals here.`,
    
    // === RETURNS & WARRANTY ===
    "return|exchange policy": `🔄 Food/skincare can't be returned once opened. Defective or wrong items? Message Support—we'll make it right! (Link at bottom of page)`,
    
    "warranty|repair": `🛠️ No product warranty currently. Something wrong? Contact Support and we'll help! (Link at bottom of page)`,
    
    "damaged|wrong item|missing": `💙 I'm so sorry that happened! Please contact Support—we'll make it right. (Link at bottom of page)`,
    
    "refund|return label": `💵 Guest: Track Order → Request Return. Logged-in: Profile → Orders → Request Return. Refunds take ~2-3 days after approval!`,
    
    "when restock|out of stock": `📱 Check our Facebook page for restocks! We update there regularly.`,
    
    // === PRODUCT INFO (REMOVED allergen/ingredient terms to prevent collision) ===
    "preorder|backorder": `🇯🇵 Preorder: Message us on social to request from Japan! Backorder: Ships once restocked—check Facebook for updates.`,
    
    "size guide|right size": `👕 We don't sell apparel yet! Want some product recommendations?`,
    
    // REMOVED: "product care|how to use" - this should route to INFO
    
    "gift message|gift wrap": `🎀 Not yet, but we're working on it! I can suggest great gift items though!`,

    "multiple addresses|multiple address|many addresses|many address": `🏘️ Yes! Add multiple addresses at checkout or in your profile.`,

    // === CONTACT & SUPPORT ===
    "contact|human agent|customer service|support": `💬 Customer Service link is at the bottom of the page! They're ready to help.`,
    
    "email|sms|newsletter": `📬 We don't send marketing emails/SMS yet. When we do, you can opt in/out anytime!`,
    
    "privacy|data|personal info": `🔒 Check our Privacy Policy at the bottom of the site. We only collect what's needed (name, email, address) and use PayMongo's PCI-DSS systems!`
  };

  

  // Simang-Chan's voice: warm, concise, helpful
  function simangReply(text, addEmoji = true) {
    const emojis = {
      allergen: "⚠️",
      ingredient: "📋",
      nutrition: "🍱",
      care: "💡",
      general: "✨"
    };
    
    // Keep it natural and concise
    const trimmed = String(text || "").trim();
    if (!addEmoji) return trimmed;
    
    // Add contextual emoji if not already present
    if (!/[🎌📋⚠️💡🍱✨]/.test(trimmed)) {
      if (/allergen/i.test(trimmed)) return `${emojis.allergen} ${trimmed}`;
      if (/ingredient/i.test(trimmed)) return `${emojis.ingredient} ${trimmed}`;
      if (/nutrition/i.test(trimmed)) return `${emojis.nutrition} ${trimmed}`;
      if (/care|use|storage/i.test(trimmed)) return `${emojis.care} ${trimmed}`;
    }
    
    return trimmed;
  }

  function formatProductCard(p, idx) {
    return [
      `${idx + 1}️⃣ ${p.name}`,
      `   💰 ₱${Number(p.discountedPrice ?? p.price).toFixed(2)}${p.discountedPrice ? ` (was ₱${p.price})` : ""}`,
      `   📦 ${p.stock > 0 ? `✅ ${p.stock} in stock` : "❌ Out of stock"}`,
      `   🏷️ ${p.category}`
    ].join('\n');
  }

  // At the very start of your main chat handler BEFORE intent matching:
  async function handleChatRequest({ message, followupProductHint, intent }) {
    // --- Context awareness for generic requests ---
    // List of keywords and a pronoun-pattern for followups and generic actions
    const genericInfo = [
      "add to cart", "buy now", "allergen", "ingredients", "nutrition", "price", "where to buy"
    ];
    const pronounMatch = /^(it|its|this|that|add to cart|buy now|allergen|ingredients|nutrition|price)/i.test(message.trim());

    // If message is generic or pronoun-based, and we have product context, replace message
    if ((pronounMatch || genericInfo.some(q => message.toLowerCase().includes(q))) && followupProductHint) {
      message = followupProductHint;
    }

    // Example intent handling starts here
    switch (intent) {
      case "ADD_TO_CART":
      case "BUY_NOW":
      case "INFO":
      case "ALLERGEN": {
        // Fake product search; replace with your own catalog/product lookup
        const { db } = await getAdminDbOrNull();
        const knownProduct = db ? await lookupProductInCatalog(db, message) : null;

        // If after all, no product context is found, ask user to clarify
        if (!message || !knownProduct) {
          return {
            reply: "Which product would you like to refer to?",
            type: "clarification"
          };
        }

        // Now proceed with actual product logic, e.g., add to cart
        // return { ... }
      }

      // Other cases...
      default: {
        // fallback
        return {
          reply: "Sorry, I didn't get that. Please tell me what you'd like!",
          type: "error"
        };
      }
    }
  }





  function isTaglish(text) {
    // Simple detection: if the text contains common Filipino words or interspersed Tagalog, switch to Taglish
    const taglishIndicators = [
      "po", "naman", "sige", "grabe", "ganun", "salamat", "ate", "kuya", "kasi", "diba", "ba", "lang", "na", "pa", "tara", "hindi"
    ];
    const hasFilipino = taglishIndicators.some(word => text.toLowerCase().includes(word));
    return hasFilipino;
  }



  // Detect what specific info user wants
  // Detect what specific info user wants (plural-aware + variants)
  function parseInfoRequest(message) {
    const m = String(message || "").toLowerCase();

    const wantsAllergens = /\b(allergen|allergens|allergy|allergies|peanut|peanuts|tree\s*nuts?|soy|soya|dairy|milk|egg|eggs|gluten|wheat|shellfish|sesame|fish)\b/i.test(m);

    const wantsIngredients = /\b(ingredient|ingredients|what'?s\s+in|made\s+of|contain|contains|includes?)\b/i.test(m);

    const wantsNutrition = /\b(nutrition|nutritional|calorie|calories|carb|carbs|sugar|fat|protein|energy|kcal)\b/i.test(m);

    const wantsCare = /\b(how\s+to(\s+use)?|care|use|usage|storage|store|keep|directions|instructions?)\b/i.test(m);

    const wantsDietary = /\b(vegan|vegetarian|halal|kosher|gluten[\s-]?free|dairy[\s-]?free|lactose[\s-]?free)\b/i.test(m);

    return { wantsAllergens, wantsIngredients, wantsNutrition, wantsCare, wantsDietary };
  }

  // FAQ matcher with fuzzy tolerance and stop-word filtering
  function findFAQMatch(message) {
    const query = String(message || "").toLowerCase();
    
    // Filter out product-search indicators (if present, skip FAQ)
    const hasProductIntent = /\b(show|find|what|which|any|got)\s+(me\s+)?(product|item|snack|drink|chocolate|chip)/i.test(query);
    if (hasProductIntent) return null;
    
    // STRICT: Block INFO intent keywords from FAQ
    const hasInfoIntent = /\b(allergen|ingredient|nutrition|calorie|vegan|halal|gluten|care|storage)\b/i.test(query);
    if (hasInfoIntent) return null;
    
    for (const [pattern, answer] of Object.entries(FAQ_DECK)) {
      const terms = pattern.split("|");
      
      // Check for fuzzy matches with word boundaries
      for (const term of terms) {
        const words = term.split(/\s+/);
        
        // Single-word terms: exact match with word boundary
        if (words.length === 1) {
          const regex = new RegExp(`\\b${words[0]}\\b`, "i");
          if (regex.test(query)) return answer;
        } else {
          // Multi-word terms: all words must appear (order-independent)
          const allMatch = words.every(word => 
            new RegExp(`\\b${word}`, "i").test(query)
          );
          if (allMatch) return answer;
        }
      }
    }
    
    return null;
  }

  export function extractFilters(message) {
    const { category } = expandQuery(message); // ⬅️ do NOT take expandQuery.tokens (they poison price-only queries)
    const msg = String(message || "");
    const msgLower = msg.toLowerCase();
  
    // Accept: ₱200, PHP 200, Php 200, php200, 200 php
    const pesoSymbol = (msg.match(/₱\s*(\d+(?:\.\d+)?)/i) || [])[1];
    const pesoWordA  = (msg.match(/\bphp\s*(\d+(?:\.\d+)?)/i) || [])[1];
    const pesoWordB  = (msg.match(/\b(\d+(?:\.\d+)?)\s*php\b/i) || [])[1];
    const pesoAnyRaw = pesoSymbol || pesoWordA || pesoWordB;
  
    // UNDER / BELOW / LESS THAN  (→ maxPrice)
    const underRaw = (msg.match(/\b(under|below|less\s*than)\s*(?:₱|php)?\s*(\d+(?:\.\d+)?)/i) || [])[2];
  
    // OVER / ABOVE / MORE THAN / GREATER THAN  (→ minPrice)
    const overRaw  = (msg.match(/\b(over|above|more\s*than|greater\s*than)\s*(?:₱|php)?\s*(\d+(?:\.\d+)?)/i) || [])[2];
  
    // Sanitize to finite numbers or null
    const toNum = v => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pesoAny = toNum(pesoAnyRaw);
    const underNum = toNum(underRaw);
    const overNum  = toNum(overRaw);
  
    // Any price/budget cue present?
    const hasPriceCue = /\b(price|prices|cost|how\s*much|under|below|less\s*than|over|above|more\s*than|greater\s*than|budget|cheapest|affordable|max(?:imum)?\s*(?:price|budget)?)\b/i
      .test(msgLower);
  
    // Only infer category if the user actually talked about a category
    // AND it's not a budget-first (price-centric) query.
    let detectedCategory = null;
    if (!hasPriceCue) {
      const commonCategories = [
        "snacks", "juice", "beverage", "coffee", "tea", "noodles", "alcohol",
        "beauty", "cosmetics", "hygiene", "kitchen", "ingredients", "kitchenware",
        "frozen", "anime", "figures"
      ];
      for (const cat of commonCategories) {
        if (msgLower.includes(cat)) {
          if (cat === "snacks") detectedCategory = "Snacks";
          else if (cat === "juice" || cat === "beverage") detectedCategory = "Juice & Beverage";
          else if (cat === "coffee") detectedCategory = "Coffee";
          else if (cat === "tea") detectedCategory = "Tea";
          else if (cat === "noodles") detectedCategory = "Noodles";
          else if (cat === "alcohol") detectedCategory = "Alcohol Beverages";
          else if (cat === "beauty" || cat === "cosmetics") detectedCategory = "Beauty & Cosmetics";
          else if (cat === "hygiene") detectedCategory = "Hygiene";
          else if (cat === "kitchen" || cat === "ingredients") detectedCategory = "Kitchen Ingredients";
          else if (cat === "kitchenware") detectedCategory = "Kitchenware";
          else if (cat === "frozen") detectedCategory = "Frozen Goods";
          else if (cat === "anime" || cat === "figures") detectedCategory = "Anime Figures";
          break;
        }
      }
      if (!detectedCategory && category && msgLower.includes(String(category).toLowerCase())) {
        detectedCategory = category;
      }
    }
  
    return {
      category: detectedCategory || null,
      // If user said "under X" that wins for maxPrice;
      // If no under/over but they gave a lone amount (e.g., "php 200"), treat as maxPrice.
      maxPrice: underNum ?? (overNum ? null : (pesoAny ?? null)),
      // "over/above" becomes minPrice
      minPrice: overNum ?? null,
      onSale: /\b(sale|promo|discount|deal)s?\b/i.test(msgLower),
      newArrival: /\b(new|new\s*arrivals?|latest|just\s*in|bago)\b/i.test(msgLower),
      inStock: /\b(in\s*stock|available|availability)\b/i.test(msgLower),
      // CRITICAL: do NOT pass any qTokens from expandQuery to avoid poisoning SEARCH heuristics.
      qTokens: []
    };
  }
  


    // ========== INTENT DETECTION WITH STRICT PRIORITY CASCADE ==========
    // Priority order: TRACK > FAQ > INFO (explicit) > COMPARE > RECOMMEND > SEARCH > CHAT
    function detectIntent(raw, previousIntent = null) {
      const t = _norm(raw || "");

      // Direct answers to previous questions (conversational continuity)
      if (previousIntent === "INFO" && t.length < 50 && !t.match(/\b(show|find|search|track)\b/)) {
        return "INFO";
      }

      // ✅ ADD THIS BLOCK (after the INFO check, before TRACK)
      // === ENHANCED: Follow-up product queries (taste/variant/short phrases) ===
      const looksLikeFollowup = isPronounFollowup(raw);
      if (looksLikeFollowup && (previousIntent === "SEARCH" || previousIntent === "RECOMMEND" || previousIntent === "AVAILABILITY")) {
        // User is asking about a variant/taste of previously shown products
        return previousIntent; // Keep same intent to trigger product context
      }

      // === AUTO-DETECT ORDER ID (before explicit TRACK check) ===
      const hasOrderId = /\bORD-[A-Z0-9-]{6,}\b/i.test(t);
      if (hasOrderId && !previousIntent) return "TRACK";

      // === PRIORITY 1: TRACK (highest - explicit action) ===
      if (/\b(track|where.*order|status.*order|track\s*my)\b/.test(t)) return "TRACK";

      // === PRIORITY 1.5: COMPLAINT/ISSUE DETECTION ===
      const complaintKeywords = /\b(complaint|complain|problem|issue|not working|broken|damaged|wrong|missing|refund|disappointed|upset|angry|frustrated|terrible|bad experience|poor service)\b/i;
      if (complaintKeywords.test(t)) return "COMPLAINT";
      
      // ... rest of detectIntent stays the same

      // === PRIORITY 2: FAQ (prevent INFO/SEARCH collision) ===
      // Block FAQ from triggering INFO or SEARCH
      const looksLikeQuestion = /\b(do|does|can|how|what|when|where|why|is|are|will|would|could|should)\b/i.test(t);
      if (looksLikeQuestion) {
        // Check for FAQ-specific terms that should NOT trigger INFO
        const faqTerms = [
          'shipping', 'delivery', 'ship', 'address', 'international', 'pickup', 'store location',
          'cancel order', 'change order', 'guest checkout', 'account', 'invoice', 'receipt',
          'payment method', 'pay', 'cod', 'cash', 'secure', 'price match', 'tax', 'promo code',
          'return', 'exchange', 'warranty', 'refund', 'damaged', 'wrong item', 'restock',
          'preorder', 'size guide', 'gift', 'multiple address', 'contact', 'email', 'privacy'
        ];
        
        const hasFAQTerm = faqTerms.some(term => t.includes(term.toLowerCase()));
        
        // If it has FAQ terms AND looks like a question, it's FAQ (not INFO)
        if (hasFAQTerm) {
          return "CHAT"; // FAQ is handled in CHAT with findFAQMatch
        }
      }

      // === PRIORITY 3: INFO (explicit data requests only) ===
      // INFO should only trigger when user is ASKING ABOUT product data, not searching for products
      const infoKeywords = {
        allergen: /\b(allergen|allergy|allergic|gluten|peanut|nut|nuts|soy|egg|dairy|milk|lactose|shellfish|sesame|fish)\b/,
        ingredient: /\b(ingredient|what'?s\s+in|made\s+of|contains?|includes?|composition)\b/,
        nutrition: /\b(nutrition|nutritional|calorie|calories|carb|carbs|sugar|fat|protein|sodium|energy|kcal)\b/,
        dietary: /\b(vegan|halal|kosher|vegetarian|gluten[\s-]?free|dairy[\s-]?free|plant[\s-]?based)\b/,
        origin: /\b(origin|where\s+from|made\s+in|country|imported|manufactured)\b/,
        care: /\b(how\s+to\s+use|care|usage|storage|store|keep|maintain|directions|instructions?)\b/
      };

      const hasInfoKeyword = Object.values(infoKeywords).some(regex => regex.test(t));

      if (hasInfoKeyword) {
        // Check if user is ASKING (question structure) or just naming products
        const questionIndicators = /\b(what|can\s+you\s+tell|tell\s+me|show\s+me\s+the|does\s+it|is\s+it|are\s+there|any|which|list|give\s+me)\b/;
        const productNameIndicators = /\b(i\s+want|show\s+me|find|search|looking\s+for|need|buy)\b/;
        
        const isQuestion = questionIndicators.test(t);
        const isProductSearch = productNameIndicators.test(t);
        
        // Only route to INFO if:
        // 1. It's a question structure AND
        // 2. NOT a product search request
        if (isQuestion && !isProductSearch) {
          return "INFO";
        }
        
        // If message is ONLY an info keyword + product name (no action verbs), it's ambiguous
        // Example: "allergens of pancake mix" - unclear if asking or searching
        const hasActionVerb = /\b(show|find|search|browse|look|want|need|give|tell)\b/.test(t);
        if (!hasActionVerb && hasInfoKeyword) {
          // This is ambiguous - we'll let SEARCH handle it and show products first
          return "SEARCH";
        }
      }

      // === PRIORITY 4: COMPARE ===
      // add common separators like "vs.", "x", "&"
      if (/\b(compare|vs|versus)\b|(?:\s+vs\.?\s+|\s+x\s+|\s*&\s*)/i.test(t)) return "COMPARE";

      // === PRIORITY 5: RECOMMEND ===
      if (/\b(recommend|recommendation|recommendations|suggest|suggestion|suggestions|what'?s\s*(good|popular)|any\s+reco(m|mmendations?)?|pick\s*something|surprise\s*me|best\s*sellers?|popular\s*(choices|items)|ano(?:ng)?\s*marecommend|recommend\s*mo)\b/i.test(t)) {
        return "RECOMMEND";
      }

      // === PRIORITY 6: BROWSE (Categories & Sales/New) ===
      if (/\b(categor(?:y|ies)|browse\s*categor|show\s*categor|list\s*categor|categories|browse|explore)\b/i.test(t)) return "BROWSE";
      if (/\b(sale|promo|discount|deals?|mark\s*down|on\s*sale)\b/i.test(t)) return "BROWSE_SALE";
      if (/\b(new|new\s*arrivals?|latest|just\s*in|bag[o0]\b)\b/i.test(t)) return "BROWSE_NEW";

      // === PRIORITY 7: AVAILABILITY ===
      // broader English + Taglish variants like "meron", "may", "do you carry/sell"
      if (/\b(available|availability|in\s*stock|stock(?:ed)?|have|got|carry|sell|do\s*(?:you|u)\s*(?:have|carry|sell)|meron|may|pwede|pede|available\s*ba|meron\s*ba|may\s*ba|how\s*about)\b/i.test(t)) {
        return "AVAILABILITY";
      }

      // === PRIORITY 8: SEARCH ===
      // broader verbs + Taglish: "hanap", "pakita", "tingnan"
      if (/\b(show|find|search|browse|look\s*for|see|display|check\s*out|explore|look|view|filter|sort|hanap|pakita|tingnan)\b/i.test(t)) {
        return "SEARCH";
      }

      // Category mentions without action verbs → SEARCH
      if (/\b(chip|chips|snack|snacks|cracker|crisps|drink|drinks|beverage|beverages|juice|chocolate|cocoa|coffee|tea|mask|skincare|beauty|cosmetics|noodles?|ramen|miso|sauce|oil|condiment|seasoning)\b/i.test(t)) {
        return "SEARCH";
      }

      // Price/budget cues → SEARCH (English + Taglish + symbols once normalized)
      // catches phrasing like "under php 150", "below 200", "max 300", "budget 500", "cheapest"
      if (/\b(price|prices|cost|how\s*much|under|below|less\s*than|over|above|more\s*than|greater\s*than|at\s*most|up\s*to|at\s*least|min(?:imum)?|budget|cheapest|affordable|max(?:imum)?\s*(?:price|budget)?)\b/i.test(t)) {
        return "SEARCH";
      }

      // === PRIORITY 9: CHAT (default) ===
      return "CHAT";
    }






  // ADDED: normalize, tokenization, and simple fuzzy matching
  const STOP_WORDS = new Set([
    "do","does","did","you","have","has","is","are","the","a","an","of","for","on","in","to","please","pls",
    "got","any","some","your","my","me","show","find","want","need","with","and","or",
    "contain","contains","include","includes","has","have",
    // Add these to prevent "match" from being a search term when asking about price matching
    "price","cost","much","adjust","policy","do",
    // Tagalog helpers
    "meron","may","kayo","ka","po","ba","paki","lang","naman"
  ])

  // Currency & price-direction words that should never make a query "textual"
  for (const w of [
   "php","peso","pesos","₱",
    "under","below","less","over","above","more","greater","than",
    "budget","cheapest","affordable",
    "item","items","product","products","option","options","choice","choices"
  ]) STOP_WORDS.add(w);


  // PATCH: extend stop-words with common Tagalog helpers used in queries
  for (const w of ["meron","may","kayo","ka","po","ba","paki","lang","naman"]) {
    STOP_WORDS.add(w);
  }

  

  // --- follow-up detection: "that", "this", "it", "those", "the last one" ---
  // --- follow-up detection: "that", "this", "it", "those", "the last one" ---
  // ENHANCED: Also catch taste/variant words and short generic phrases
  function isPronounFollowup(text="") {
    const s = String(text).toLowerCase().trim();
    
    // Direct pronouns
    if (/\b(that|this|it|they|those|them|the last one|the previous one|yun|yan|yung)\b/.test(s)) {
      return true;
    }
    
    // Taste/variant follow-ups (common in Taglish)
    if (/\b(matcha|green\s*tea|sweet|tamis|matamis|salty|maalat|spicy|maanghang|umami|chocolate|chewy|fruity|sana|gusto|available)\b/i.test(s)) {
      return true;
    }
    
    // Very short queries (1-3 words) after a product discussion
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length <= 3 && !s.match(/\b(show|find|search|track|compare|where|what|how|when)\b/)) {
      return true;
    }
    
    return false;
  }

  // Ask Gemini to expand a vague request into search terms (synonyms + related).
  // Keep it tiny and cheap; we cap to at most 8 tokens.
  async function expandSearchTermsLLM(userText, callGeminiFn) {
    const prompt = [
      "Return a comma-separated list of up to 8 SHORT search keywords for a product database.",
      "Include synonyms and close variants (English and common JP/romaji words when relevant).",
      "No sentences. No punctuation except commas. Examples: salty -> salty,salted,umami,consomme,shio,seaweed,cracker,chip",
      `Query: ${String(userText || "").trim()}`
    ].join("\n");
    try {
      const raw = await callGeminiFn(
        "gemini-2.5-flash",
        "Return only keywords.",
        [], // no history
        prompt,
        ""  // no extra context
      );
      const terms = String(raw || "")
        .toLowerCase()
        .replace(/[`*]|json|```/g, "")
        .split(/[,\n]/)
        .map(t => t.trim())
        .filter(Boolean);
      // de-dup + cap
      return Array.from(new Set(terms)).slice(0, 8);
    } catch {
      return [];
    }
  }

  // If strict search misses, do a small loose scan (client-side filter) over a cap.
  async function searchProductsLoose(db, rawQuery, cap = 800) {
    const s = String(rawQuery || "").toLowerCase();
    const snap = await db.collection("products").limit(cap).get();
    const out = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      const name = String(d.productName || "").toLowerCase();
      const descr = String(d.description || "").toLowerCase();
      if (name.includes(s) || descr.includes(s)) {
        out.push({
          id: doc.id,
          name: d.productName || d.name || doc.id,
          price: Number(d.price ?? 0),
          originalPrice: d.originalPrice ? Number(d.originalPrice) : null,
          isDiscountEnabled: !!d.isDiscountEnabled,
          isNewArrival: !!d.isNewArrival,
          stock: Number(d.stock ?? 0),
          category: d.category || "",
          imageUrl: d.imageUrl || ""
        });
      }
    });
    return out.slice(0, 12);
  }

  // NEW: Lightweight prefix-only search (name-only) as a fallback
  async function searchProductsPrefix(db, rawQuery, filters = {}, cap = 800) {
    const normQuery = normalizeText(rawQuery);
    if (!normQuery) return []; // Avoid empty prefix search

    const products = [];
    try {
      const snapshot = await db.collection("products").limit(cap).get();
      const docs = snapshot.docs;

      for (const doc of docs) {
        const d = doc.data() || {};
        const p = {
          id: doc.id,
          name: d.productName || d.name || doc.id,
          price: Number(d.price || 0),
          discountedPrice: d.discountedPrice ? Number(d.discountedPrice) : null,
          category: d.category || "",
          stock: Number(d.stock || 0),
          description: d.description || "", // Keep fields for consistency
          imageUrl: d.imageUrl || "",
          tags: d.tags || [],
          flavor: d.flavor || "",
          barcode: d.barcode || "",
          isNewArrival: Boolean(d.isNewArrival),
          isDiscountEnabled: Boolean(d.isDiscountEnabled),
          dietaryTags: Array.isArray(d.dietaryTags) ? d.dietaryTags : [],
        };

        // 1. Apply standard filters FIRST for efficiency
        if (filters.category && !p.category.toLowerCase().includes(String(filters.category).toLowerCase())) continue;
        const effPrice = p.discountedPrice ?? p.price;
        // FIXED: Use <= for maxPrice (under means "up to and including")
        if (filters.maxPrice != null && effPrice > filters.maxPrice) continue;
        if (filters.minPrice != null && effPrice < filters.minPrice) continue;
        if (filters.inStock && p.stock <= 0) continue;
        if (filters.onSale && !isOnSaleNow(p)) continue;
        if (filters.newArrival && !p.isNewArrival) continue;
        if (filters.dietaryTag && p.dietaryTags.length) {
          const hasTag = p.dietaryTags.some(tag => normalizeText(tag).includes(normalizeText(filters.dietaryTag)));
          if (!hasTag) continue;
        }

        // 2. Check for prefix match ONLY on normalized name
        const normName = normalizeText(p.name);
        if (normName.startsWith(normQuery)) {
          // Use a simple score; sorting prioritizes stock/price anyway
          products.push({ ...p, _score: 1 });
        }
        
      

      // 3. Sort primarily by stock, then price (no score needed here)
      products.sort((a, b) => {
        if (a.stock > 0 && b.stock <= 0) return -1;
        if (a.stock <= 0 && b.stock > 0) return 1;
        const pa = a.discountedPrice || a.price, pb = b.discountedPrice || b.price;
        return pa - pb;
      });
      }
    } catch (e) {
      console.error("Product prefix search error:", e);
    }
    return products.slice(0, 10); // Return top 10 matches
  }



  function levenshtein(a, b) {
    if (a === b) return 0
    const al = a.length, bl = b.length
    if (!al) return bl
    if (!bl) return al
    const dp = Array(bl + 1).fill(0).map((_, i) => i)
    for (let i = 1; i <= al; i++) {
      let prev = i - 1, cur = i
      for (let j = 1; j <= bl; j++) {
        const tmp = dp[j]
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1], dp[j])
        prev = tmp
      }
    }
    return dp[bl]
  }

  function scoreTokensAgainstText(tokens, searchable) {
    if (!tokens.length) return 0
    let score = 0
    const words = searchable.split(" ")
    const phrase = tokens.join(" ")
    if (searchable.includes(phrase)) score += 6 // contiguous phrase bonus

    for (const t of tokens) {
      if (searchable.includes(t)) { score += 3; continue }
      if (words.some(w => w.startsWith(t))) { score += 2; continue }
      // near-match within edit distance 1 across any word
      if (words.some(w => levenshtein(w, t) <= 1)) { score += 1; continue }
    }
    return score
  }

  // Extract two product phrases for compare (tolerant to "vs", "&", "and", parentheses)
  function parseComparePair(text) {
    const s = String(text || "");
    // common separators
    const parts = s.split(/\bvs\b| versus | vs\. |, and | and | & /i).map(t => t.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Keep the most producty two chunks; strip leading noise like "compare", "price of"
      const clean = parts.map(p =>
        p.replace(/\b(compare|price|cost|of|the|a|an)\b/gi, "").replace(/\s+/g, " ").trim()
      ).filter(Boolean);
      if (clean.length >= 2) return [clean[0], clean[1]];
    }
    // Fallback: grab within parentheses as hints
    const paren = s.match(/\(([^)]+)\)/g)?.map(x => x.replace(/[()]/g, "").trim()) || [];
    if (paren.length >= 2) return [paren[0], paren[1]];
    return null;
  }

  async function findTopProduct(db, phrase) {
    // Leverage your existing fuzzy search; pass the phrase directly
    const results = await searchProducts(db, phrase, {});
    return Array.isArray(results) && results.length ? results[0] : null;
  }


  // MODIFIED AGAIN: More targeted normalization & scoring for vision results
  export const searchProducts = async (db, query, filters = {}) => {
    console.log(`[searchProducts] Query: "${query}", Filters:`, JSON.stringify(filters));

    const originalQueryNormalized = normalizeText(query);  // General normalization for tokens
    const hasMeaningfulQuery = originalQueryNormalized.length > 0;
    const tokens = tokenizeQuery(query); // Use general tokens for broader search
    const products = [];
    const hasFilters = !!(filters.category || filters.inStock || filters.onSale || filters.newArrival || filters.maxPrice != null || filters.minPrice != null || filters.dietaryTag); // Check filters more reliably

    if (!hasMeaningfulQuery && !hasFilters) {
        console.log("[searchProducts] No meaningful query or filters. Returning empty.");
        return [];
    }

    // --- START: Specific Vision Query Normalization ---
    // Create a version of the query specifically cleaned for direct name comparison
    const visionQueryCompare = normalizeText(query)
      .replace(/^(nestle|meiji|calbee|biore|kewpie|ito en|glico|morinaga|suntory|asahi)\s+/g, '')
      .replace(/(\d+)\s*(pcs|pc|pieces?)/gi, '$1 pcs')
      .replace(/(\d+)\s*(g|grams?)/gi, '$1 g')
      .replace(/(\d+)\s*(ml|milliliters?)/gi, '$1 ml')
      .replace(/[()[\]]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    console.log(`[searchProducts] Vision Query Compare format: "${visionQueryCompare}"`);


    try {
      const fetchLimit = hasFilters ? 1000 : 800;
      console.log(`[searchProducts] Fetching up to ${fetchLimit} docs...`);
      const snapshot = await db.collection("products").limit(fetchLimit).get();
      const docs = snapshot.docs;
      console.log(`[searchProducts] Fetched ${docs.length} docs.`);
    
      for (const doc of docs) {
        const d = doc.data() || {};
        const p = {
          id: doc.id,
          name: d.productName || d.name || doc.id,
          price: Number(d.price || 0),
          discountedPrice: d.discountedPrice ? Number(d.discountedPrice) : null,
          category: d.category || "",
          stock: Number(d.stock || 0),
          description: d.description || "",
          imageUrl: d.imageUrl || "",
          tags: d.tags || [],
          flavor: d.flavor || "",
          barcode: d.barcode || "",
          isNewArrival: Boolean(d.isNewArrival),
          isDiscountEnabled: Boolean(d.isDiscountEnabled),
          ingredients: d.ingredients || "",
          allergens: d.allergens || "",
          dietaryTags: Array.isArray(d.dietaryTags) ? d.dietaryTags : [],
          countryOfOrigin: d.countryOfOrigin || "Japan",
          careInstructions: d.careInstructions || "",
          howToUse: d.howToUse || ""
        };

        // --- Apply Filters First ---
        if (filters.category && !normalizeText(p.category).includes(normalizeText(filters.category))) continue;
        if (filters.strictCategory && normalizeText(p.category) !== normalizeText(filters.strictCategory)) {
          continue;
        }
        
        const effPrice = p.discountedPrice ?? p.price;
        if (filters.maxPrice != null && effPrice > filters.maxPrice) continue;
        if (filters.minPrice != null && effPrice < filters.minPrice) continue;
        if (filters.inStock && p.stock <= 0) continue;
        if (filters.onSale && !isOnSaleNow(p)) continue;
        if (filters.newArrival && !p.isNewArrival) continue;
        if (filters.dietaryTag && p.dietaryTags.length) {
          const hasTag = p.dietaryTags.some(tag => normalizeText(tag).includes(normalizeText(filters.dietaryTag)));
          if (!hasTag) continue;
        }
        // --- End Filters ---


        // --- Scoring Logic ---
        let s = 0;
        p._nameHit = false;

        if (hasMeaningfulQuery) {
          const dbNameNormGeneral = normalizeText(p.name);
          
          const queryLower = originalQueryNormalized.toLowerCase();
          if (queryLower.length >= 5) {
            const dbNameLower = normalizeText(p.name).toLowerCase();
            
            // Direct substring match in name
            if (dbNameLower.includes(queryLower)) {
              s += 50; // Huge boost for exact hits
              p._nameHit = true;
              console.log(`[searchProducts] 🎯 Exact substring match: "${p.name}"`);
            }
            
            // Brand + key term match (e.g., "s&b curry")
            const queryTokens = queryLower.split(/\s+/).filter(t => t.length >= 3);
            if (queryTokens.length >= 2) {
              const matchCount = queryTokens.filter(qt => dbNameLower.includes(qt)).length;
              if (matchCount === queryTokens.length) {
                s += 40; // All query tokens present
                p._nameHit = true;
              }
            }
          }
        
          const dbNameCompare = normalizeText(p.name)
            .replace(/^(nestle|meiji|calbee|biore|kewpie|ito en|glico|morinaga|suntory|asahi)\s+/g, '')
            .replace(/(\d+)\s*(pcs|pc|pieces?)/gi, '$1 pcs')
            .replace(/(\d+)\s*(g|grams?)/gi, '$1 g')
            .replace(/(\d+)\s*(ml|milliliters?)/gi, '$1 ml')
            .replace(/[()[\]]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        
          let searchableText;
          if (filters.nameOnly) {
            searchableText = dbNameNormGeneral;
          } else {
            searchableText = normalizeText([
              p.name,
              p.category, p.description, p.flavor, p.barcode,
              p.ingredients, p.allergens, p.countryOfOrigin, p.careInstructions, p.howToUse,
              ...(p.tags || []), ...(p.dietaryTags || [])
            ].join(" "));
          }        
            // ✅ Calculate similarity ONCE at the top (always available for debug logs)
            const nameSimilarityScore = 1 - (
              levenshtein(visionQueryCompare, dbNameCompare) / 
              Math.max(visionQueryCompare.length, dbNameCompare.length, 1)
            );
          
            // **Debug Log:** Now safe to use nameSimilarityScore anywhere
            if (normalizeText(p.name).includes("kitkat matcha latte")) {
              console.log(`[DEBUG] Scoring "${p.name}": Score = ${s}, NameHit = ${p._nameHit}, Similarity = ${nameSimilarityScore.toFixed(2)} (Compare: "${visionQueryCompare}" vs "${dbNameCompare}")`);
            }

             // **NEW: Smarter Vision-Based Scoring**
             // Detect if this is a vision-driven search (structured query from image)
             const looksLikeVisionQuery = 
             visionQueryCompare.length > 10 && 
             /\b(kitkat|calbee|pocky|pretz|biore|kewpie|nestle|meiji|glico)\b/.test(visionQueryCompare);
            
              if (looksLikeVisionQuery) {
                console.log(`[searchProducts] 🎯 Vision-enhanced scoring for: "${visionQueryCompare}"`);
                
                // Use the already-calculated nameSimilarityScore
                if (nameSimilarityScore > 0.85) {
                  s += 30;
                  p._nameHit = true;
                  console.log(`[Vision] ✅ High similarity (${nameSimilarityScore.toFixed(2)}) for "${p.name}"`);
                }
                
                // 1. Ultra-high similarity bonus (vision needs exact matches)
                const nameSimilarityScore = 1 - (
                  levenshtein(visionQueryCompare, dbNameCompare) / 
                  Math.max(visionQueryCompare.length, dbNameCompare.length, 1)
                );
                
                // **NEW Debug Log:** Log score AFTER calculation
                if (normalizeText(p.name).includes("kitkat matcha latte")) {
                  console.log(`[DEBUG] Scoring "${p.name}": Score = ${s}, NameHit = ${p._nameHit}, Similarity = ${nameSimilarityScore.toFixed(2)} (Compare: "${visionQueryCompare}" vs "${dbNameCompare}")`);
                }
               
               if (nameSimilarityScore > 0.85) {
                 s += 30; // Massive boost for near-exact matches
                 p._nameHit = true;
                 console.log(`[Vision] ✅ High similarity (${nameSimilarityScore.toFixed(2)}) for "${p.name}"`);
               }
               
               // 2. Exact substring match (e.g., "KitKat Matcha Latte" in "KitKat Matcha Latte 10pcs")
               if (visionQueryCompare.length > 5 && dbNameCompare.includes(visionQueryCompare)) {
                 s += 35; // Even higher than similarity
                 p._nameHit = true;
                 console.log(`[Vision] ✅ Exact substring match for "${p.name}"`);
               }
               
               // 3. Brand + Variant combo (core identifiers)
               const visionTokens = visionQueryCompare.split(' ').filter(t => t.length >= 3);
               const dbTokens = dbNameCompare.split(' ').filter(t => t.length >= 3);
               const commonTokens = visionTokens.filter(vt => dbTokens.includes(vt));
               
               if (commonTokens.length >= 2) {
                 s += 15; // Strong boost for 2+ matching key terms
                 p._nameHit = true;
                 console.log(`[Vision] ✅ ${commonTokens.length} common tokens for "${p.name}":`, commonTokens);
               }
               
               // 4. Penalize mismatches (vision should be precise)
               const mismatchPenalty = Math.max(0, visionTokens.length - commonTokens.length) * 3;
               s -= mismatchPenalty;
               
             } else {
               // Original scoring logic for text-based searches
               const nameSimilarityScore = 1 - (
                 levenshtein(visionQueryCompare, dbNameCompare) / 
                 Math.max(visionQueryCompare.length, dbNameCompare.length, 1)
               );
               
               if (nameSimilarityScore > 0.88) {
                 s += 25;
                 p._nameHit = true;
               }
               
               // 1b. Exact substring match boost (for image search)
               if (visionQueryCompare.length > 5 && dbNameCompare.includes(visionQueryCompare)) {
                 s += 30;
                 p._nameHit = true;
                 console.log(`[searchProducts] Exact substring match for "${p.name}"`);
               }
             }
 
             // 2. Original token scoring (against broader text)
             s += scoreTokensAgainstText(tokens, searchableText);
 
             // 3. Name token hit boost (check against general normalized DB name)
             let nameTokenBoostApplied = false;
             for (const t of tokens) {
               if (t && dbNameNormGeneral.includes(t)) {
                 if (!nameTokenBoostApplied) {
                    s += 5;
                    p._nameHit = true;
                    nameTokenBoostApplied = true;
                 }
               }
             }
 
             // 4. Core keyword boost
             const coreKeywords = ['kitkat', 'matcha', 'latte', 'calbee', 'consomme', 'chips', 'kewpie', 'mayo', 'biore', 'sunscreen'];
             const queryKeywords = tokens.filter(t => coreKeywords.includes(t));
             if (queryKeywords.length >= 1) {
                 const dbNameKeywords = tokenizeQuery(p.name).filter(t => coreKeywords.includes(t));
                 const commonKeywords = queryKeywords.filter(k => dbNameKeywords.includes(k));
                 if (commonKeywords.length >= 1) {
                     s += 8;
                     p._nameHit = true;
                 }
             }
 
             // 5. Prefix match bonus (using specifically normalized strings)
             if (visionQueryCompare && dbNameCompare.startsWith(visionQueryCompare)) {
                 s += 3;
             }

             // --- CORRECTED products.push HERE (Inside if block, AFTER scoring) ---
             // Add product only if score is high enough
             const MIN_SCORE = hasMeaningfulQuery ? 3 : 1;  // Require higher score for text queries
              if (s >= MIN_SCORE) {
                products.push({ ...p, _score: s });
              }
             // --- END CORRECTION ---

        } else {
            // No query text, but filters exist
            s = 1; //
            // --- CORRECTED products.push HERE (Inside else block) ---
            products.push({ ...p, _score: s }); //
            // --- END CORRECTION ---
        }

      } // End for loop

      console.log(`[searchProducts] Scored ${products.length} potential matches.`);

      // --- Sorting Logic ---
       products.sort((a, b) => { //
         // **NEW:** Prioritize name hits strongly if scores are close
         if (a._nameHit !== b._nameHit && Math.abs(b._score - a._score) < 5) { //
              return (b._nameHit ? 1 : 0) - (a._nameHit ? 1 : 0); //
         }
         // Then sort by score
         if (b._score !== a._score) return b._score - a._score; //
         // Then prioritize in-stock
         if ((a.stock > 0) !== (b.stock > 0)) return (b.stock > 0 ? 1 : 0) - (a.stock > 0 ? 1 : 0); //
          // Then prioritize on sale
          const ad = isOnSaleNow(a) ? 1 : 0, bd = isOnSaleNow(b) ? 1 : 0; //
          if (ad !== bd) return bd - ad; //
         // Then by price ascending
         const pa = a.discountedPrice ?? a.price; //
         const pb = b.discountedPrice ?? b.price; //
         return pa - pb; //
       });
      // --- End Sorting ---

    } catch (e) {
      console.error("[searchProducts] Error:", e);
    }

    const finalResults = products.slice(0, 10); //
    console.log(`[searchProducts] Returning ${finalResults.length} matches. Top score: ${finalResults[0]?._score || 'N/A'}`); // Improved log
    return finalResults; //
  }

  // --- PATCH: include short description for LLM context
  function briefDesc(text, max = 80) {
    if (!text) return "";
    const s = String(text).trim();
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  }

  function formatProductListWithDesc(products) {
    if (!products.length) return "No matching products.";
    return products.map(p => {
      const now = p.discountedPrice ?? p.price;
      const was = p.discountedPrice ? ` (was ₱${Number(p.price).toFixed(2)})` : "";
      const stock = p.stock > 0 ? `✅ ${p.stock} in stock` : "❌ Out of stock";
      const desc = p.description ? ` — ${briefDesc(p.description)}` : "";
      return `• ${p.name}${desc} — ₱${Number(now).toFixed(2)}${was} — ${stock} — ${p.category}`;
    }).join("\n");
  }

  // --- Coerce accidental JSON replies from the model into human text ---
  function _stripJsonFences(s) {
    let t = String(s || "").trim();
    // remove common code fences and leading "json"
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    if (t.toLowerCase().startsWith("json")) t = t.slice(4).trim();
    return t;
  }

  function _parseJsonLoose(s) {
    const t = _stripJsonFences(s);
    try { return JSON.parse(t); } catch {}
    const m = t.match(/\{[\s\S]*\}/); // try first object-looking block
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  function _renderProductJson(j) {
    if (!j || typeof j !== "object") return null;

    // common fields seen in LLM “product cards”
    const product = j.product || j.name || j.title || null;
    const price = j.price || j.pricing || null;                   // e.g. "₱199"
    const availability = (j.availability ?? j.inStock ?? j.stock);
    const category = j.category || null;
    const notes = j.notes || j.note || null;
    const related = Array.isArray(j.related_products || j.related || [])
      ? (j.related_products || j.related).slice(0, 5)
      : [];

    const lines = [];

    if (product) {
      lines.push(`${product}${category ? ` — ${category}` : ""}`);
    }

    if (price || availability !== undefined) {
      const availStr = (typeof availability === "string")
        ? availability
        : (availability === true ? "✅ in stock" : (availability === false ? "❌ out of stock" : ""));
      const priceStr = price ? String(price).trim() : "";
      const mid = [priceStr, availStr].filter(Boolean).join(" — ");
      if (mid) lines.push(mid);
    }

    if (notes) lines.push(`Note: ${String(notes).trim()}`);

    if (related.length) {
      lines.push(`You might also like: ${related.join(", ")}`);
    }

    return lines.length ? lines.join("\n") : null;
  }

  function normalizeModelReply(text) {
    // If it's JSON-looking, render friendly; else just clean fences/“json” prefix.
    const j = _parseJsonLoose(text);
    if (j) {
      const pretty = _renderProductJson(j);
      if (pretty) return pretty;
    }
    return _stripJsonFences(text);
  }



  const formatProductList = products => {
    if (!products.length) return "No matching products."
    return products.map(p => {
      const price = p.discountedPrice || p.price
      const was = p.discountedPrice ? ` (was ₱${Number(p.price).toFixed(2)})` : ""
      const stock = p.stock > 0 ? `✅ ${p.stock} in stock` : "❌ Out of stock"
      return `• ${p.name} — ₱${Number(price).toFixed(2)}${was} — ${stock} — ${p.category}`
    }).join("\n")
  }


  function sanitizeHistory(hist) {
    const arr = Array.isArray(hist) ? hist.filter(h => h && typeof h.text === "string") : []
    while (arr.length && arr[0].role !== "user") arr.shift()
    const out = []
    for (const h of arr) {
      const role = h.role === "model" ? "model" : "user"
      if (out.length && out[out.length - 1].role === role) {
        out[out.length - 1].parts[0].text += "\n" + String(h.text || "")
      } else {
        out.push({ role, parts: [{ text: String(h.text || "") }] })
      }
    }
    return out
  }

  // --- DB-only guard for all LLM calls (add above callGemini) ---
  const DB_ONLY_CONTEXT_HEADER = [
    "STRICT DB-ONLY MODE:",
    "- You may use ONLY the product lines provided in the CONTEXT block below as your knowledge of availability, names, prices, stock, categories, and suggestions.",
    "- DO NOT search the web yourself. The server will perform web-grounded lookups ONLY for INFO facts (allergens, ingredients, nutrition, certifications, shelf-life).",
    "- If the CONTEXT block is empty, reply warmly in Simang-Chan's voice but DO NOT name or invent any products or flavors. Ask a short clarifying question if needed.",
    "- Never mention items not present in the CONTEXT block.",
  ].join("\n");

  

  async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }
    
      const callGemini = async (model, sys, history, userText, context) => {
        const MAX_RETRIES = 2; // Try original + 2 retries
        let attempt = 0;
    
        while (attempt <= MAX_RETRIES) {
          try {
            const m = getGenAIForModel(model).getGenerativeModel({ model }); // Use getGenAIForModel here
            const chat = m.startChat({
              systemInstruction: { parts: [{ text: String(sys || "") }] },
              history: sanitizeHistory(history)
            });
    
            const ctxBlock = `\n${DB_ONLY_CONTEXT_HEADER}\nCONTEXT:\n${
              context && String(context).trim() ? String(context) : "(none)"
            }`;
    
            const prompt = String(userText || "") + ctxBlock;
            const res = await chat.sendMessage(prompt);
            return res.response.text(); // Success! Exit the loop.
    
          } catch (error) {
            console.error(`[callGemini] Attempt ${attempt + 1} failed for model ${model}:`, error?.message || error);
            attempt++;
    
            // Check if it's a retryable error (e.g., 503, 429)
            const isRetryable =
              String(error?.message || "").includes("Service Unavailable") || // 503
              String(error?.message || "").includes("overloaded") ||       // 503 variation
              String(error?.message || "").includes("Rate limit");          // 429
    
            if (isRetryable && attempt <= MAX_RETRIES) {
              const delay = Math.pow(2, attempt - 1) * 500; // Exponential backoff (500ms, 1000ms)
              console.log(`[callGemini] Retrying in ${delay}ms...`);
              await sleep(delay);
            } else {
              throw error; // Non-retryable error or max retries reached, re-throw.
            }
          }
        }
        // Should not be reached if MAX_RETRIES > 0, but as a safeguard:
        throw new Error(`[callGemini] Failed after ${MAX_RETRIES + 1} attempts.`);
      };


  // === Grounded web lookup (Google Search), lazy-loaded so we don't break anything ===
  // Triggers only for INFO-like questions when we need web facts (ingredients/allergens/etc.)
  function wantsWebFacts(text = "") {
    const s = String(text || "").toLowerCase();
    return /\b(ingredient|ingredients|allergen|allergens|allergy|allergies|contain|contains|include|includes|has|nutrition|nutritional|calorie|calories|vegan|vegetarian|gluten[-\s]?free|dairy|milk|peanut|peanuts|tree\s*nuts?|soy|soya|egg|eggs|wheat|shellfish|sesame|fish|halal|kosher|expiry|expiration|shelf\s*life)\b/.test(s);
  }

  function withSoftTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), ms))
    ]);
  }


  // --- Answer cache (TTL-backed) ---
  function _normKey(s) {
    // reuse your normalizeText semantics; fallback here if moved
    const t = (typeof normalizeText === "function")
      ? normalizeText(String(s || ""))
      : String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    return t.slice(0, 200);
  }

  async function getCachedAnswer(db, { intent, key }) {
    try {
      const snap = await db.collection("answer_cache")
        .where("intent", "==", intent)
        .where("key", "==", key)
        .limit(1)
        .get();
      if (snap.empty) return null;
      const d = snap.docs[0].data();
      return { reply: d.reply || null, products: Array.isArray(d.products) ? d.products : [] };
    } catch { return null; }
  }

  async function putCachedAnswer(db, { intent, key, reply, products, ttlDays = 7 }) {
    try {
      const expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
      await db.collection("answer_cache").add({
        intent,
        key,
        reply: String(reply || "").slice(0, 2000),
        products: Array.isArray(products) ? products.slice(0, 6) : [],
        createdAt: new Date(),
        expireAt
      });
    } catch {
      /* non-fatal */
    }
  }

  // Learn from cached answers to improve future responses
  async function learnFromCache(db, { intent, userQuery }) {
    try {
      const normalizedQuery = _normKey(userQuery);
      
      // Find similar cached answers
      const snap = await db.collection("answer_cache")
        .where("intent", "==", intent)
        .limit(10)
        .get();
      
      if (snap.empty) return null;
      
      // Score similarity
      const queryTokens = _tokens(normalizedQuery);
      const scored = [];
      
      snap.forEach(doc => {
        const d = doc.data();
        const cacheKeyTokens = _tokens(d.key || "");
        
        // Simple token overlap score
        let overlap = 0;
        for (const qt of queryTokens) {
          if (cacheKeyTokens.includes(qt)) overlap++;
        }
        
        if (overlap > 0) {
          scored.push({
            reply: d.reply,
            products: d.products || [],
            score: overlap / Math.max(queryTokens.length, cacheKeyTokens.length)
          });
        }
      });
      
      // Return best match if similarity > 0.5
      scored.sort((a, b) => b.score - a.score);
      if (scored.length && scored[0].score > 0.5) {
        return scored[0];
      }
      
      return null;
    } catch (err) {
      console.warn("[learnFromCache] failed:", err?.message);
      return null;
    }
  }


  // Build a focused question for the model, anchored on the product we matched in Firestore.
  function buildFactsQuestion(product, userText) {
    const nameRaw = product?.name || product?.productName || "";
    const category = product?.category || "";
    const barcode = product?.barcode || "";

    // Small brand normalization (helps web search)
    const name = nameRaw.replace(/\bvanhouten\b/i, "Van Houten");

    const hints = [name].filter(Boolean);

    if (barcode) hints.push(`barcode ${barcode}`);
    if (category) hints.push(category);

    return [
      "You are extracting verified product facts for an e-commerce database.",
      "Search the exact product (brand/variant/size). Prefer official brand pages and Japanese retailers: rakuten.co.jp, amazon.co.jp, yodobashi.com, lohaco.jp.",
      "",
      "Return ONLY structured JSON (no prose) per the schema the system will provide.",
      "If a field is unclear, leave null or an empty list rather than guessing.",
      "",
      `Product to search: ${hints.join(" | ")}`,
      `User focus: ${String(userText || "").trim()}`
    ].join("\n");
  }


  function tryParseJson(jsonLike) {
    try {
      return JSON.parse(jsonLike);
    } catch {
      // try to extract the first {...} block
      const match = String(jsonLike || "").match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch {}
      }
      return null;
    }
  }

  // Trim arrays to keep replies readable
  function listToLine(arr, max = 10) {
    if (!Array.isArray(arr) || !arr.length) return "Not available";
    const view = arr.map(s => String(s).trim()).filter(Boolean);
    return view.length > max ? view.slice(0, max).join(", ") + ", …" : view.join(", ");
  }

  function formatInfoReplyFromJson(j, fallbackLabel = "") {
    if (!j || typeof j !== "object") return null;

    const rp = j.resolvedProduct || {};
    const resolvedLine =
      (rp?.name && (rp?.name !== fallbackLabel))
        ? ` • Resolved: ${rp.name}${rp.size ? ` (${rp.size})` : ""}${rp.brand ? ` — ${rp.brand}` : ""}${rp.note ? ` — ${rp.note}` : ""}\n`
        : "";

    const nutrition = j.nutrition || {};
    const nutrParts = [];
    if (nutrition.servingBasis) nutrParts.push(nutrition.servingBasis);
    if (Number.isFinite(nutrition.energyKcal)) nutrParts.push(`Energy ${nutrition.energyKcal} kcal`);
    if (Number.isFinite(nutrition.proteinG))   nutrParts.push(`Protein ${nutrition.proteinG} g`);
    if (Number.isFinite(nutrition.fatG))       nutrParts.push(`Fat ${nutrition.fatG} g`);
    if (Number.isFinite(nutrition.carbsG))     nutrParts.push(`Carbs ${nutrition.carbsG} g`);
    if (Number.isFinite(nutrition.sugarG))     nutrParts.push(`Sugar ${nutrition.sugarG} g`);
    if (Number.isFinite(nutrition.sodiumMg))   nutrParts.push(`Sodium ${nutrition.sodiumMg} mg`);

    const lines = [
      `1) Allergens: ${listToLine(j.allergens, 8)}`,
      `2) Ingredients: ${listToLine(j.ingredients, 12)}`,
      `3) Nutrition: ${nutrParts.length ? nutrParts.join("; ") : "Not available"}`,
    ];

    if (Array.isArray(j.skincareEffects) && j.skincareEffects.length) {
      lines.push(`4) Effects (skincare): ${listToLine(j.skincareEffects, 6)}`);
    }

    if (Array.isArray(j.notes) && j.notes.length) {
      const nIndex = lines.length + 1;
      lines.push(`${nIndex}) Notes: ${listToLine(j.notes, 8)}`);
    }

    const disclaimer = "Note: Always check the product label; formulations can change.";
    return `${lines.join("\n")}\n${resolvedLine}${disclaimer}`;
  }

  function toPHDate(v) {
    try {
      let d = null
      if (!v) return null
      if (typeof v === "string" || typeof v === "number") d = new Date(v)
      else if (v.toDate) d = v.toDate()
      else if (v.seconds) d = new Date(v.seconds * 1000)
      if (!d || isNaN(d.getTime())) return null
      return d.toLocaleString("en-PH", { hour12: true, timeZone: "Asia/Manila" })
    } catch { return null }
  }

  // Helper: build deterministic order summary text
  function renderOrderReply(order) {
    const lines = []
    lines.push(`Status: ${order.orderStatus || "Processing"}`)
    lines.push(`OrderID: ${order.orderID || "—"}`)

    const placed = toPHDate(order.orderDate)
    if (placed) lines.push(`Date: ${placed}`)

    if (Array.isArray(order.customerOrder) && order.customerOrder.length) {
      lines.push("")
      lines.push("Items Ordered")
      order.customerOrder.forEach(it => {
        const name = it.name || it.productName || "Item"
        const qty = Number(it.quantity || it.qty || 1)
        const price = Number(it.price || 0)
        lines.push(`• ${name} — Qty: ${qty} — ₱${price.toFixed(2)}`)
      })
    }

    const itemsTotal = Array.isArray(order.customerOrder)
      ? order.customerOrder.reduce((a, i) => a + Number(i.price || 0) * Number(i.quantity || i.qty || 0), 0)
      : 0
    const shipping = Number(order.shippingFee || 0)
    const total = Number.isFinite(Number(order.totalAmount))
      ? Number(order.totalAmount)
      : itemsTotal + shipping

    lines.push("")
    lines.push(`Items Subtotal: ₱${itemsTotal.toFixed(2)}`)
    lines.push(`Shipping Fee: ₱${shipping.toFixed(2)}`)
    lines.push(`Total: ₱${total.toFixed(2)}`)
    if (order.paymentProof) lines.push(`Payment Proof: available`)

    return lines.join("\n")
  }

  // --- Context from recent history (last 6 user turns) ---
  function extractContextFromHistory(history = []) {
    const ctx = { hintCategory: null, hintTokens: [], budget: null };
    if (!Array.isArray(history) || history.length === 0) return ctx;

    // Look at the last ~6 user messages for category/taste words and budget
    const recent = history
      .filter(h => (h.role || "").toLowerCase() === "user")
      .slice(-6)
      .map(h => String(h.text || h.content || "").toLowerCase());

    const joined = recent.join(" • ");

    // Budget cues: "under 200", "below 150", "₱250"
    const mUnder = joined.match(/\b(?:under|below|less\s*than)\s*₱?\s*(\d+(?:\.\d+)?)/i);
    if (mUnder) ctx.budget = Number(mUnder[1]);
    if (!ctx.budget) {
      const mPeso = joined.match(/₱\s*(\d+(?:\.\d+)?)/i);
      if (mPeso) ctx.budget = Number(mPeso[1]);
    }

    // Category synonyms (match your Firestore categories)
    const setIfEmpty = (v) => { if (!ctx.hintCategory) ctx.hintCategory = v; };

    if (/\b(chip|chips|snack|snacks|cracker|crisps)\b/i.test(joined)) setIfEmpty("snacks");
    if (/\b(drink|drinks|beverage|beverages|juice)\b/i.test(joined)) setIfEmpty("juice & beverage");
    if (/\b(chocolate|cocoa)\b/i.test(joined)) setIfEmpty("snacks");
    if (/\b(beauty|cosmetics|skin\s*care|skincare|mask|lotion|soap)\b/i.test(joined)) setIfEmpty("beauty & cosmetics");
    if (/\b(coffee|matcha|tea)\b/i.test(joined)) setIfEmpty("juice & beverage"); // beverages bucket

    // A few taste/style tokens (used as loose search terms)
    const tasteTokens = [];
    if (/\bdark\b/.test(joined)) tasteTokens.push("dark");
    if (/\bspicy\b/.test(joined)) tasteTokens.push("spicy");
    if (/\bsalty\b/.test(joined)) tasteTokens.push("salty");
    if (/\bsweet\b/.test(joined)) tasteTokens.push("sweet");
    if (/\bumami\b/.test(joined)) tasteTokens.push("umami");
    if (/\bmatcha\b/.test(joined)) tasteTokens.push("matcha");
    if (/\bgluten\s*free|gluten-free\b/.test(joined)) tasteTokens.push("gluten");
    if (/\bmilk|dairy|lactose\b/.test(joined)) tasteTokens.push("milk");
    ctx.hintTokens = tasteTokens;

    return ctx;
  }

  // DB-only reply builders (no LLM)
  function _peso(n) {
    const v = Number(n || 0);
    return isFinite(v) ? `₱${v}` : "₱0";
  }

  function renderSearchReply(products, query = "") {
    if (!products || !products.length) {
      return {
        reply:
          "I couldn't find exact matches. Could you be more specific?\n" +
          "• Chocolate bars (dark, milk, white)\n" +
          "• Chocolate drinks\n" +
          "• Chocolate-covered snacks\n" +
          "• Baking chocolate",
        products: [],
        totalFound: 0
      };
    }

    const lines = products.slice(0, 6).map(p => {
      const price = p.discountedPrice ? _peso(p.discountedPrice) : _peso(p.price);
      const was = p.discountedPrice ? ` (was ${_peso(p.price)})` : "";
      const stk = Number(p.stock || 0) > 0 ? "— in stock" : "— out of stock";
      return `• ${p.name || p.productName} — ${price}${was} ${stk}`;
    });

    const title = query ? `"${query}":` : ``;
    return {
      reply: `${title}\n${lines.join("\n")}`,
      products: products.slice(0, 6),
      totalFound: products.length
    };
  }

  function renderBrowseReply(products, label) {
    if (!products || !products.length) {
      return {
        reply: `No ${label} found right now. Want me to show other categories?`,
        products: [],
        totalFound: 0
      };
    }
    const lines = products.slice(0, 6).map(p => {
      const price = p.discountedPrice ? _peso(p.discountedPrice) : _peso(p.price);
      const was = p.discountedPrice ? ` (was ${_peso(p.price)})` : "";
      return `• ${p.name || p.productName} — ${price}${was}`;
    });
    return {
      reply: `Current ${label}:\n${lines.join("\n")}`,
      products: products.slice(0, 6),
      totalFound: products.length
    };
  }


  export default async function handler(req, res) {
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    if (req.method === "OPTIONS") return res.status(200).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })
    if (!process.env.GOOGLE_API_KEY) return res.status(400).json({ error: "Missing GOOGLE_API_KEY" })

      try {
        // MODIFIED: Remove image-related fields from destructuring here
        let {
          message,
          history = [],
          model = MODEL_CHAT,
          clientContext = null,
          userId = null,
          followupProductHint = "",
          // base64Image and mimeType are no longer received here
        } = req.body || {};
      
        if (!message || typeof message !== 'string' || !message.trim()) {
          return res.status(400).json({ error: "Missing message" });
        }
        
              

        // Try to get Firestore; if credentials are missing, we’ll gracefully degrade
        const { db, err: dbInitErr } = await getAdminDbOrNull();

        if (!db || dbInitErr) {
          console.error("[handler] Database initialization failed:", {
            hasDb: !!db,
            errorMessage: dbInitErr?.message,
            isCredsError: isCredentialsError(dbInitErr),
            env: {
              hasAdminKey: !!process.env.FIREBASE_ADMIN_KEY,
              hasGoogleCreds: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
              nodeEnv: process.env.NODE_ENV
            }
          });
          
          // Return user-friendly error
          return res.status(503).json({
            error: "I'm having trouble reaching our database right now. Please try again in a moment. If this persists, contact support.",
            errorCode: isCredentialsError(dbInitErr) ? "NO_DEFAULT_CREDENTIALS" : "DB_INIT_FAILED",
            debugInfo: process.env.NODE_ENV !== 'production' ? {
              message: dbInitErr?.message,
              hasAdminKey: !!process.env.FIREBASE_ADMIN_KEY
            } : undefined
          });
        }
        
        // optional: probe once (helps you prove prod is connected)
        try {
          await db.collection("products").limit(1).get();
        } catch (probeErr) {
          console.error("Firestore probe failed:", probeErr);
          return res.status(503).json({ error: "Database unreachable" });
        }
        
        // If DB is unavailable due to credentials, let pure CHAT proceed, but short-circuit DB-backed intents
        if (!db && dbInitErr) {
          const incomingText = String(message)
          const previousIntent = history.length > 1 ? history[history.length - 2]?.intent : null;
          const intent = detectIntent(incomingText, previousIntent)
          


            // PATCH: strict intent separation
            const isExplicitFAQ = intent === 'FAQ';
            const isProductInfo = intent === 'INFO';
            const infoKeywordPresent = /allergen|ingredient|nutrition|vegan|halal|gluten|care|storage|how to use/i.test(incomingText);
            const productNamePresent = /conditioner|himawari|almond|soy|snack|milk|pretz|calbee|soup|shampoo|sunflower/i.test(incomingText); // Use your product tokenizer or regex

            const isRecommendation = intent === 'RECOMMEND';
            const isProductSearch = intent === 'SEARCH';

            // Only answer FAQ/INFO if there's a clear question structure AND explicit info/FAQ keyword
            const questionWordPattern = /\b(what|how|which|tell|give|show|list|does|is|are|will|can)\b/i;
            const hasQuestionStructure = questionWordPattern.test(incomingText);

            if ((isProductInfo && productNamePresent) || (infoKeywordPresent && productNamePresent)) {
              // Always prefer INFO intent if info keyword and product are present, even if terse
              // This means "ingredients for Himawari Conditioner" triggers INFO, not product search.
              // Rest of INFO branch as normal...
            }

            // Block FAQ/INFO misfires unless the user is asking an explicit question about product facts or store info
            if ((isProductInfo || isExplicitFAQ) && !hasQuestionStructure) {
              // Route ambiguous statement (e.g., just a product name) to product search or recommendation flow
              const fallbackReply = "Did you want information about this product, or are you looking for something to buy? Please ask specifically, e.g., 'What are the allergens in ...?' or 'Show me ...'";
              return res.json({ intent: 'SEARCH', reply: fallbackReply, products: [], totalFound: 0, needsClarification: true });
            }

            // When uncertain, only show recommendations or valid products from database
            if (isRecommendation || isProductSearch) {
              // Validate Gemini/LLM responses strictly, fallback to your own deterministic product/buildProductContext code if any hallucination or unknown product names are detected
              // (This logic is already present near strictValidateProductReply and buildDeterministicProductList)
            }
        
          if (intent !== "CHAT") {
            // Typed, user-safe error – the client can map this to a friendly message
            return res.status(503).json({
              error: "Service temporarily unavailable.",
              errorCode: isCredentialsError(dbInitErr) ? "NO_DEFAULT_CREDENTIALS" : "DB_INIT_FAILED"
            });
          }
        
          // For small talk, call Gemini without product context (so the chat still works)
          const reply = await callGemini(model, SystemRules, history, incomingText, /* clientContext */ []);
          return res.json({ intent: "CHAT", reply });
        }

        
        // Detect intent with context from last turn
        const lastIntent = history.length > 1 ? history[history.length - 2]?.intent : null;
        const rawIntent = detectIntent(message, lastIntent);

        

        
        
        // === FAQ with Simang-Chan personality ===
        // === FAQ with Simang-Chan personality ===
        const looksLikeQuestion = /\b(do|does|can|how|what|when|where|why|is|are|will|would|could|should)\b/i.test(message);
        
        if (looksLikeQuestion && rawIntent === "CHAT") {
          const faqMatch = findFAQMatch(message);
          if (faqMatch) {
            // Route through Gemini for personality consistency
            const prompt = [
              `User asked: "${message}"`,
              ``,
              `Core answer: ${faqMatch}`,
              ``,
              `Rewrite this in Simang-Chan's warm, bubbly style:`,
              `- Keep the same facts and essence - DO NOT change the information`,
              `- Add 1 appropriate emoji at the start`,
              `- Use Filipino-English mix naturally if it feels right (Uy! Ganun?! Sige!)`,
              `- Stay brief: 2-3 sentences max`,
              `- NO markdown symbols like *** or ___`,
              `- DO NOT recommend products unless the original answer does`,
              `- Do NOT add product names, prices, or availability under any circumstance`
            ].join("\n");
            
            const aiReply = await callGemini(
              "gemini-2.0-flash",
              SystemRules,
              history.slice(-4),
              prompt,
              ""
            );
            
            return res.json({
              intent: "FAQ",
              reply: normalizeModelReply(aiReply),
              products: [],
              totalFound: 0
            });
          }
        }
        
        const intent = rawIntent;

      switch (intent) {
        case "SEARCH": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage);
          const userIsEnglish = !isTaglish(userMessage); 
          const filters = extractFilters(message);
          let tokens;
          try {
            // Only trust qTokens if it's small and clearly intentional; otherwise re-tokenize from the user's message.
            if (Array.isArray(filters.qTokens) && filters.qTokens.length > 0 && filters.qTokens.length <= 8) {
              tokens = filters.qTokens;
            } else if (typeof tokenizeQuery === "function") {
              tokens = tokenizeQuery(message);
            } else {
              tokens = String(message || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            }
          } catch {
            tokens = [];
          }
          if (!Array.isArray(tokens)) tokens = [];

          filters.qTokens = tokens;

          const keyTokens = tokens.filter(t => !STOP_WORDS.has(t));

          // Detect price-only queries (e.g., "Under ₱300 products")
          const genericProductTerms = new Set(["products","items","choices","options","things"]);
          const priceWords = new Set(["php","peso","pesos","₱","under","below","less","over","above","more","greater","than","at","least","minimum","max","maximum","budget","cheapest","affordable"]);
          const meaningfulTokens = keyTokens.filter(t => !genericProductTerms.has(t) && !priceWords.has(t) && !/^\d+$/.test(t));
          const isPriceOnlyQuery = (filters.maxPrice != null || filters.minPrice != null) && meaningfulTokens.length === 0;

          // **NEW: Detect category-only queries (e.g., "Snacks", "Coffee")**
          const isCategoryOnlyQuery = filters.category && keyTokens.length <= 2 && !filters.maxPrice;

          if (!filters.category && keyTokens.length && !isPriceOnlyQuery) {
            filters.nameOnly = true;
          }

          const { followupProductHint = "" } = req.body || {};
          let effectiveQuery = (isPriceOnlyQuery || isCategoryOnlyQuery) ? "" : message;

          if (isPriceOnlyQuery) {
            console.log(`[SEARCH] Price-only query detected. maxPrice: ${filters.maxPrice}`);
          }

          if (isCategoryOnlyQuery) {
            console.log(`[SEARCH] Category-only query detected. category: ${filters.category}`);
          }

        
          // ✅ ENHANCED: Detect follow-ups more aggressively
          const isFollowup = isPronounFollowup(message);
          
          // If user said "that/it" OR taste/variant word, prepend the last focus product
          if (isFollowup && followupProductHint) {
            effectiveQuery = `${followupProductHint} ${message}`;
            console.log(`[SEARCH] Follow-up detected. effectiveQuery: "${effectiveQuery}"`);
          }
        
          // Search products from DB
          let products = await searchProducts(db, effectiveQuery, filters);

          // **NEW: If price-only or category-only query returns 0, fetch ALL and filter client-side**
          if (products.length === 0 && (isPriceOnlyQuery || isCategoryOnlyQuery)) {
            console.log(`[SEARCH] Zero results for broad query. Fetching ALL products...`);
            
            const allSnap = await db.collection("products").limit(1000).get(); // Increased limit
            const allProducts = [];
            
            allSnap.forEach(doc => {
              const d = doc.data() || {};
              const p = {
                id: doc.id,
                name: d.productName || d.name || doc.id,
                price: Number(d.price || 0),
                discountedPrice: d.discountedPrice ? Number(d.discountedPrice) : null,
                category: d.category || "",
                stock: Number(d.stock || 0),
                description: d.description || "",
                imageUrl: d.imageUrl || "",
                isNewArrival: Boolean(d.isNewArrival),
                isDiscountEnabled: Boolean(d.isDiscountEnabled)
              };
              
              // Apply filters manually
              const effPrice = p.discountedPrice ?? p.price;
              
              // FIXED: Price filter should be <= for "under"
              if (filters.maxPrice != null && effPrice > filters.maxPrice) return;
              if (filters.minPrice != null && effPrice < filters.minPrice) return;
              
              // Category filter (case-insensitive, fuzzy)
              if (filters.category) {
                const normalizedCategory = normalizeText(p.category);
                const filterCategory = normalizeText(filters.category);
                if (!normalizedCategory.includes(filterCategory)) return;
              }
              
              // Stock filter
              if (filters.inStock && p.stock <= 0) return;
              
              // Sale/new filters
              if (filters.onSale && !isOnSaleNow(p)) return;
              if (filters.newArrival && !p.isNewArrival) return;
              
              allProducts.push(p);
            });
            
            // Sort by stock, then price
            allProducts.sort((a, b) => {
              if (a.stock > 0 && b.stock <= 0) return -1;
              if (a.stock <= 0 && b.stock > 0) return 1;
              const pa = a.discountedPrice ?? a.price;
              const pb = b.discountedPrice ?? b.price;
              return pa - pb;
            });
            
            products = allProducts.slice(0, 10); // Return top 10
            console.log(`[SEARCH] Manual filter returned ${products.length} products for maxPrice ${filters.maxPrice}.`);
          }
        
          // --- Start Change: Enhanced Fallback Chain ---
          let fallbackProducts = [];
          if (!products.length) {
            console.log(`[SEARCH] Initial search failed for "${effectiveQuery}". Trying loose search...`);
            // 1. Try loose 'includes' search first
            fallbackProducts = await searchProductsLoose(db, effectiveQuery);

            if (!fallbackProducts.length) {
              console.log(`[SEARCH] Loose search failed for "${effectiveQuery}". Trying prefix search...`);
              // 2. If still no hits, try prefix search (name-only logic)
              // Pass original filters to prefix search
              fallbackProducts = await searchProductsPrefix(db, effectiveQuery, filters);
              if(fallbackProducts.length) {
                console.log(`[SEARCH] Prefix search succeeded for "${effectiveQuery}".`);
              } else {
                console.log(`[SEARCH] Prefix search failed for "${effectiveQuery}".`);
              }
            } else {
              console.log(`[SEARCH] Loose search succeeded for "${effectiveQuery}".`);
            }
          }

          const finalProducts = products.length ? products : fallbackProducts;
          // --- End Change ---

          // Check if user asked for recommendations
          const askedForRecs = /\b(recommend|suggest|recommendation)s?\b/i.test(String(message));

          // --- Start Change: Use finalProducts ---
          if (!finalProducts.length && askedForRecs) {
          // --- End Change ---
            const recs = await getRecommendations(db, { userId, msgFilters: filters, limit: 12 });
            if (recs.length) {
              const reply = buildDeterministicProductList(recs, "I couldn't find that, but here are some recommendations:");
              return res.json({
                intent: "RECOMMEND", // Change intent if falling back to recs
                reply,
                products: recs.slice(0, 6),
                totalFound: recs.length
              });
            }
          }

          // ✅ ENHANCED: Decide if we should suppress any descriptive text and show products only
          const wantsResultsOnly = (() => {
            const q = String(userMessage || "").toLowerCase().trim();
            const wc = q.split(/\s+/).filter(Boolean).length;

            // Generic follow-ups ("what's available", "show me products", etc.)
            const generic =
              /\b(what'?s\s*available|show(\s+me)?(\s+more)?\s+(products|items)|products|items|choices|options)\b/i.test(q);

            // Taste/variant pings (EN + Tagalog)
            const taste =
              /\b(matcha|green\s*tea|sweet|tamis|matamis|salty|maalat|spicy|maanghang|umami|chocolate|chewy|fruity|sana|gusto|available)\b/i.test(q);

            // Very short follow-ups like "matcha", "matcha sana", "available?"
            const ultraShort = wc <= 3;

            // ✅ ADD: Direct follow-up indicator
            return generic || taste || ultraShort || isFollowup;
          })();

          // ✅ CHANGE: If we have products and it's a follow-up, return products ONLY (no intro text)
          if (finalProducts.length && (wantsResultsOnly || isFollowup)) {
            const mainKey = keyTokens[0] || (tokens[0] || "").trim();

            // --- Start Change: Gemini-powered 1-line clarifier (no product names) ---
            let clarifier = "";
            try {
              const priceHint = filters.minPrice != null ? `over ₱${filters.minPrice}` :
                   filters.maxPrice != null ? `under ₱${filters.maxPrice}` : "";
              const term = (priceHint || mainKey || "").slice(0, 24);
              const clarifierPrompt = [
                "Write ONE short, friendly line as a shopping assistant introducing the results below.",
                "Rules:",
                "- No product names, no markdown, no emojis.",
                "- Be natural and human; 10–14 words max.",
                "- If a term is provided, reference it casually (e.g., “for under ₱200”).",
                "",
                `Term (optional): ${term || "(none)"}`,
                "Return only the sentence."
              ].join("\n");

              const aiLine = await callGemini("gemini-2.0-flash", SystemRules, history.slice(-4), clarifierPrompt, "");
              clarifier = normalizeModelReply(aiLine || "");
              if (!clarifier) throw new Error("empty clarifier");
            } catch {
              // Fallback to deterministic copy
              if (isFollowup) {
                clarifier = "Okay, here are options related to that:";
              } else if (mainKey) {
                clarifier = `Here are items matching "${mainKey}":`;
              } else {
                clarifier = "Here are some options:";
              }
            }
            // --- End Change ---

            return res.json({
              intent: "SEARCH",
              reply: clarifier, // Use the short, contextual clarifier
              products: finalProducts.slice(0, 6),
              totalFound: finalProducts.length,
              hideReplyText: false // Show the short clarifier bubble
            });
        }
          
        
          // Build response with DB-only data
          if (finalProducts.length) {
            const isFAQMisdirected = /\b(privacy|policy|shipping|return|payment|contact|support|how\s+do\s+i)\b/i.test(message);
          
            if (isFAQMisdirected) {
              // If the query looks like FAQ but still matched products, show products silently
              return res.json({
                intent: "SEARCH",
                reply: "", // No intro text
                products: finalProducts.slice(0, 6),
                totalFound: finalProducts.length,
                hideReplyText: true
              });
            }

            // **NEW: Category-only query response (show products with friendly intro)**
            if (isCategoryOnlyQuery && filters.category) {
              const useTaglish = isTaglish(message);
              const categoryName = filters.category;
              
              let categoryIntro = "";
              if (useTaglish) {
                categoryIntro = `Uy! Eto yung mga ${categoryName} items natin! ✨`;
              } else {
                categoryIntro = `Here are our ${categoryName} products! ✨`;
              }
              
              const listText = buildDeterministicProductList(finalProducts, "");
              
              return res.json({
                intent: "SEARCH",
                reply: `${categoryIntro}\n${listText}`,
                products: finalProducts.slice(0, 6),
                totalFound: finalProducts.length
              });
            }


          
            
            const searchPrompt = userIsEnglish
              ? "In 1-2 short, lively ENGLISH sentences, reply as Simang-Chan: bubbly, warm, and energetic. Use fun, upbeat language with Simang-Chan's personality, but ENGLISH ONLY—no Taglish, no Filipino. Do not list product names; just warmly encourage browsing. Absolutely do not mention or guess product names, flavors, or brands."
              : (useTaglish
                  ? "In Taglish, Simang-Chan introduces these search results. No product names, just friendly and fun intro. Absolutely do not mention or guess product names, flavors, or brands."
                  : "Simang-Chan in English introduces the search results. No product names, friendly and lively. Absolutely do not mention or guess product names, flavors, or brands."
                );

                let introText = "";
                // Avoid calling Gemini for intro if it's a follow-up (handled above)
                if (!isFollowup && !wantsResultsOnly) {
                    try {
                      introText = await callGemini("gemini-2.0-flash", SystemRules, history.slice(-4), searchPrompt);
                      introText = normalizeModelReply(introText || "");
                    } catch {
                      introText = ""; // Default if LLM fails
                    }
                }

                let listText = "";
                try {
                  // Pass finalProducts to safeDescribe
                  const { text, ok } = await safeDescribeProductsJSON(
                    getGenAIForModel(MODEL_SEARCH),
                    { model: MODEL_SEARCH, products: finalProducts }
                  );
                  listText = ok && text
                    ? text
                    : buildDeterministicProductList(finalProducts, "Here are some options:"); // Use finalProducts
                } catch {
                  listText = buildDeterministicProductList(finalProducts, "Here are some options:"); // Use finalProducts
                }
      
                const replyCombined = introText
                  ? `${introText}\n${listText}`
                  : listText; // If no intro, just show the list
      
                return res.json({
                  intent: "SEARCH",
                  reply: replyCombined,
                  products: finalProducts.slice(0, 6), // Use finalProducts
                  totalFound: finalProducts.length    // Use finalProducts
                });
              } else {
                // **ENHANCED: Different messages for category-only vs. general search**
                let noResultsReply;
                
                if (isCategoryOnlyQuery && filters.category) {
                  const useTaglish = isTaglish(message);
                  const categoryName = filters.category;
                  
                  if (useTaglish) {
                    noResultsReply = `Ay wala pa kami sa ${categoryName} category ngayon! 😅 Pero soon, dadagdagan namin yan! Want to check other categories?`;
                  } else {
                    noResultsReply = `We don't have any ${categoryName} products in stock right now! 😅 But we're adding more soon! Want to check other categories?`;
                  }
                } else if (isPriceOnlyQuery && filters.maxPrice) {
                  noResultsReply = `No products found under ₱${filters.maxPrice} right now. Try a higher budget or browse our categories! 💰`;
                } else {
                  noResultsReply = "I couldn't find exact matches. Try different keywords or browse our categories:\n• Juice & Beverage\n• Kitchen Ingredients\n• Snacks\n• Hygiene\n• Beauty & Cosmetics";
                }
                
                return res.json({
                  intent: "SEARCH",
                  reply: noResultsReply,
                  products: [],
                  totalFound: 0
                });
              }
        }

        // --- DB-only recommendations (no LLM product generation) ---
        case "RECOMMEND": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage); // Already defined
          const userIsEnglish = !useTaglish;       // Already defined
          const ctxHint = extractContextFromHistory(history);
          const filtersFromMsg = extractFilters(message);

          const filters = {
            ...filtersFromMsg,
            category: filtersFromMsg.category || ctxHint.hintCategory || null,
          };
          if (ctxHint.budget && !filters.maxPrice) filters.maxPrice = ctxHint.budget;

          const looseQuery = (ctxHint.hintTokens || []).join(" ");

          const hasContext =
            !!filters.category || !!filters.maxPrice || (ctxHint.hintTokens && ctxHint.hintTokens.length);

          if (hasContext) {
            let recs = [];
            try {
              if (typeof getRecommendations === "function") {
                recs = await getRecommendations(db, {
                  userId,
                  msgFilters: filters,
                  hintTokens: ctxHint.hintTokens || [],
                  limit: 12,
                });
              }
            } catch (_) { }

            if (!recs || !recs.length) {
              recs = await searchProducts(db, looseQuery, { ...filters, inStock: true });
              if (!recs.length && filters.category) {
                recs = await searchProducts(db, "", { category: filters.category, inStock: true });
              }
            }

            if (recs.length) {
              const isFollowup = isPronounFollowup(message);
    
              // --- Start Change: Use CONCISE Deterministic Intro ---
              let introText = "";
              // Only add a very short intro if it's NOT a follow-up request
              if (!isFollowup) {
                  if (useTaglish) {
                      // Shorter Taglish intro
                      introText = "Uy! Eto mga suggestions ko para sayo! ✨";
                  } else {
                      // Shorter English intro
                      introText = "Sure thing! Check out these recommendations! ✨";
                  }
              }
              // --- End Change ---
    
              // Generate the product list using composeIntroAndBlurbs.
              // We will modify composeIntroAndBlurbs itself (in next patch)
              // to ensure its fallback list builder doesn't add a prefix.
              // We still pass isFollowup=true to prevent composeIntroAndBlurbs
              // from trying to generate its *own* intro via LLM.
              const replyBody = await composeIntroAndBlurbs({
                introPrompt: "",
                products: recs,
                model: MODEL_SEARCH,    // ← Pro for blurbs
                history,
                isFollowup: true
              });
    
              // Combine deterministic intro (if applicable) with the product list/blurbs
              const finalReply = introText ? `${introText}\n${replyBody}` : replyBody;
    
              return res.json({
                intent: "RECOMMEND",
                reply: finalReply, // Use the combined reply
                products: recs.slice(0, 6),
                totalFound: recs.length
              });
            }

            // No recs found (logic remains the same)
            return res.json({
              intent: "RECOMMEND",
              reply:
                "I couldn't find good matches for that right now. Want me to check other categories or a different budget?",
              products: [],
              totalFound: 0,
            });
          }

          // No context provided (logic remains the same)
          const reply =
            "Got it! What are you in the mood for today?\n" +
            "• Snacks (chips, chocolate, cookies)\n" +
            "• Juice & Beverage (tea, coffee, matcha)\n" +
            "• Beauty & Cosmetics (skincare, masks)\n" +
            "You can also add a budget like “under ₱200”.";
          return res.json({ intent: "RECOMMEND", reply, products: [], totalFound: 0 });
        } // End RECOMMEND case
        
    
        // --- DB-only browse helpers (stay deterministic; optional but common) ---
        case "BROWSE_SALE": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage);
          const userIsEnglish = !isTaglish(userMessage);
        
          
          const saleItemsRaw = await searchProducts(db, "", { onSale: true, inStock: true });
          const saleItems    = saleItemsRaw.filter(isOnSaleNow);

          if (saleItems.length) {
            const salePrompt = userIsEnglish
              ? "In 1-2 lively ENGLISH sentences, reply as Simang-Chan: enthusiastic, warm, and friendly, but ENGLISH ONLY—no Taglish or Filipino. Do not mention product names; just encourage the user to browse sales."
              : (useTaglish
                  ? "In Taglish, as Simang-Chan, get users hyped for these sale items! Keep it friendly and fun, but no naming of products."
                  : "In English, Simang-Chan gives a short, lively welcome for these sale items. Use Uy! or similar for flavor, no product names, just warm encouragement to browse."
                );

            const reply = await composeIntroAndBlurbs({
              introPrompt: salePrompt,
              products: saleItems,
              model,
              history,
              listMode: "none",
              isFollowup: false
            });

            return res.json({
              intent: "BROWSE_SALE",
              reply,
              products: saleItems.slice(0, 6),
              totalFound: saleItems.length
            });
          }

          return res.json({
            intent: "BROWSE_SALE",
            reply: "No sale items right now. Want me to show other categories?",
            products: [],
            totalFound: 0
          });
        }
        
            
    
        // BROWSE_NEW
        case "BROWSE_NEW": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage);
          const userIsEnglish = !useTaglish;

          const newItems = await searchProducts(db, "", { newArrival: true, inStock: true });
          if (newItems.length) {
            const newPrompt = userIsEnglish
              ? "In 1-2 lively ENGLISH sentences, Simang-Chan cheerfully welcomes the user to new arrivals—full personality, ENGLISH ONLY, no Taglish, no Filipino, no product names. Just encourage discovery!"
              : (useTaglish
                  ? "In Taglish, Simang-Chan excites the user about new arrivals. Friendly, fun, no product names."
                  : "Simang-Chan in English welcomes the user to new arrivals. No product names, friendly and lively."
                );

            const reply = await composeIntroAndBlurbs({ introPrompt: newPrompt, products: newItems, model, history, listMode: "none" });


            return res.json({
              intent: "BROWSE_NEW",
              reply,
              products: newItems.slice(0, 6),
              totalFound: newItems.length
            });
          }

          return res.json({
            intent: "BROWSE_NEW",
            reply: "No new arrivals at the moment. Want to browse other categories?",
            products: [],
            totalFound: 0
          });
        }
      
      

        case "AVAILABILITY": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage);
          const userIsEnglish = !isTaglish(userMessage);

          // First try: in-stock only (current behavior)
          const products = await searchProducts(db, message, { inStock: true });
          const avail = products.filter(p => p.stock > 0);

          if (avail.length) {
            const availPrompt = userIsEnglish
              ? "In 1-2 lively ENGLISH sentences, reply as Simang-Chan confirming these items are in stock, in her signature bubbly, friendly style—strictly ENGLISH, no Taglish or Filipino. No product names, just Simang-Chan's warm assurance."
              : (useTaglish
                  ? "In Taglish, Simang-Chan assures the user these items are in stock. No product names, barkada flavor allowed."
                  : "Simang-Chan in English confirms the items are available. No product names, friendly and lively."
                );

            const reply = await callGemini("gemini-2.0-flash", SystemRules, history.slice(-4), availPrompt);
            return res.json({
              intent: "AVAILABILITY",
              reply,
              products: avail.slice(0, 6),
              totalFound: avail.length
            });
          }

          // ✅ Fallback: if nothing is in stock, show RELATED items (even if OOS)
          const related = await searchProducts(db, message, {}); // no inStock filter
          if (related.length) {
            // Short, deterministic copy so UI always has a carousel to render
            const list = buildDeterministicProductList(
              related,
              "I didn’t see in-stock items for that right now, but here are related options (some may be out of stock):"
            );
            return res.json({
              intent: "AVAILABILITY",
              reply: list,
              products: related.slice(0, 6),
              totalFound: related.length,
              // don’t hide reply text—let the list show above the carousel
              hideReplyText: false
            });
          }

          // Nothing at all
          return res.json({
            intent: "AVAILABILITY",
            reply: "No matching products currently in stock. Would you like to:\n• Browse other categories\n• See similar available products",
            products: [],
            totalFound: 0
          });
        }
  

        
        
        //start
        case "COMPARE": {
          const pair = parseComparePair(message);
          if (pair && pair.length === 2) {
            const [leftQ, rightQ] = pair;
            const [left, right] = await Promise.all([
              findTopProduct(db, leftQ),
              findTopProduct(db, rightQ)
            ]);
            if (left && right) {
              // Use concise conversational comparison
              const reply = await buildConversationalComparison(left, right, model);
              return res.json({
                intent: "COMPARE",
                reply,
                products: [left, right],
                totalFound: 2,
                comparison: true
              });
            }
            // One or both not found
            if (left || right) {
              const product = left || right;
              const missingQ = left ? rightQ : leftQ;
              return res.json({
                intent: "COMPARE",
                reply: `I found "${product.name}" but couldn't find "${missingQ}" in our catalog. Please check the product name or browse our available items.`,
                products: [product],
                totalFound: 1,
                comparison: false
              });
            }
          }
          // Generic fallback
          const products = await searchProducts(db, message);
          if (products.length >= 2) {
            const reply = buildDeterministicProductList(
              products.slice(0, 2),
              "Here are products you might want to compare:"
            );
            return res.json({
              intent: "COMPARE",
              reply,
              products: products.slice(0, 2),
              comparison: true
            });
          } else {
            return res.json({
              intent: "COMPARE",
              reply: "I need at least 2 products from our catalog to compare. Try asking like 'compare Product A vs Product B' using items we have in stock.",
              products: [],
              comparison: false
            });
          }
        }      
        
        

        // Category browse - unchanged except code style
        case "BROWSE": {
          try {
            // 1. Get categories from admin settings (dynamic, not hardcoded)
            const settingsSnap = await db.collection("admin").doc("settings").get();
            const storeCategories = settingsSnap.exists 
              ? (settingsSnap.data()?.store?.categories || [])
              : [];
            
            if (!storeCategories.length) {
              return res.json({
                intent: "BROWSE",
                reply: "We're setting up our categories right now. Check back soon! 🎌",
                categories: [],
                products: [],
                totalFound: 0
              });
            }
            
            // 2. For each category, check if it has products (skip empty categories)
            const categoriesWithProducts = [];
            const allProducts = [];
            const seenCategories = new Set(); // ADDED: Prevent duplicates

            for (const categoryName of storeCategories) {
              // ADDED: Skip if already processed
              if (seenCategories.has(categoryName)) continue;
              seenCategories.add(categoryName);
              
              const categoryProducts = await searchProducts(db, "", {
                category: categoryName,
                inStock: true
              });
              
              if (categoryProducts.length > 0) {
                categoriesWithProducts.push(categoryName);
                // Take top 2 products from each category for variety
                allProducts.push(...categoryProducts.slice(0, 2));
              }
            }
            
            if (categoriesWithProducts.length === 0) {
              return res.json({
                intent: "BROWSE",
                reply: "We're still stocking up! Check back soon for our full catalog. 🌸",
                categories: [],
                products: [],
                totalFound: 0
              });
            }
            
            // 3. Generate friendly intro
            const userMessage = String(message || "");
            const useTaglish = isTaglish(userMessage);
            const categoryPrompt = useTaglish
              ? "In Taglish, Simang-Chan lists available categories. Friendly, 1-2 sentences, no product names."
              : "In 1-2 friendly English sentences, Simang-Chan introduces our product categories. No product names, just warm encouragement.";
            
            let intro = "";
            try {
              intro = await callGemini("gemini-2.0-flash", SystemRules, history.slice(-4), categoryPrompt, "");
              intro = normalizeModelReply(intro || "");
            } catch {
              intro = useTaglish 
                ? "Uy! Eto yung mga categories natin! ✨"
                : "Here are our available categories! ✨";
            }
            
            // 4. Build category list
            const categoryList = categoriesWithProducts
              .map(cat => `🏷️ ${cat}`)
              .join("\n");
            
            const finalReply = `${intro}\n\n${categoryList}`;
            
            return res.json({
              intent: "BROWSE",
              reply: finalReply,
              categories: categoriesWithProducts,
              products: allProducts.slice(0, 6), // Show sample products
              totalFound: allProducts.length
            });
          } catch (error) {
            console.error("[BROWSE] Error:", error);
            return res.json({
              intent: "BROWSE",
              reply: "I'm having trouble loading our categories right now. Please try again in a moment! 🙏",
              categories: [],
              products: [],
              totalFound: 0
            });
          }
        }

        // Formatting helpers - streamline and keep safe
        function tidyLine(label, raw, fallback = "Unknown") {
          const txt = String(raw || "").trim();
          if (!txt) return `${label}: ${fallback}`;
          // Strip markdown symbols, collapse whitespace, cap length
          const cleaned = txt.replace(/[*_`#+]/g, "").replace(/\s+/g, " ").trim();
          return `${label}: ${cleaned.slice(0, 160)}`;
        }

        function collapseToFiveNumberedLines(modelText) {
          if (!modelText) return null;
          const lines = String(modelText).replace(/\r/g, "").split("\n").map(s => s.trim()).filter(Boolean);
          const numbered = lines.filter(l => /^\d+\)/.test(l)).slice(0, 5);
          if (numbered.length >= 2) return numbered.join("\n");

          // Heuristic extraction, streamlined
          const joined = lines.join(" ");
          const allergens = joined.match(/allergen[s]?:?\s*([^.;]+)/i)?.[1];
          const ingredients = joined.match(/ingredient[s]?:?\s*([^.;]+)/i)?.[1];
          const nutrition = joined.match(/nutrition|nutritional?:?\s*([^.;]+)/i)?.[1];
          const effects = joined.match(/effect[s]?\s*([^.;]+)/i)?.[1];
          const notes = joined.match(/note[s]?:?\s*([^.;]+)/i)?.[1];

          const out = [];
          out.push(tidyLine("1) Allergens", allergens));
          out.push(tidyLine("2) Ingredients", ingredients));
          out.push(tidyLine("3) Nutrition", nutrition));
          if (effects) out.push(tidyLine("4) Effects (skincare)", effects));
          if (notes) out.push(tidyLine(`${out.length + 1}) Notes`, notes));
          return out.join("\n");
        }
        

        case "INFO": {
          // Fast path: message-only cache key to short-circuit immediately
          const msgOnlyKey = _normKey(["INFO", message].join("|"));
          const lastTurnText =
            Array.isArray(history) && history.length
              ? (history[history.length - 1]?.text || history[history.length - 1]?.content || "")
              : message;
          const cacheKey = _normKey(["INFO", "TOP", lastTurnText, "ID"].join("|"));
          const cachedMsg =
              (await getCachedAnswer(db, { intent: "INFO", key: msgOnlyKey }))
           || (await getCachedAnswer(db, { intent: "INFO", key: cacheKey }));

          if (cachedMsg?.reply) {
            return res.json({ intent: "INFO", reply: cachedMsg.reply, products: cachedMsg.products?.slice(0,3) || [] });
          }
        
          // === CRITICAL: Double-check that this isn't a FAQ or SEARCH misdirection ===
          const looksLikeQuestion = /\b(do|does|can|how)\b/i.test(message);
          const hasFAQTerm = /\b(shipping|payment|return|policy|delivery|warranty|contact|support)\b/i.test(message);
          
          if (looksLikeQuestion && hasFAQTerm) {
            // This should have been FAQ, redirect to CHAT
            const faqMatch = findFAQMatch(message);
            if (faqMatch) {
              const prompt = [
                `User asked: "${message}"`,
                ``,
                `Core answer: ${faqMatch}`,
                ``,
                `Rewrite this in Simang-Chan's warm, bubbly style:`,
                `- Keep the same facts and essence`,
                `- Add 1 appropriate emoji at the start`,
                `- Stay brief: 2-3 sentences max`,
                `- NO markdown symbols`,
                `- DO NOT recommend products`
              ].join("\n");
              
              const aiReply = await callGemini(
                "gemini-2.0-flash",
                SystemRules,
                history.slice(-4),
                prompt,
                ""
              );
              
              return res.json({
                intent: "FAQ",
                reply: normalizeModelReply(aiReply),
                products: [],
                totalFound: 0
              });
            }
          }
        
          // === DISAMBIGUATION: If message has BOTH info keyword AND product name, clarify ===
          const infoKeywordPresent = /\b(allergen|ingredient|nutrition|vegan|halal|gluten|care|storage)\b/i.test(message);
          const productNamePresent = /\b(mix|pancake|chocolate|chip|drink|snack|candy|latte|coffee|tea|juice)\b/i.test(message);
          const hasQuestionWord = /\b(what|which|show|tell|give|list)\b/i.test(message);
          
          // If user just said "pancake mix allergens" without "what are" or "tell me"
          if (infoKeywordPresent && productNamePresent && !hasQuestionWord) {
            // Ambiguous - show products first, then ask what they want to know
            const matches = await searchProducts(db, message);
            
            if (matches.length > 0) {
              const clarifyReply = [
                `I found ${matches.length} products matching "${message}". Which specific information do you need?`,
                ``,
                `💡 You can ask:`,
                `• "What are the allergens?"`,
                `• "Show me the ingredients"`,
                `• "Nutrition facts?"`,
                `• "How to use it?"`
              ].join("\n");
              
              return res.json({
                intent: "SEARCH",
                reply: clarifyReply,
                products: matches.slice(0, 6),
                totalFound: matches.length,
                needsClarification: true
              });
            }
          }
        
          // 1) Find product
          let products = [];
          const { followupProductHint = "" } = req.body || {};
          
          const isProductAnswer = 
            message.trim().split(/\s+/).length <= 5 && 
            !message.toLowerCase().match(/\b(show|find|search|track|compare)\b/);
          
          if (isProductAnswer && followupProductHint) {
            products = await searchProducts(db, followupProductHint + " " + message);
          } else if (isPronounFollowup(message) && followupProductHint) {
            products = await searchProducts(db, followupProductHint);
          } else {
            products = await searchProducts(db, message);
          }
        
          const top = products[0] || null;
          
          if (!top) {
            const reply = await callGemini(
              "gemini-2.0-flash",
              SystemRules,
              [],
              `User asked: "${message}". We couldn't find that product. Reply warmly in 1-2 sentences suggesting they try a different name or browse categories.`,
              ""
            );
            return res.json({
              intent: "INFO",
              reply: normalizeModelReply(reply),
              products: []
            });
          }
        
          // 2) Parse what user specifically wants
          const wants = parseInfoRequest(message);
          
          // 3) Check cache first
          
          const cached = await getCachedAnswer(db, { intent: "INFO", key: cacheKey });
          if (cached?.reply) {
            return res.json({ 
              intent: "INFO", 
              reply: cached.reply, 
              products: products.slice(0, 6) 
            });
          }
        
          // 4) Get full product from Firestore
          const docRef = await db.collection("products").doc(top.id).get();
          const fullProduct = docRef.exists ? docRef.data() : top;
          const productName = fullProduct.productName || fullProduct.name;
          
          // 5) Get DB fields
          const dbInfo = {
            allergens: fullProduct.allergens || null,
            ingredients: fullProduct.ingredients || null,
            nutrition: fullProduct.nutrition || null,
            dietaryTags: Array.isArray(fullProduct.dietaryTags) ? fullProduct.dietaryTags : [],
            countryOfOrigin: fullProduct.countryOfOrigin || "Japan",
            careInstructions: fullProduct.careInstructions || null,
            howToUse: fullProduct.howToUse || null
          };
          
          // 6) Check if needs web enrichment for MISSING fields only
          const wantsFacts =
            wants.wantsAllergens ||
            wants.wantsIngredients ||
            wants.wantsNutrition ||
            wants.wantsCare ||
            wants.wantsDietary;

            let webJson = null;
            let webSources = [];

            if (wantsFacts) {
              try {
                const factsQuestion = buildFactsQuestion(fullProduct, message);

                // Pass 1 (broad)
                const grounded = await withSoftTimeout(
                  groundedFactsJSON({ question: factsQuestion, model: MODEL_INFO }),
                  6000
                );

                if (!grounded?.timeout && grounded?.json) {
                  webJson = grounded.json;
                  webSources = grounded.citations || [];
                }

                // Pass 2 (focused) only if needed
                if (!webJson && !grounded?.timeout) {
                  const focusBits = [
                    wants.wantsIngredients ? "ingredients" : "",
                    wants.wantsAllergens ? "allergens" : "",
                    wants.wantsNutrition ? "nutrition" : ""
                  ].filter(Boolean).join(", ");

                  const retryQ = buildFactsQuestion(
                    fullProduct,
                    `Return ONLY ${focusBits}. Prefer manufacturer/brand pages. JSON only.`
                  );

                  const grounded2 = await withSoftTimeout(
                    groundedFactsJSON({ question: retryQ, model: MODEL_INFO }),
                    6000
                  );

                  if (!grounded2?.timeout && grounded2?.json) {
                    webJson = grounded2.json;
                    webSources = grounded2.citations || [];
                  }
                }

                if (webJson) {
                  webJson = await ensureEnglishFacts(getGenAIForModel("gemini-2.0-flash"), webJson, FACTS_RESPONSE_SCHEMA);
                }
              } catch {}
            }

             
          
          // 7) Merge DB + Web JSON and compose a tight answer (no markdown symbols)
          let finalReply;

          if (webJson) {
            // Prefer grounded JSON for factual lines
            const formatted = formatInfoReplyFromJson(webJson, productName);

            // If the user asked for just one facet, show only that facet + disclaimer
            const wantsOnlyAllergen = wants.wantsAllergens && !wants.wantsIngredients && !wants.wantsNutrition && !wants.wantsCare && !wants.wantsDietary;
            const wantsOnlyIngredients = wants.wantsIngredients && !wants.wantsAllergens && !wants.wantsNutrition && !wants.wantsCare && !wants.wantsDietary;
            const wantsOnlyNutrition = wants.wantsNutrition && !wants.wantsAllergens && !wants.wantsIngredients && !wants.wantsCare && !wants.wantsDietary;
            const wantsOnlyCare = wants.wantsCare && !wants.wantsAllergens && !wants.wantsIngredients && !wants.wantsNutrition && !wants.wantsDietary;

            if (wantsOnlyAllergen) {
              const line = formatted.split("\n").find(l => /^\s*1\)\s*Allergens:/i.test(l)) || "1) Allergens: Not available";
              finalReply = `${line}\nAlways check the product label; formulations can change.`;
            } else if (wantsOnlyIngredients) {
              const line = formatted.split("\n").find(l => /^\s*2\)\s*Ingredients:/i.test(l)) || "2) Ingredients: Not available";
              finalReply = `${line}\nAlways check the product label; formulations can change.`;
            } else if (wantsOnlyNutrition) {
              const line = formatted.split("\n").find(l => /^\s*3\)\s*Nutrition:/i.test(l)) || "3) Nutrition: Not available";
              finalReply = `${line}\nAlways check the product label; formulations can change.`;
            } else if (wantsOnlyCare) {
              const care = (Array.isArray(webJson.notes) && webJson.notes.length)
                ? `💡 Care/Usage: ${webJson.notes.slice(0, 4).join(", ")}`
                : "💡 Care/Usage: See product packaging";
              finalReply = `${care}\nAlways check the product label; formulations can change.`;
            } else {
              finalReply = formatted;
            }

            if (webSources.length && process.env.SHOW_FACT_SOURCES === "true") {
              finalReply += `\nSources: ${webSources.map(s => s.domain).join(", ")}`;
            }
          } else {
            // DB-only fallback, keep it short and on-topic
            const parts = [];
            if (wants.wantsAllergens) parts.push(`⚠️ Allergens: ${dbInfo.allergens || "Not listed in our database"}`);
            if (wants.wantsIngredients) parts.push(`📋 Ingredients: ${dbInfo.ingredients || "Not listed in our database"}`);
            if (wants.wantsNutrition) parts.push(`🍱 Nutrition: ${dbInfo.nutrition || "Not listed in our database"}`);
            if (wants.wantsCare) {
              const care = dbInfo.careInstructions || dbInfo.howToUse || "See product packaging";
              parts.push(`💡 Care/Usage: ${care}`);
            }
            if (wants.wantsDietary) {
              parts.push(`Dietary Info: ${dbInfo.dietaryTags.length ? dbInfo.dietaryTags.join(", ") : "None specified"}`);
            }
            if (!parts.length) {
              parts.push(`⚠️ Allergens: ${dbInfo.allergens || "Check label"}`);
              parts.push(`Origin: ${dbInfo.countryOfOrigin}`);
            }
            parts.push("Always check the product label—formulations can change!");
            finalReply = parts.join("\n");
          }

          // 8) Cache for 7 days
          await putCachedAnswer(db, {
            intent: "INFO",
            key: msgOnlyKey,
            reply: finalReply,
            products: products.slice(0,3),
            ttlDays: 7
          });

          await putCachedAnswer(db, {
            intent: "INFO",
            key: cacheKey,
            reply: finalReply,
            products: products.slice(0,3),
            ttlDays: 7
          });

          return res.json({
            intent: "INFO",
            reply: finalReply,
            products: products.slice(0, 5),
            sources: webSources.length && process.env.SHOW_FACT_SOURCES === "true" ? webSources : undefined
          });
        }


        case "TRACK": {
          // Try to extract an OrderID from the free text (supports hyphens)
          const idMatch = String(message).match(/\bORD-[A-Z0-9-]{6,}\b/i)
          const orderId = idMatch ? idMatch[0] : null

          if (!orderId) {
            const reply =
              "Please send your OrderID like “ORD-XXXX-1234”. If you are signed in, you can also open “My Orders” for the latest status."
            return res.json({ intent: "TRACK", reply, products: [], totalFound: 0 })
          }

          // Guest-friendly lookup by orderID field only, no auth required
          const snap = await db.collection("orders").where("orderID", "==", orderId).limit(1).get()
          if (snap.empty) {
            return res.json({
              intent: "TRACK",
              reply: "I could not find an order with that ID. Please check the OrderID and try again.",
              products: [],
              totalFound: 0
            })
          }

          const order = snap.docs[0].data() || {}
          const reply = renderOrderReply(order)

          // Return both human text and structured fields for your UI
          return res.json({
            intent: "TRACK",
            reply,
            order: {
              orderID: order.orderID || null,
              orderStatus: order.orderStatus || "Processing",
              orderDate: order.orderDate || null,
              shippingFee: order.shippingFee ?? null,
              totalAmount: order.totalAmount ?? null,
              paymentProof: order.paymentProof || null,
              customerOrder: Array.isArray(order.customerOrder) ? order.customerOrder : []
            }
          })
        }

        case "COMPLAINT": {
          const userMessage = String(message || "");
          const useTaglish = isTaglish(userMessage);
          
          const comfortMessage = useTaglish
            ? "Ay! I'm really sorry to hear that. 😟 Para ma-handle natin ng maayos ang issue mo, please go to the **Customer Support** link at the bottom of the page. Our team will assist you directly and make sure everything gets resolved!"
            : "I'm really sorry to hear that! 😟 To handle your concern properly, please go to the **Customer Support** link at the bottom of the page. Our team will assist you directly and make sure we resolve this for you!";
          
          return res.json({
            intent: "COMPLAINT",
            reply: comfortMessage,
            products: [],
            totalFound: 0
          });
        }
        

        default: {
          // === FAQ PRIORITY CHECK (before calling Gemini) ===
          const looksLikeQuestion = /\b(do|does|can|how|what|when|where|why|is|are|will|would|could|should)\b/i.test(message);
          
          if (looksLikeQuestion) {
            const faqMatch = findFAQMatch(message);
            if (faqMatch) {
              // Route through Gemini for personality consistency
              const prompt = [
                `User asked: "${message}"`,
                ``,
                `Core answer: ${faqMatch}`,
                ``,
                `Rewrite this in Simang-Chan's warm, bubbly style:`,
                `- Keep the same facts and essence - DO NOT change the information`,
                `- Add 1 appropriate emoji at the start`,
                `- Use Filipino-English mix naturally if it feels right (Uy! Ganun?! Sige!)`,
                `- Stay brief: 2-3 sentences max`,
                `- NO markdown symbols like *** or ___`,
                `- DO NOT recommend products unless the original answer does`,
                `- Do NOT add product names, prices, or availability under any circumstance`
              ].join("\n");
              
              const aiReply = await callGemini(
                "gemini-2.0-flash",
                SystemRules,
                history.slice(-4),
                prompt,
                ""
              );
              
              return res.json({
                intent: "FAQ",
                reply: normalizeModelReply(aiReply),
                products: [],
                totalFound: 0
              });
            }
          }
        
          // No FAQ match - proceed with normal CHAT
          const reply = await callGemini(model, SystemRules, history, message, clientContext)
          return res.json({ intent: "CHAT", reply })
        }
      }
    } catch (e) {
      console.error("geminiChat failed", e)
      return res.status(500).json({ error: e.message || "Server error" })
    }
  }
