/* chatcomponents/chatinterface.js */
import React, { useState, useRef, useEffect } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCommentDots,
  faPaperPlane,
  faTimes,
  faSpinner,
  faHeart,
  faSearch,
  faBox,
  faTag,
  faExclamationCircle,
  faCheckCircle,
  faThumbsUp,
  faThumbsDown,
  faImage, // <-- NEW
  faTimesCircle // <-- NEW
} from "@fortawesome/free-solid-svg-icons";
import { getAuth } from "firebase/auth";
import { sendChat, trackOrder, logFeedback } from "./chatApi";
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

/* ---------- Small gallery for bot product results ---------- */
function ChatProductGallery({ items = [], onOpen }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="ChatCarousel">
      <div className="ChatCarouselTrack">
        {items.slice(0, 8).map((p) => (
          <button
            key={p.id}
            className="ChatCarouselItem"
            onClick={() => onOpen?.(p)}
            title={p.name}
          >
            <div className="ChatCarouselThumb">
              {p.imageUrl ? (
                <img src={p.imageUrl} alt={p.name} loading="lazy" />
              ) : (
                <div className="ChatCarouselPlaceholder" />
              )}
            </div>
              <div className="ChatCarouselInfo">
                <div className="ChatCarouselPrice">
                  <span className="PriceNow">
                    ₱{Number(p.price || 0).toLocaleString()}
                  </span>
                  {p.originalPrice != null ? (
                    <span className="PriceOld">
                      ₱{Number(p.originalPrice || 0).toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */
const GENERIC_FOLLOW_UP =
  /\b(show\s+me|show\s+more|what'?s\s+available|any\s+recommend|recommend|more\s+products|products|items|choices|options)\b/i;
const isGenericFollowUp = (text) =>
  GENERIC_FOLLOW_UP.test(String(text || "").toLowerCase());

/* ---------- Helpers (Same sa Homepage) ---------- */
function mapProductForChat(p) {
  if (!p) return null;
  
  const rawPrice = Number(p.rawPrice || p.price || 0);
  const discountActive = p.isDiscountEnabled === true;
  
  let finalPrice = rawPrice;
  let originalPrice = null;

  if (discountActive) {
    finalPrice = p.discountedPrice != null 
      ? Number(p.discountedPrice) 
      : Math.floor(rawPrice * (1 - (Number(p.manualDiscountPercent || 0) / 100)));
    
    originalPrice = rawPrice;
    
    if (finalPrice >= originalPrice) {
      originalPrice = null;
      finalPrice = rawPrice;
    }
  } else {
    finalPrice = rawPrice;
  }

  return {
    ...p,
    price: finalPrice,
    originalPrice: originalPrice,
    isDiscountEnabled: discountActive && originalPrice != null,
  };
}

function linesFromProducts(arr = []) {
  return arr
    .slice(0, 12)
    .map((p) => {
      const now = p.price ?? p.originalPrice ?? 0;
      const tag = [p.isDiscountEnabled ? "SALE" : null, p.isNewArrival ? "NEW" : null]
        .filter(Boolean)
        .join("/");
      const tags = tag ? ` - ${tag}` : "";
      const stock = Number(p.stock || 0) > 0 ? "✅ in stock" : "❌ out";
      return `• ${p.name} - ₱${Number(now || 0).toLocaleString()} - ${stock} - ${p.category}${tags}`;
    })
    .join("\n");
}

function extractOrderId(text) {
  const m = String(text || "").match(/\bORD-[A-Z0-9-]{6,}\b/i);
  return m ? m[0] : null;
}

function fmtPH(v) {
  try {
    let d = null;
    if (!v) return "";
    if (typeof v === "string" || typeof v === "number") d = new Date(v);
    else if (v && typeof v.toDate === "function") d = v.toDate();
    else if (v && typeof v.seconds === "number") d = new Date(v.seconds * 1000);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleString("en-PH", { hour12: true, timeZone: "Asia/Manila" });
  } catch {
    return "";
  }
}

/* ===================================================================== */

export default function Chats({ onProductClick, onAddToCart, onBuyNow }) {
  const [showSelector, setShowSelector] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isClosingChatbot, setIsClosingChatbot] = useState(false);

  const [messages, setMessages] = useState([
    {
      sender: "bot",
      text:
        "Hi there! I'm Simang-Chan 🌸\n\nI'm here to help you:\n🛍️ Find products in our store\n💰 Compare prices\n🚚 Track your orders\n🎯 Get recommendations\n\nWhat would you like to explore today?",
      timestamp: new Date(),
      type: "welcome",
    },
  ]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [quickReplies, setQuickReplies] = useState([
    "Show me new arrivals",
    "What's on sale?",
    "Track my order",
    "Under ₱300 products",
    "Categories?",
  ]);
  const [lastIntent, setLastIntent] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null); // <-- NEW
  const [lastBotQuestion, setLastBotQuestion] = useState(null); // NEW: Track what bot last asked
  const quickBarRef = useRef(null);
  const [qrDragging, setQrDragging] = useState(false);
  const qrDrag = useRef({ startX: 0, scrollLeft: 0 });

  // For follow-up "add it / buy now"
  const [lastContext, setLastContext] = useState({
    lines: null,
    category: null,
    filters: null,
  });
  const [lastProductHint, setLastProductHint] = useState("");
  const [lastProductData, setLastProductData] = useState(null);
  const [imagePayload, setImagePayload] = useState(null); // <-- NEW

  /* ---------- UI helpers ---------- */
  const scrollToBottom = () =>
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (showChat && inputRef.current) {
      setTimeout(() => inputRef.current.focus(), 100);
    }
  }, [showChat]);

  const addMessage = (msg) =>
    setMessages((prev) => [...prev, { ...msg, timestamp: new Date() }]);

  const openChatbot = () => {
    setShowSelector(false);
    setShowChat(true);
  };
  const closeChatbot = () => {
    setIsClosingChatbot(true);
    setTimeout(() => {
      setShowChat(false);
      setIsClosingChatbot(false);
    }, 250);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const simulateTyping = (duration = 1500) => {
    setIsTyping(true);
    setTimeout(() => setIsTyping(false), duration);
  };

  const sendQuickReply = async (reply) => {
    if (/^go to cart$/i.test(String(reply))) {
      // call parent handler or navigate
      try { await onBuyNow?.({ id: "__cart__" }, 0); } catch {}
      return;
    }
    
    setInput(reply);
    send(reply);
  };


  useEffect(() => {
    const up = () => setQrDragging(false);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchend', up);
    };
  }, []);
  

  const sendFeedback = async (isPositive) => {
    setShowFeedback(false);
    const auth = getAuth();
    const uid = auth.currentUser?.uid || null;
    try {
      await logFeedback({ userId: uid, intent: lastIntent, positive: isPositive });
    } catch {}
    if (!isPositive) {
      addMessage({
        sender: "bot",
        text:
          "Thanks for the feedback! I'm still learning. Could you tell me how I can help you better?",
        type: "feedback",
      });
    }
  };

  const openProductModal = (p) => onProductClick?.(p);

  const getQRScrollEl = () => quickBarRef.current?.getScrollElement?.() || null;

  const onQRMouseDown = (e) => {
    const el = getQRScrollEl();
    if (!el) return;
    setQrDragging(true);
    qrDrag.current.startX = e.pageX - el.offsetLeft;
    qrDrag.current.scrollLeft = el.scrollLeft;
  };

  const onQRMouseMove = (e) => {
    if (!qrDragging) return;
    const el = getQRScrollEl();
    if (!el) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = (x - qrDrag.current.startX) * 1; // drag speed
    el.scrollLeft = qrDrag.current.scrollLeft - walk;
  };

  const endQRDrag = () => setQrDragging(false);

  // Touch support
  const onQRTouchStart = (e) => {
    const el = getQRScrollEl();
    if (!el) return;
    const touch = e.touches[0];
    setQrDragging(true);
    qrDrag.current.startX = touch.pageX - el.offsetLeft;
    qrDrag.current.scrollLeft = el.scrollLeft;
  };

  const onQRTouchMove = (e) => {
    if (!qrDragging) return;
    const el = getQRScrollEl();
    if (!el) return;
    const touch = e.touches[0];
    const x = touch.pageX - el.offsetLeft;
    const walk = (x - qrDrag.current.startX) * 1;
    el.scrollLeft = qrDrag.current.scrollLeft - walk;
  };


  // --- NEW: Image Upload Handlers ---
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Max size (e.g., 5MB)
    if (file.size > 5 * 1024 * 1024) {
      addMessage({
        sender: "bot",
        text: "That image is too large! Please try one under 5MB.",
        type: "error"
      });
      return;
    }

    // Check type
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      addMessage({
        sender: "bot",
        text: "Please upload a JPG, PNG, or WebP image.",
        type: "error"
      });
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (readEvent) => {
      // Get only the base64 part
      const base64Data = readEvent.target.result.split(',')[1];
      setImagePayload({
        base64: base64Data,
        mimeType: file.type,
        name: file.name,
        previewUrl: URL.createObjectURL(file) // For local preview
      });
    };
    reader.readAsDataURL(file);

    // Clear the file input value so the same file can be selected again
    e.target.value = null;
  };

  const clearImagePayload = () => {
    if (imagePayload?.previewUrl) {
      URL.revokeObjectURL(imagePayload.previewUrl);
    }
    setImagePayload(null);
  };
  // --- END: Image Upload Handlers ---

  function updateProductHintFrom(res) {
    try {
      const p = res?.products?.[0] || null;
      setLastProductData(p);
      if (p?.name) setLastProductHint(p.name);
    } catch {}
  }

  /* ---------- Main send flow ---------- */
  async function send(overrideText = null) {
    const text = (overrideText || input).trim();

    const currentImagePayload = imagePayload; // Capture state for this send

    const isNewSearch = text && !/^(yes|no|ok|sige|oo|gora|\d+)$/i.test(text.toLowerCase());
    if (currentImagePayload || isNewSearch) {
      setLastProductHint("");
      setLastProductData(null);
      setLastBotQuestion(null); // Also clear any pending questions
    }

    // === CART/BUY INTERCEPTS ===
    const lower = text.toLowerCase();
    const isAffirmative = /\b(gora|sige|oo|yes|ok|okay|sure|yup|yep)\b/i.test(lower);

    // If we have a pending "add to cart?" question:
    if (lastBotQuestion?.type === "add_to_cart") {
      if (isAffirmative) {
        // YES → keep existing behavior (ask quantity)
        const product = lastBotQuestion.product;
        setLastBotQuestion(null);

        addMessage({ sender: "bot", text: `Great choice! 🎉`, type: "cart_confirm" });
        addMessage({
          sender: "bot",
          text: `How many ${product.name} would you like? (Available: ${product.stock || 0})`,
          type: "quantity_prompt"
        });
        setQuickReplies(["1", "2", "3", "5"]);
        setLastProductData(product);
        setInput("");
        setIsLoading(false);
        setIsTyping(false);
        return;                           // ✅ we stop here only on YES
      }

      // NO (or anything not YES) → silent dismiss:
      // IMPORTANT: clear the question but DO NOT return.
      // We let the rest of send() continue so the user's message is handled.
      setLastBotQuestion(null);
    }
    
    // --- End Change ---
    
    // Check for quantity or direct action
    const qtyMatch = lower.match(/\b(\d{1,2})\b/);
    const wantedQty = qtyMatch ? Math.max(1, Number(qtyMatch[1])) : 1;

        // If user now says "add it to cart" but there's no pending question,
    // confirm the last product we asked about.
    const wantsAdd = /\b(add( it)?( to)? cart|put (it )?in (the )?cart|add it)\b/i.test(lower);
    const hasQtyInMessage = qtyMatch !== null;

    if (!lastBotQuestion && wantsAdd && !hasQtyInMessage && lastProductData) {
      // Re-confirm the most recent product we prompted about
      setLastBotQuestion({ type: "add_to_cart", product: lastProductData });
      addMessage({
        sender: "bot",
        text: `Just to confirm — add ${lastProductData.name} to your cart?`,
        type: "prompt_add",
      });
      setQuickReplies(["Yes", "No"]);
      setInput("");
      setIsLoading(false);
      setIsTyping(false);
      return; // wait for their Yes/No
    }


    if (lastProductData && lastProductData.name) {
      const hasQtyInMessage = qtyMatch !== null;
      const isAddAction = /\b(add( it)?( to)? cart|put (it )?in (the )?cart|add it)\b/i.test(lower);
      const isBuyAction = /\b(buy now|buy it|checkout( now)?|bili na)\b/i.test(lower);
      
      // If user just sent a number after quantity prompt, treat as add to cart
      const lastBotMsg = messages[messages.length - 1];
      if (hasQtyInMessage && !isAddAction && !isBuyAction && lastBotMsg?.type === "quantity_prompt") {
        try {
          await onAddToCart?.(lastProductData, wantedQty);
          addMessage({
            sender: "bot",
            text: `✅ Added ${wantedQty} × ${lastProductData.name} to your cart.`,
          });
          setQuickReplies(["Go to cart", "Buy now"]);
          setIsLoading(false);
          setIsTyping(false);
          setInput("");
          setLastProductData(null);
          return;
        } catch (err) {
          console.error("addToCart handler failed:", err);
        }
      }
      
      // If action detected but no quantity mentioned, ask first
      if ((isAddAction || isBuyAction) && !hasQtyInMessage) {
        addMessage({
          sender: "bot",
          text: `How many ${lastProductData.name} would you like? (Available: ${lastProductData.stock || 0})`,
          type: "quantity_prompt"
        });
        setQuickReplies(["1", "2", "3", "5"]);
        setInput("");
        return;
      }
      
      // Add to cart with quantity
      if (isAddAction && hasQtyInMessage) {
        try {
          await onAddToCart?.(lastProductData, wantedQty);
          addMessage({
            sender: "bot",
            text: `✅ Added ${wantedQty} × ${lastProductData.name} to your cart.`,
          });
          setQuickReplies(["Go to cart", "Buy now"]);
          setIsLoading(false);
          setIsTyping(false);
          setInput("");
          setLastProductData(null);
          return;
        } catch (err) {
          console.error("addToCart handler failed:", err);
        }
      }
      
      // Buy now with quantity
      if (isBuyAction && hasQtyInMessage) {
        try {
          await onBuyNow?.(lastProductData, wantedQty);
          addMessage({
            sender: "bot",
            text: `🧾 Taking you to checkout with ${wantedQty} × ${lastProductData.name}…`,
          });
          setQuickReplies([]);
          setIsLoading(false);
          setIsTyping(false);
          setInput("");
          setLastProductData(null);
          return;
        } catch (err) {
          console.error("buyNow handler failed:", err);
        }
      }
    }

    if ((!text && !currentImagePayload) || isLoading) { // <-- MODIFIED
      setInput("");
      return;
    }

    setInput("");
    setIsLoading(true);
    setQuickReplies([]);

    addMessage({
      sender: "user",
      text,
      // Use the local object URL for preview, not the giant base64 string
      imagePreview: currentImagePayload?.previewUrl || null
    });
    
    // --- START FIX ---
    // DO NOT revoke the URL here. It breaks the preview.
    // DO NOT clear the payload yet. It's needed for the API call.
    // --- END FIX ---

    simulateTyping(1500);

    try {
      const auth = getAuth();
      const authUser = auth.currentUser || null;

      // tiny pause for UX
      await new Promise((r) => setTimeout(r, 500));

      const followupContext =
        isGenericFollowUp(text) && lastContext.lines ? lastContext.lines : null;

        let response;
        try {
          // ✅ ALWAYS pass followupProductHint (even if empty, so server can detect follow-ups)
          const productContextHint = lastProductHint || lastProductData?.name || "";
          
          response = await sendChat(
              {
                message: text,
                userId: authUser?.uid || null,
                // ...
                clientContext: followupContext,
                followupProductHint: productContextHint, // ✅ Always pass this
                base64Image: currentImagePayload?.base64 || null, // <-- NEW
                mimeType: currentImagePayload?.mimeType || null  // <-- NEW
            }
            );
        } catch (err) {
          const fallback =
            err?.message ||
            "Oops! Something went wrong on my end. Please try again in a moment.";
          addMessage({ sender: "bot", text: fallback, type: "error" });
          return;
        }

        const botReply = response.reply || "I'm not sure how to respond to that.";
        setLastIntent(response.intent);
  
        // ✅ ROUTE to handlers but TRUST their botReply (no more overrides)
        if (response.intent === "SEARCH" && Array.isArray(response.products)) {
          handleProductSearch(response, botReply);
        } else if (response.intent === "AVAILABILITY" && Array.isArray(response.products)) {
          handleAvailabilityResponse(response, botReply);
        } else if (response.intent === "BROWSE_SALE" || response.intent === "BROWSE_NEW") {
          const products = (response.products || []).map(mapProductForChat);
          addMessage({
            sender: "bot",
            text: botReply,
            products,
            type: "browse"
          });
          updateProductHintFrom({ ...response, products })
          setQuickReplies(["Browse categories", "What's on sale?", "New arrivals"]);
        } else if (response.intent === "COMPARE") {
          handleComparisonResponse(response, botReply);
        } else if (response.intent === "BROWSE") {
          handleBrowseResponse(response, botReply);
        } else if (response.intent === "INFO") {
          handleInfoResponse(response, botReply);
        } else if (response.intent === "TRACK") {
          await handleTrackingRequest(text, authUser, botReply);
        } else if (response.intent === "RECOMMEND") {
          const products = (response.products || []).map(mapProductForChat);
          addMessage({
            sender: "bot",
            text: botReply,
            products,
            type: "recommend",
          });
          updateProductHintFrom({ ...response, products });
          setQuickReplies([ "What's on sale?", "Browse categories"]);
        } else if (response.intent === "FAQ") {
          // ✅ FAQ already formatted with personality on server
          addMessage({ sender: "bot", text: botReply, type: "faq" });
        
        } else {
          // ✅ CHAT/fallback: Trust server
          addMessage({ sender: "bot", text: botReply, type: "chat" });
          setQuickReplies([
            "What's on sale?",
            "Browse categories",
          ]);
        }


      setHistory((prev) =>
        [...prev, { role: "user", text }, { role: "model", text: response.reply || "" }].slice(-20)
      );

      if (response.intent !== "CHAT") {
        setTimeout(() => setShowFeedback(true), 2000);
      }
    } catch (error) {
      const raw = String(error?.message || "").trim();
      
      // ← ADD: Better error categorization
      let friendly;
      if (/database|credentials|unavailable/i.test(raw)) {
        friendly = "I'm having trouble reaching our database right now. Please try again shortly.";
      } else if (/timeout/i.test(raw)) {
        friendly = "That's taking too long. Could you try asking in a different way? For example:\n• 'Show me snacks under ₱200'\n• 'Do you have chocolate chips?'\n• 'What's on sale?'";
      } else if (/not found|no matches|couldn't find/i.test(raw)) {
        friendly = "I couldn't find that in our store. Try:\n• Using simpler keywords (e.g., 'chips' instead of brand names)\n• Browsing categories: Snacks, Juice & Beverage, Beauty & Cosmetics\n• Checking our 'New Arrivals' or 'Sale' sections";
      } else {
        friendly = raw && raw.length <= 160 ? raw : "😅 Oops! Something went wrong. Could you rephrase that?";
      }
      
      addMessage({ sender: "bot", text: friendly, type: "error" });
      
      // ← ADD: Context-aware quick replies
      setQuickReplies([
        "Show categories",
        "What's on sale?",
        "New arrivals",
        "Track my order"
      ]);
    } finally {
      setIsLoading(false);
      setIsTyping(false);
      clearImagePayload();
    }
  }

    /* ---------- Response handlers ---------- */
    /* ---------- Response handlers ---------- */
    const handleProductSearch = (response, botReply) => {
    // Map products to apply client-side discount logic for display consistency
    const products = (response.products || []).map(mapProductForChat);

    if (products && products.length > 0) {
        const looksLikeFiller =
          /let me check|checking|hanapin|titingnan|one moment|hold on/i.test(String(botReply || ""));
        const looksConfused =
          /\b(could\s+not\s+understand|didn'?t\s+(?:quite\s+)?(catch|understand)|please\s+rephrase|not\s+sure\s+i\s+understand|hindi\s+ko|di\s+ko)\b/i
            .test(String(botReply || ""));
        const hasRedundantList = /here\s+(are|'re)\s+some\s+(options|items|products)/i.test(String(botReply || ""));
        const shouldHideText = Boolean(response.hideReplyText) || looksLikeFiller || looksConfused || hasRedundantList;

      const displayText = shouldHideText ? "" : botReply;

      const top = products?.[0] || null;
      const count = products?.length || 0;
      const firstCategory =
        (products?.find(p => p?.category)?.category || "items").toLowerCase();

      const fallbackSimang =
        [
          `✨ I found ${count} ${firstCategory} you might like!`,
          top?.name ? `First up: ${top.name}.` : null,
        ]
        .filter(Boolean)
        .join(" ");

      const finalText = displayText && displayText.trim()
        ? displayText
        : fallbackSimang;

      // then use finalText in addMessage
      addMessage({
        sender: "bot",
        text: finalText,
        products: products,
        type: "product_search",
      });

      // Update context for follow-ups
      updateProductHintFrom({ ...response, products });
      setLastContext({
        lines: linesFromProducts(products),
        category: products?.[0]?.category || lastContext.category,
        filters: {
          onSale: response.filters?.onSale || false,
          newArrival: response.filters?.newArrival || false,
        },
      });

      // Smart quick replies based on what's available
      if (top) {
        const inStock = Number(top.stock || 0) > 0;

        // ✅ ONLY ask about cart if product is in stock and server didn't already offer
        const serverAlreadyAsked = /add.*cart|buy|checkout/i.test(String(botReply || ""));

        if (inStock && !serverAlreadyAsked) {
          setLastBotQuestion({ type: "add_to_cart", product: top });

          addMessage({
            sender: "bot",
            text: `Want me to add ${top.name} to your cart?`,
            type: "prompt_add",
          });
        }

        setQuickReplies([
          inStock ? "Add to cart" : "Buy now",
          "What's on sale?",
        ]);
      } else {
        setQuickReplies([
          "What's on sale?",
        ]);
      }
    } else {
      // ✅ NO PRODUCTS: Trust server's "not found" message (already has Simang personality)
      addMessage({
        sender: "bot",
        text:
          botReply ||
          "I couldn't find exact matches. Try different keywords or browse our categories!",
        type: "no_results",
      });
      setQuickReplies(["Show categories", "Under ₱200 items", "New arrivals"]);
    }
  };
  
  const handleAvailabilityResponse = (response, botReply) => {
    if (response.products && response.products.length > 0) {
      const products = (response.products || []).map(mapProductForChat);
      addMessage({
        sender: "bot",
        text: botReply,
        products,
        type: "availability",
      });
      updateProductHintFrom({ ...response, products });
      const top = products?.[0];

      if (top) {
        const inStock = Number(top.stock || 0) > 0;
        
        // ✅ Only prompt if server didn't already offer
        const serverAlreadyAsked = /add.*cart|buy|show.*similar/i.test(botReply);
        
        if (!serverAlreadyAsked) {
          const questionText = inStock
            ? `Want me to add ${top.name} to your cart?`
            : `Should I show similar items to ${top.name}?`;
          
          setLastBotQuestion({ type: "add_to_cart", product: top });
          
          addMessage({
            sender: "bot",
            text: questionText,
            type: "prompt_add",
          });
        }
        
        setQuickReplies([
          inStock ? "Add to cart" : "Show similar items",
        ]);
      } else {
        setQuickReplies([
          "Similar products",
          "Browse categories",
        ]);
      }
    } else {
      // ✅ TRUST SERVER: No robotic "Could you be more specific"
      addMessage({
        sender: "bot",
        text: botReply,
        type: "availability_query",
      });
     
    }
  };

  const handleComparisonResponse = (response, botReply) => {
    if (response.comparison && response.products && response.products.length > 1) {
      const products = (response.products || []).map(mapProductForChat);
      addMessage({
        sender: "bot",
        text: botReply,
        products,
        type: "comparison",
      });
      updateProductHintFrom({ ...response, products });
      
      setQuickReplies([ "Browse categories"]);
    } else {
      // ✅ TRUST SERVER: botReply already explains the issue with Simang's voice
      addMessage({
        sender: "bot",
        text: botReply,
        type: "comparison_help",
      });
      setQuickReplies(["Show me products", "Browse categories", "What's on sale?", "New arrivals"]);
    }
  };

  const handleBrowseResponse = (response, botReply) => {
    if (response.categories && response.categories.length > 0) {
      // ✅ MINIMAL CLIENT FORMATTING: Just show categories cleanly
      const categoryList = response.categories.map((cat) => `🏷️ ${cat}`).join("\n");

      addMessage({
        sender: "bot",
        text: `${botReply}\n\n${categoryList}`,
        categories: response.categories,
        type: "category_browse",
      });

      setQuickReplies(response.categories.slice(0, 4));
    } else {
      // ✅ TRUST SERVER
      addMessage({ sender: "bot", text: botReply, type: "browse" });
      setQuickReplies(["Show me products", "What's on sale?", "New arrivals", "Under ₱200"]);
    }
  };

  const handleInfoResponse = (response, botReply) => {
    // Map products to apply client-side discount logic for display consistency
    const products = (response.products || []).map(mapProductForChat);

    // ✅ TRUST SERVER: botReply already has facts formatted with personality
    addMessage({ 
      sender: "bot", 
      text: botReply, 
      products: products,
      type: "info"
    });
    
    updateProductHintFrom({ ...response, products });

    const top = products?.[0];
    if (top) {
      // ✅ Only prompt if server didn't already ask
      const serverAlreadyAsked = /add.*cart|buy/i.test(botReply);
      
      if (!serverAlreadyAsked) {
        setLastBotQuestion({ type: "add_to_cart", product: top });
        
        addMessage({
          sender: "bot",
          text: `Want me to add ${top.name} to your cart?`,
          type: "prompt_add",
        });
      }
      
      setQuickReplies(["Add to cart", "Browse categories"]);
    } else {
      setQuickReplies(["Show me products", "What's on sale?", "New arrivals"]);
    }
  };

  const handleTrackingRequest = async (text, authUser, botReply) => {
    const id = extractOrderId(text);
    const wantsLatest = /\b(latest|recent|last)\b/i.test(text);

    if (authUser && !id && !wantsLatest) {
      addMessage({
        sender: "bot",
        text: "Send your Order ID like ORD-XXXX-1234, or say “track my order (Then the Order Number)”. 📦",
        type: "need_order_id",
      });
      
      return;
    }

    if (id && !authUser) {
      const result = await trackOrder({ orderId: id }).catch(() => null);
        if (!result || !result.found) {
          // ✅ NEW: Check if order requires auth
          if (result?.requiresAuth) {
            addMessage({
              sender: "bot",
              text: "This order requires you to be logged in to track it. 🔒 Please sign in first, then try tracking again!",
              type: "auth_required",
            });
            setQuickReplies(["Sign in", "Track a different order"]);
            return;
          }
          
          addMessage({
            sender: "bot",
            text: "Hmm, I couldn't find that Order ID. Double-check it and try again? 🔍",
            type: "order_not_found",
          });
          return;
        }
      
      // ✅ FORMAT order details with mini personality
      const lines = [
        "Here's what I found! 📦",
        "",
        `Status: ${result.status || "Processing"}`,
        `Order ID: ${result.orderID}`,
        result.placedAt ? `Date: ${fmtPH(result.placedAt)}` : "",
      ].filter(Boolean);
      
      if (Array.isArray(result.items) && result.items.length) {
        lines.push("");
        lines.push("Items:");
        for (const it of result.items.slice(0, 3)) {
          const nm = it.name || "Item";
          const qty = Number(it.quantity || 0);
          const pr = Number(it.price || 0);
          lines.push(`• ${nm}  ×${qty}  ₱${pr.toFixed(2)}`);
        }
      }
      
      addMessage({ sender: "bot", text: lines.join("\n"), type: "order_found", orderData: result });
      return;
    }

    if (authUser) {
      const idToken = await authUser.getIdToken();
      const result = await trackOrder({ orderId: id || null, idToken }).catch(() => null);
      if (!result || !result.found) {
        addMessage({
          sender: "bot",
          text: "I couldn't find a recent order. Want to check your order history? 🤔",
          type: "order_not_found",
        });
        return;
      }
      
      // ✅ Same formatting as above
      const lines = [
        "Here's your order! 📦",
        "",
        `Status: ${result.status || "Processing"}`,
        `Order ID: ${result.orderID}`,
        result.placedAt ? `Date: ${fmtPH(result.placedAt)}` : "",
      ].filter(Boolean);
      
      if (Array.isArray(result.items) && result.items.length) {
        lines.push("");
        lines.push("Items:");
        for (const it of result.items.slice(0, 3)) {
          const nm = it.name || "Item";
          const qty = Number(it.quantity || 0);
          const pr = Number(it.price || 0);
          lines.push(`• ${nm}  ×${qty}  ₱${pr.toFixed(2)}`);
        }
      }
      
      addMessage({ sender: "bot", text: lines.join("\n"), type: "order_found", orderData: result });
      return;
    }

    addMessage({
      sender: "bot",
      text: "Send me your Order ID (like ORD-ABC123), or sign in to track your latest order! 🔐",
      type: "auth_required",
    });
  };

  /* ---------- UI helpers ---------- */
  const formatMessageText = (text) =>
    text.split("\n").map((line, index) => (
      <div
        key={index}
        className={line.startsWith("•") || line.startsWith("🛒") ? "product-item" : ""}
      >
        {line}
      </div>
    ));
  const formatTime = (timestamp) =>
    new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const getMessageIcon = (type) => {
    switch (type) {
      case "product_search":
        return faSearch;
      case "availability":
        return faBox;
      case "comparison":
        return faTag;
      case "order_found":
        return faCheckCircle;
      case "order_not_found":
        return faExclamationCircle;
      case "error":
        return faExclamationCircle;
      case "welcome":
        return faHeart;
      default:
        return faCommentDots;
    }
  };

  /* ---------- Render ---------- */
  return (
    <div className="Chat-Container">
      {!showSelector && !showChat && (
        <div className="Chat-Button" onClick={() => openChatbot(true)}>
          <FontAwesomeIcon icon={faCommentDots} />
        </div>
      )}

      {showChat && (
        <div className={`Chatbot-Window ${isClosingChatbot ? "Chatbot-Exit" : "Chatbot-Enter"}`}>
          <div className="Chatbot-Header">
            <div className="Simang-Header">
              <img src="/ChatbotIcon2.png" alt="Simang-Chan" className="Simang-Avatar" />
              <div className="Simang-Info">
                <span className="Simang-Name">Simang-Chan</span>
                <span className="Simang-Status">
                  <span className="status-dot"></span>
                  Online & Ready to Help
                </span>
              </div>
            </div>
            <button onClick={closeChatbot} className="Close-Chatbot">
              <FontAwesomeIcon icon={faTimes} />
            </button>
          </div>

          <div className="Chatbot-Messages">
            {messages.map((msg, index) => (
              <div key={index} className={`Message-Wrapper ${msg.sender}-message-wrapper`}>
                {msg.sender === "bot" ? (
                  <>
                    <img
                      src="/ChatbotIcon2.png"
                      alt="Simang-Chan"
                      className="Simang-Avatar-Message"
                    />

                    {/* bubble + carousel vertically */}
                    <div className="Bot-Stack">
                  {(() => {
                    const hasBubbleText = Boolean(msg.text && String(msg.text).trim());
                    const hasProductsArray = Array.isArray(msg.products);

                    return (
                      <>
                        {hasBubbleText && (
                          <div className="Message Bot-Message">
                            {msg.type && (
                              <div className="Message-Type-Icon">
                                <FontAwesomeIcon icon={getMessageIcon(msg.type)} />
                              </div>
                            )}
                            <div className="Message-Content">{formatMessageText(msg.text)}</div>
                            <div className="Message-Time">{formatTime(msg.timestamp)}</div>
                          </div>
                        )}

                        {hasProductsArray && msg.products.length > 0 && (
                          <ChatProductGallery items={msg.products} onOpen={openProductModal} />
                        )}

                        {hasProductsArray && msg.products.length === 0 && (
                          <div className="No-Products-Found">
                            <p>
                              No matching products found for your request. Try using simpler keywords or
                              browsing categories!
                            </p>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>


                  </>
                ) : (
                  <div className="Message User-Message">
                    {msg.imagePreview && (
                      <div className="User-Image-Preview">
                        <img src={msg.imagePreview} alt="User upload" />
                      </div>
                    )}
                    <div className="Message-Content">{formatMessageText(msg.text)}</div>
                    <div className="Message-Time">{formatTime(msg.timestamp)}</div>
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className="Message-Wrapper bot-message-wrapper">
                <img src="/ChatbotIcon2.png" alt="Simang-Chan" className="Simang-Avatar-Message" />
                <div className="Bot-Message typing-indicator">
                  <div className="Typing-Dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <span className="Typing-Text">Simang is searching...</span>
                </div>
              </div>
            )}

            {showFeedback && (
              <div className="Feedback-Container">
                <p>Was this helpful?</p>
                <div className="Feedback-Buttons">
                  <button onClick={() => sendFeedback(true)}>
                    <FontAwesomeIcon icon={faThumbsUp} /> Yes
                  </button>
                  <button onClick={() => sendFeedback(false)}>
                    <FontAwesomeIcon icon={faThumbsDown} /> No
                  </button>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* --- NEW: Image Preview Area --- */}
          {imagePayload && (
            <div className="Chat-Image-Preview">
              <img src={imagePayload.previewUrl} alt={imagePayload.name} />
              <span>{imagePayload.name}</span>
              <button onClick={clearImagePayload} className="Clear-Image-Button">
                <FontAwesomeIcon icon={faTimesCircle} />
              </button>
            </div>
          )}
          {/* --- END --- */}
          
          {quickReplies.length > 0 && (
          <SimpleBar
            ref={quickBarRef}
            className={`Quick-Replies ${qrDragging ? 'dragging' : ''}`}
            autoHide={false}
          >
            <div
              className={`Quick-RepliesTrack ${qrDragging ? 'is-dragging' : ''}`}
              onMouseDown={onQRMouseDown}
              onMouseMove={onQRMouseMove}
              onMouseLeave={endQRDrag}
              onMouseUp={endQRDrag}
              onTouchStart={onQRTouchStart}
              onTouchMove={onQRTouchMove}
            >
              {quickReplies.map((reply, index) => (
                <button
                  key={index}
                  className="Quick-Reply-Button"
                  onClick={() => sendQuickReply(reply)}
                  disabled={isLoading}
                >
                  {reply}
                </button>
              ))}
            </div>
          </SimpleBar>
        )}

          <div className="Chatbot-Input">
            
            {/* This is the hidden file input */}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={handleFileSelect}
              accept="image/png, image/jpeg, image/webp"
            />
            
            {/* --- START FIX: Remove nested div --- */}
            {/* This single container holds the upload button, text input, and send button */}
            <div className="Input-Container">
              
              {/* Upload Button is a sibling to the text input */}
              <button
                className="Upload-Button"
                onClick={handleUploadClick}
                disabled={isLoading}
                title="Upload Image"
              >
                <FontAwesomeIcon icon={faImage} />
              </button>

              {/* The text input */}
              <input
                ref={inputRef}
                type="text"
                placeholder="Ask about products, check stock, track orders... 💭"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={isLoading}
                maxLength={500}
              />
              
              {/* The send button */}
              <button
                className={`Send-Button ${isLoading ? "loading" : ""}`}
                onClick={() => send()}
                disabled={isLoading || (!input.trim() && !imagePayload)}
              >
                {isLoading ? (
                  <FontAwesomeIcon icon={faSpinner} spin />
                ) : (
                  <FontAwesomeIcon icon={faPaperPlane} />
                )}
              </button>
            </div>

            {/* The footer is a sibling to Input-Container, not inside it */}
            <div className="Input-Footer">
              <span className="Character-Count">{input.length}/500</span>
              <span className="Character-Count">Simang can make mistakes, so double-check it</span>
            </div>
            {/* --- END FIX --- */}
            
          </div>
        </div>
      )}
    </div>
  );
}