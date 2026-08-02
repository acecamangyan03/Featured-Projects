  /* src/pages/api/Chat/imageSearch.js */
  import { GoogleGenerativeAI } from "@google/generative-ai";
  import { Buffer } from 'buffer'; // Needed for fetchImageAsBase64
  import { buildProductContext } from '../../../chatcomponents/chatApi';


  // === Constants ===
  const MODEL_VISION = process.env.GEMINI_MODEL_VISION || "gemini-2.5-flash"; // Or your preferred Vision model
  const API_TIMEOUT_MS = 15000; // Give Vision a bit more time

  // === Gemini Client Setup (Copied from geminiChat.js) ===
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const genAIPro = process.env.GOOGLE_API_KEY_PRO
    ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY_PRO)
    : genAI;

  function getGenAIForModel(modelName = "") {
    const m = String(modelName || "").toLowerCase();
    const isPro = m.includes("-pro"); // Vision often benefits from Pro
    return (isPro && process.env.GOOGLE_API_KEY_PRO) ? genAIPro : genAI;
  }

    // === Shared normalization (matches geminiChat.js) ===
  function normalizeText(s = "") {
    return String(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
      .replace(/[^a-z0-9\s]/g, " ")     // Keep only alphanumeric
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchWithTimeout(url, { timeoutMs = 5000, ...opts } = {}) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
          // Use undici's fetch or node-fetch if in a Node.js env without global fetch
          const fetchFn = typeof fetch === 'undefined' ? (await import('node-fetch')).default : fetch;
          const res = await fetchFn(url, { ...opts, signal: ctrl.signal });
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

  // === Smart Query Builder with Product Type Awareness ===
  function buildSmartQueries(structured) {
    if (!structured || typeof structured !== 'object') return [];
    
    const queries = [];
    const { brand = '', product = '', variant = '', size = '', keywords = [], category = '' } = structured;
    
    const norm = (s) => {
      const cleaned = normalizeText(s);
      return cleaned
        .replace(/(\d+)\s*(pcs?|pieces?|pack|ct|count)/gi, '$1pcs')
        .replace(/(\d+)\s*(g|grams?|gr)/gi, '$1g')
        .replace(/(\d+)\s*(ml|milliliters?)/gi, '$1ml')
        .replace(/(\d+)\s*(oz|ounces?)/gi, '$1oz')
        .replace(/(\d+)\s*(kg|kilos?|kilograms?)/gi, '$1kg')
        .replace(/(\d+)\s*(l|liters?|litres?)/gi, '$1l')
        .replace(/[()[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    
    const b = norm(brand);
    const p = norm(product);
    const v = norm(variant);
    const sz = norm(size);
    const kw = Array.isArray(keywords) ? keywords.map(norm).filter(Boolean) : [];
    
    // ✅ TIER 1: Full product identity (brand + product + variant)
    if (b && p && v) {
      queries.push(`${b} ${p} ${v}`);           // "s&b curry mix golden curry hot"
      if (sz) queries.push(`${b} ${p} ${v} ${sz}`);
    }
    
    // ✅ TIER 2: Brand + Variant (most distinctive)
    if (b && v) {
      queries.push(`${b} ${v}`);                // "s&b golden curry hot"
      if (sz) queries.push(`${b} ${v} ${sz}`);
    }
    
    // ✅ TIER 3: Product + Variant (generic brand)
    if (p && v && v.length >= 5) {
      queries.push(`${p} ${v}`);                // "curry mix golden curry"
    }
    
    // ✅ TIER 4: Brand + Product (broad category)
    if (b && p && p.length >= 4) {
      queries.push(`${b} ${p}`);                // "s&b curry mix"
    }
    
    // ✅ TIER 5: Variant alone (distinctive names only)
    if (v && v.length >= 8) {
      queries.push(v);                          // "golden curry hot"
    }
    
    // ✅ TIER 6: Keywords (fallback)
    if (kw.length >= 2) {
      const bestKeywords = kw.slice(0, 3).join(' ');
      if (bestKeywords.length >= 8) {
        queries.push(bestKeywords);             // "golden curry japanese"
      }
    }
    
    // Deduplicate and filter
    return [...new Set(queries)].filter(q => q.length >= 5);
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
          console.log(`[imageSearch] Fetching remote image URL: ${imageUrl}`);
          const { b64, mime: fetchedMime } = await fetchImageAsBase64(imageUrl);
          return { base64: b64, mime: fetchedMime || mimeType || "image/jpeg" };
      }

      return null; // No valid image source found
  }

  // --- Basic text normalization (copied from geminiChat.js utils if needed) ---
  function _stripJsonFences(s) {
    let t = String(s || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    if (t.toLowerCase().startsWith("json")) t = t.slice(4).trim();
    return t;
  }
  function normalizeModelReply(text) {
    // Add more robust JSON parsing/rendering if the Vision model might return JSON
    return _stripJsonFences(text);
  }
  // --- End text normalization ---


  // === Core Vision Helper (Adapted from geminiChat.js) ===
  async function callGeminiVision(
    model,
    system,
    userText,
    base64Image,
    mimeType = "image/jpeg"
  ) {
    const client = getGenAIForModel(model);
    const m = client.getGenerativeModel({
      model,
      systemInstruction: { parts: [{ text: String(system || "") }] },
    });

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType,
      },
    };

    // Vision model takes an array of parts directly
    const res = await m.generateContent([{ text: userText }, imagePart]);
    return res.response.text();
  }

  // === API Handler ===
  export default async function handler(req, res) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Adjust for production
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!process.env.GOOGLE_API_KEY) return res.status(400).json({ error: "Missing GOOGLE_API_KEY" });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const normalizedImageData = await normalizeIncomingImage(req.body);
      if (!normalizedImageData) {
        return res.status(400).json({ error: "Missing or invalid image data" });
      }
      const { base64: base64Image, mime: mimeType } = normalizedImageData;
    
      if (!base64Image) {
        return res.status(400).json({ error: "Missing image data (base64Image)" });
      }
    
      const { message: userHint = "" } = req.body || {};
    
      // === STEP 1: Call Vision API ===
      const visionPrompt = [
        "You are a product identification expert for a Japanese e-commerce store.",
        "Extract EXACT product details from packaging. Be VERY precise with text on the package.",
        "Return ONLY a JSON object with these fields:",
        '{ "brand": "string", "product": "string", "variant": "string", "size": "string", "category": "string", "keywords": ["string"] }',
        "",
        "CRITICAL EXTRACTION RULES:",
        "- Brand: Extract EXACTLY as shown (e.g., 'KitKat', 'Calbee', 'Nestlé')",
        "- Product: Generic type (e.g., 'Chocolate', 'Chips', 'Candy', 'Drink')",
        "- Variant: Flavor/type EXACTLY from package (e.g., 'Matcha Latte', 'Hot & Spicy', 'Original')",
        "- Size: Extract pack quantity OR weight EXACTLY (e.g., '10pcs', '500g', '12 pack')",
        "- Category: Choose ONE: Snacks, Juice & Beverage, Coffee, Tea, Kitchen Ingredients, Hygiene, Beauty & Cosmetics",
        "- Keywords: 3-5 distinctive search terms from the package",
        "",
        "CRITICAL: Pay attention to:",
        "- Japanese text (ロマンス, 抹茶, etc.) - romanize these",
        "- Color cues for flavors (green = matcha, pink = strawberry, etc.)",
        "- Size indicators (pack count, weight, volume)",
        "- Sub-brands (e.g., 'KitKat Mini' vs 'KitKat Chocolatory')",
        "",
        "Examples:",
        '- KitKat green box with "抹茶ラテ" → {"brand":"KitKat","product":"Chocolate","variant":"Matcha Latte","size":"10pcs","category":"Snacks","keywords":["matcha","green tea","chocolate","wafer","japanese"]}',
        '- Calbee chips red bag → {"brand":"Calbee","product":"Potato Chips","variant":"Hot & Spicy","size":"","category":"Snacks","keywords":["chips","spicy","potato","crispy","savory"]}',
        '- Pigeon baby powder → {"brand":"Pigeon","product":"Baby Powder","variant":"Mild Fragrance","size":"200g","category":"Hygiene","keywords":["baby","powder","gentle","fragrance","skin"]}',
        "",
        userHint ? `User hint: ${userHint}` : "No user hint provided."
      ].join("\n");
    
      console.log("[imageSearch] Calling Vision API...");
      const productDescription = await callGeminiVision(
        MODEL_VISION,
        "You identify products from images with high precision.",
        visionPrompt,
        base64Image,
        mimeType
      );
    
      const normalizedDescription = normalizeModelReply(productDescription || "");
      console.log(`[imageSearch] Vision raw response: "${normalizedDescription}"`);
    
      if (!normalizedDescription) {
        throw new Error("Vision API returned empty description.");
      }
    
      // === STEP 2: Parse JSON ===
      let structuredData = null;
      try {
        const cleaned = normalizedDescription
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/i, "")
          .trim();
        structuredData = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn("[imageSearch] JSON parse failed, using raw text:", parseErr.message);
        structuredData = { raw: normalizedDescription };
      }
    
      // === STEP 3: Build smart search queries ===
      const searchQueries = buildSmartQueries(structuredData);
      console.log(`[imageSearch] Generated ${searchQueries.length} search queries:`, searchQueries);
    
      // === STEP 4: Try each query until we get results (CASCADE) ===
      let productResults = [];
      let successfulQuery = null;

      for (const q of searchQueries) {
        console.log(`[imageSearch] Trying query: "${q}" with category: "${structuredData.category}"`);
        try {
          const found = await buildProductContext(
            q,                          // search term
            null,                       // budget
            structuredData.category,    // ✅ CRITICAL: Pass category to filter results
            false,                      // onSale
            false,                      // newArrivals
            null                        // followupHint
          );
          
          if (found && found.length > 0) {
            productResults = found.slice(0, 6);
            successfulQuery = q;
            console.log(`[imageSearch] ✅ SUCCESS with query: "${q}" (${found.length} results)`);
            break;
          }
        } catch (e) {
          console.warn(`[imageSearch] Query "${q}" failed:`, e?.message);
        }
      }

      // === STEP 4.5: ENHANCED VALIDATION with Category Awareness ===
      if (productResults.length && structuredData) {
        console.log('[imageSearch] 🔍 Validating results against Vision data...');
        
        const brandNorm = normalizeText(structuredData.brand || '');
        const variantNorm = normalizeText(structuredData.variant || '');
        const productNorm = normalizeText(structuredData.product || '');
        const categoryNorm = normalizeText(structuredData.category || '');
        
        // Score each result by how well it matches Vision data
        const scored = productResults.map(p => {
          const nameNorm = normalizeText(p.name || p.productName || '');
          const catNorm = normalizeText(p.category || '');
          let validationScore = 0;
          
          // ✅ CRITICAL: Category mismatch = instant disqualification
          // "Kitchen Ingredients" vs "Tea" = different products entirely
          if (categoryNorm && catNorm) {
            const categoryMatch = catNorm.includes(categoryNorm) || categoryNorm.includes(catNorm);
            if (!categoryMatch) {
              console.log(`[imageSearch] ❌ Category mismatch: "${p.name}" is ${p.category}, expected ${structuredData.category}`);
              return { ...p, _validationScore: -100 }; // Disqualify
            }
            validationScore += 20; // Strong category match bonus
          }
          
          // Brand match (high priority)
          if (brandNorm && nameNorm.includes(brandNorm)) {
            validationScore += 15;
            console.log(`[imageSearch] ✅ Brand match: "${brandNorm}" in "${p.name}"`);
          }
          
          // Variant match (highest priority - the specific flavor/type)
          if (variantNorm) {
            // Split variant into words (e.g., "Golden Curry Hot" -> ["golden", "curry", "hot"])
            const variantWords = variantNorm.split(/\s+/).filter(w => w.length >= 3);
            const matchedWords = variantWords.filter(w => nameNorm.includes(w));
            
            if (matchedWords.length === variantWords.length) {
              validationScore += 30; // All variant words present
              console.log(`[imageSearch] ✅ Full variant match: "${variantNorm}" in "${p.name}"`);
            } else if (matchedWords.length >= Math.ceil(variantWords.length * 0.6)) {
              validationScore += 15; // Partial match (60%+)
              console.log(`[imageSearch] ⚠️ Partial variant match: ${matchedWords.length}/${variantWords.length} words`);
            } else {
              validationScore -= 10; // Penalize poor matches
            }
          }
          
          // Product type match (e.g., "Curry Mix" vs "Tea")
          if (productNorm && nameNorm.includes(productNorm)) {
            validationScore += 10;
          }
          
          return { ...p, _validationScore: validationScore };
        });
        
        // Filter out disqualified products
        const validated = scored.filter(p => p._validationScore > 0);
        
        // Sort by validation score
        validated.sort((a, b) => b._validationScore - a._validationScore);
        
        if (validated.length > 0) {
          productResults = validated.slice(0, 6);
          console.log(`[imageSearch] ✅ Validated ${validated.length} relevant results (filtered ${scored.length - validated.length} unrelated)`);
          
          // Log top 3 for debugging
          validated.slice(0, 3).forEach((p, i) => {
            console.log(`[imageSearch] #${i+1}: "${p.name}" (score: ${p._validationScore})`);
          });
        } else {
          console.log('[imageSearch] ⚠️ No products passed validation, keeping original results');
        }
      }
    
      // === STEP 5: FALLBACK - Category-based recommendations if no exact match ===
      if (!productResults.length && structuredData.category) {
        console.log(`[imageSearch] No exact match, trying category fallback: "${structuredData.category}"`);
        try {
          const categoryResults = await buildProductContext(
            [], // No search terms
            null, // No budget
            structuredData.category, // Just use category
            false, // Not on sale
            false, // Not new arrivals
            null
          );
          
          if (categoryResults && categoryResults.length) {
            productResults = categoryResults.slice(0, 6);
            successfulQuery = `${structuredData.category} (category fallback)`;
            console.log(`[imageSearch] ✅ Category fallback successful (${categoryResults.length} results)`);
          }
        } catch (e) {
          console.warn('[imageSearch] Category fallback failed', e?.message);
        }
      }
    
      // === STEP 6: Format product results for chat ===
      let productModalInfo = null;
      if (productResults.length) {
        productModalInfo = productResults.map(p => ({
          id: p.id,
          name: p.name || p.productName,
          category: p.category,
          price: p.price ?? p.discountedPrice ?? 0,
          imageUrl: p.imageUrl,
          originalPrice: p.originalPrice ?? null,
          isDiscountEnabled: !!p.isDiscountEnabled,
          isNewArrival: !!p.isNewArrival,
          stock: typeof p.stock === 'number' ? p.stock : 0
        }));
      }
    
      // === STEP 7: Return enhanced response ===
      clearTimeout(timeoutId);
      
      const finalQuery = successfulQuery || searchQueries[0] || normalizedDescription;
      
      return res.status(200).json({
        productDescription: finalQuery,
        structured: structuredData,
        alternateQueries: searchQueries,
        products: productModalInfo || [],
        searchStrategy: successfulQuery ? (successfulQuery.includes('fallback') ? 'category_fallback' : 'exact_match') : 'no_results'
      });
    
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("[imageSearch] Vision API call failed:", error?.message || error);
      
      if (error.name === 'AbortError') {
        return res.status(504).json({ error: "Image analysis timed out." });
      }
      
      return res.status(500).json({ 
        error: "Image analysis failed. Please ensure the image shows the product clearly."
      });
    }
  }

  // Add config for increased body size limit if needed (same as geminiChat.js)
  export const config = {
    api: { bodyParser: { sizeLimit: "10mb" } }
  };