import React, { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faTimes, faCircleChevronUp, faArrowsRotate as faRotate } from "@fortawesome/free-solid-svg-icons";
import { createRoot } from "react-dom/client";
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

import VSIntroSalesArrivals from "./VSLogic/VSIntroSalesArrivals";

import { db } from "@/firebase/firebaseconfig";
import { doc, getDoc, setDoc, collection, getDocs, updateDoc } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// ----- constants -------------------------------------------------------------
const TOUR_ID = "main";

// --- perf profile (very light) ----------------------------------------------
function usePerfProfile() {
  const [limits, setLimits] = useState({
    DPR_CAP: 1.5,
    MAX_FACE: 3072,
    ZOOM_STEP: 0.06,
  });

  useEffect(() => {
    try {
      const dm = navigator.deviceMemory || 4;
      const hc = navigator.hardwareConcurrency || 4;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const eff = navigator.connection?.effectiveType || "";

      // eco for low mem/cores or slow network; high when strong device
      if (eff.includes("2g") || eff.includes("3g") || dm <= 3 || hc <= 4) {
        setLimits({ DPR_CAP: 1.0, MAX_FACE: 2048, ZOOM_STEP: 0.05 });
      } else if (dpr >= 2.5 || dm <= 5) {
        setLimits({ DPR_CAP: 1.5, MAX_FACE: 3072, ZOOM_STEP: 0.06 });
      } else {
        setLimits({ DPR_CAP: 2.0, MAX_FACE: 4096, ZOOM_STEP: 0.07 });
      }
    } catch {
      // keep defaults
    }
  }, []);

  return limits;
}


// ----- helpers ---------------------------------------------------------------
const mapProductFromFirestore = (snap) => {
  const d = snap.data() || {};
  const discountActive = d.isDiscountEnabled === true;
  const price = discountActive
    ? d.discountedPrice ?? Math.floor(d.price * (1 - (d.manualDiscountPercent ?? 0) / 100))
    : d.price;

  return {
    id: snap.id,
    name: d.productName || d.name || "Unnamed",
    imageUrl: d.imageUrl || "",
    price: Number(price) || 0,
    originalPrice: discountActive ? Number(d.price) || null : null,
    description: d.description || "",
    rating: Number(d.rating ?? 0),
    reviews: Number(d.reviews ?? 0),
    stock: Number(d.stock ?? 0),
  };
};

const sceneDisplayName = (idOrFilename = "") => idOrFilename.replace(/\.[^/.]+$/, "");
// tiny in-memory cache for product docs
const _productCache = new Map(); // id -> product


// ----- component -------------------------------------------------------------
export default function VirtualStoreView({ onProductClick, onAddToCart }) {
  // marzipano
  const [Marzipano, setMarzipano] = useState(null);
  const panoRef = useRef(null);
  const viewerRef = useRef(null);
  const sceneRef = useRef(null);
  const hotspotHandlesRef = useRef([]);
  const hotspotRootsRef = useRef([]);
  const viewRef = useRef(null);
  const limits = usePerfProfile(); 
  const [activeSceneId, setActiveSceneId] = useState(null);

  // Track link-type hotspots for WASD navigation only
  const linkHotspotsRef = useRef([]); // [{ yaw, pitch, to }]

  // Small helpers for angular math
  const TAU = Math.PI * 2;
  const clampPi = (r) => {
    // normalize angle diff into [-PI, PI]
    const t = (r + Math.PI) % TAU;
    return t < 0 ? t + TAU - Math.PI : t - Math.PI;
  };

  // Pick the best link hotspot in a relative direction from current yaw
  // direction: 'forward' (0deg), 'left' (-90deg), 'right' (+90deg), 'back' (180deg)
  const pickLinkTarget = useCallback((direction) => {
    const view = viewRef.current;
    if (!view || !linkHotspotsRef.current.length) return null;

    const curYaw = view.yaw();
    const curPitch = view.pitch();

    const offsets = {
      forward: 0,
      right: Math.PI / 2,
      left: -Math.PI / 2,
      back: Math.PI,
    };
    const desired = curYaw + (offsets[direction] ?? 0);

    // If nothing aligns within ~100°, do nothing
    const MAX_YAW_DEVIATION = (100 * Math.PI) / 180;

    let best = null;
    let bestScore = Infinity;

    for (const h of linkHotspotsRef.current) {
      if (!h?.to) continue;
      const yawDelta = clampPi(h.yaw - desired);
      const pitchDelta = h.pitch - curPitch;

      const absYaw = Math.abs(yawDelta);
      if (absYaw > MAX_YAW_DEVIATION) continue; // too far off direction

      // Score: prefer yaw alignment, gently penalize pitch offset
      const score = absYaw + Math.abs(pitchDelta) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }, []);


  // Smooth link-to-scene transition helpers
  const isTransitioningRef = useRef(false);

  const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const animateViewTo = useCallback((target = {}, duration = 450) => {
    const view = viewRef.current;
    if (!view || duration <= 0) return Promise.resolve();

    const start = {
      yaw: view.yaw(),
      pitch: view.pitch(),
      fov: view.fov(),
    };
    const end = {
      yaw: typeof target.yaw === "number" ? target.yaw : start.yaw,
      pitch: typeof target.pitch === "number" ? target.pitch : start.pitch,
      fov: typeof target.fov === "number" ? target.fov : start.fov,
    };

    let raf = null;
    const t0 = performance.now();

    return new Promise((resolve) => {
      const tick = (now) => {
        const dt = Math.min(1, (now - t0) / duration);
        const k = easeInOutQuad(dt);

        // simple linear interpolation (works well for small yaw deltas typical of link cues)
        const lerp = (a, b, t) => a + (b - a) * t;
        try {
          view.setParameters({
            yaw: lerp(start.yaw, end.yaw, k),
            pitch: lerp(start.pitch, end.pitch, k),
            fov: lerp(start.fov, end.fov, k),
          });
        } catch {}

        if (dt < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      raf = requestAnimationFrame(tick);
    }).finally(() => {
      if (raf) cancelAnimationFrame(raf);
    });
  }, []);

  const smoothGotoScene = useCallback(
    async (toSceneId, linkPose) => {
      if (!toSceneId) return;
      if (isTransitioningRef.current) {
        // avoid double-queueing; still honor navigation
        setActiveSceneId(toSceneId);
        return;
      }
      isTransitioningRef.current = true;
      try {
        // Nudge camera toward the link’s yaw/pitch for continuity, then switch
        if (viewRef.current && linkPose) {
          const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
          const curFov = viewRef.current.fov();
          const targetFov = clamp(curFov * 0.95, MIN_FOV, MAX_FOV);
          await animateViewTo(
            { yaw: linkPose.yaw, pitch: linkPose.pitch, fov: targetFov },
            350
          );
        }
        setActiveSceneId(toSceneId);
      } finally {
        // brief delay so follow-up clicks don't interrupt the fade
        setTimeout(() => {
          isTransitioningRef.current = false;
        }, 50);
      }
    },
    [animateViewTo, setActiveSceneId]
  );


  /* NEW: track what scene is actually rendered in the viewer */
  const currentSceneIdRef = useRef(null);
  const MIN_FOV = (100 * Math.PI) / 180;
  const MAX_FOV = (120 * Math.PI) / 180;

  // ui state
  const [isBooting, setIsBooting] = useState(true);
  const [isLoadingScene, setIsLoadingScene] = useState(false);
  const [isSceneListOpen, setIsSceneListOpen] = useState(false);
  const [idleSpinActive, setIdleSpinActive] = useState(true);
  const idleSpinCancelRef = useRef(null);

  // data state
  const [manifest, setManifest] = useState({ order: [], defaultSceneId: null });
  const [scenes, setScenes] = useState([]); // [{id, imageUrl, initialView}]
 

  // multi-product selector
  const [multiPickerItems, setMultiPickerItems] = useState(null);

  // auth (for fallback add-to-cart)
  const [firebaseUser, setFirebaseUser] = useState(null);
  useEffect(() => {
    const auth = getAuth();
    return auth.onAuthStateChanged((u) => setFirebaseUser(u ? { uid: u.uid, email: u.email } : null));
  }, []);

  // ----- init marzipano (client side) ---------------------------------------
  useEffect(() => {
    let mounted = true;
    (async () => {
      const M = await import("marzipano");
      if (!mounted) return;
      setMarzipano(M);
      if (panoRef.current && !viewerRef.current) {
        viewerRef.current = new M.Viewer(panoRef.current, { controls: { mouseViewMode: "drag" } });
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // ----- fetch manifest + scenes -------------------------------------------
  /* fetch manifest + scenes */
  useEffect(() => {
    (async () => {
      try {
        const tourRef = doc(db, "publicTours", TOUR_ID);
        const tourSnap = await getDoc(tourRef);
        const m = tourSnap.exists() ? tourSnap.data() : {};
        const order = Array.isArray(m.order) ? m.order : [];
        const defaultSceneId = m.defaultSceneId || null;

        const scenesSnap = await getDocs(collection(tourRef, "scenes"));
        const all = scenesSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
        const map = new Map(all.map(s => [s.id, s]));

        const orderedExisting = order.map(id => map.get(id)).filter(Boolean);
        const appendNew = all.filter(s => !order.includes(s.id));
        const ordered = [...orderedExisting, ...appendNew];

        setScenes(ordered);
        const hasDefault = ordered.some(s => s.id === defaultSceneId);
        const safeDefault = hasDefault ? defaultSceneId : (ordered[0]?.id || null);
        setManifest({ order: ordered.map(s => s.id), defaultSceneId: safeDefault });
        setActiveSceneId(safeDefault);
      } catch (err) {
        console.error("Load public tour failed", err);
      } finally {
        setIsBooting(false);
      }
    })();
  }, []);


  // ----- hotspot helpers ----------------------------------------------------
  const clearHotspots = useCallback(() => {
    if (!sceneRef.current) return;
    const container = sceneRef.current.hotspotContainer?.();
    if (!container) return;
    hotspotHandlesRef.current.forEach((h) => {
      try {
        container.destroyHotspot(h);
      } catch {}
    });
    hotspotHandlesRef.current = [];
    hotspotRootsRef.current.forEach((r) => {
      try {
        r.unmount();
      } catch {}
    });
    hotspotRootsRef.current = [];
    linkHotspotsRef.current = []; // <-- add this
  }, []);


  const startIdleSpin = (view, elem, speed = 0.00005) => {
    const target = elem || window;
    const spd = typeof speed === "number" && isFinite(speed) ? speed : 0.00005;
    if (!target || typeof target.addEventListener !== "function") return () => {};
    let spinning = true;
    let last = null;
    let rafId = null;
    const step = (t) => {
      if (!spinning) return;
      if (last != null) {
        const dt = t - last;
        try {
          view.setYaw(view.yaw() + dt * spd);
        } catch {}
      }
      last = t;
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    const stop = () => {
      if (!spinning) return;
      spinning = false;
      if (rafId) cancelAnimationFrame(rafId);
      try {
        target.removeEventListener("mousedown", stop);
        target.removeEventListener("touchstart", stop);
        target.removeEventListener("wheel", stop);
        window.removeEventListener("keydown", stop);
      } catch {}
    };
    try {
      target.addEventListener("mousedown", stop);
      target.addEventListener("touchstart", stop);
      target.addEventListener("wheel", stop);
      window.addEventListener("keydown", stop);
    } catch {}
    return stop;
  };

  const getWheelTarget = () => {
    if (!viewerRef.current) return panoRef.current;
    try {
      const stage = viewerRef.current.stage();
      if (stage && stage.domElement) return stage.domElement();
    } catch {}
    return panoRef.current;
  };

  const handleIdleSpinToggle = useCallback(() => {
    try {
      if (!sceneRef.current) return;
      if (idleSpinActive) {
        idleSpinCancelRef.current?.();
        idleSpinCancelRef.current = null;
        setIdleSpinActive(false);
      } else {
        idleSpinCancelRef.current?.();
        idleSpinCancelRef.current = startIdleSpin(sceneRef.current.view(), panoRef.current);
        setIdleSpinActive(true);
      }
    } catch (e) {
      console.error("Idle spin toggle failed", e);
    }
  }, [idleSpinActive]);

  const resolveProductById = useCallback(async (id) => {
    if (!id) return null;
    // serve from cache if present
    const cached = _productCache.get(id);
    if (cached) return cached;
  
    try {
      const s = await getDoc(doc(db, "products", id));
      const res = s.exists() ? mapProductFromFirestore(s) : null;
      if (res) _productCache.set(id, res);
      return res;
    } catch (e) {
      console.error("Resolve product failed", e);
      return null;
    }
  }, []);

  // Open multi-product selector
  const openMultiSelector = useCallback(
    async (ids = []) => {
      const uniq = Array.from(new Set(ids.filter(Boolean)));
      if (!uniq.length) return;
  
      // check cache first; only fetch misses
      const fromCache = [];
      const misses = [];
      for (const id of uniq) {
        const c = _productCache.get(id);
        if (c) fromCache.push(c);
        else misses.push(id);
      }
  
      let fetched = [];
      if (misses.length) {
        fetched = await Promise.all(misses.map(resolveProductById));
      }
  
      const products = [...fromCache, ...fetched].filter(Boolean);
      setMultiPickerItems(products);
    },
    [resolveProductById]
  );
  

  const closeMultiSelector = useCallback(() => setMultiPickerItems(null), []);

  // Selection now delegates to parent Homepage via onProductClick
  const handleSelectProduct = useCallback(
    (product) => {
      if (!product) return;
      // Close the multi-picker so the homepage modal isn't layered over it
      closeMultiSelector();
      if (typeof onProductClick === "function") {
        onProductClick(product);
        return;
      }
      // Fallback: keep a console note if no handler is provided
      if (process.env.NODE_ENV !== "production") {
        console.warn("VirtualStoreView: onProductClick prop not provided. No modal will open.", product);
      }
    },
    [onProductClick, closeMultiSelector]
  );

  // Add-to-cart delegates to Homepage when available; otherwise uses local fallback
  const fallbackAddToCart = useCallback(
    async (product, quantity = 1) => {
      if (!product || product.stock === 0) return;
      try {
        if (firebaseUser?.uid) {
          const userRef = doc(db, "users", firebaseUser.uid);
          const snap = await getDoc(userRef);
          const current = snap.exists() ? snap.data().cartItems || [] : [];
          const existing = current.find((i) => i.id === product.id);
          const newItem = existing ? { ...existing, quantity: existing.quantity + quantity } : { ...product, quantity };
          const updated = [newItem, ...current.filter((i) => i.id !== product.id)];

          if (snap.exists()) {
            await updateDoc(userRef, { cartItems: updated });
          } else {
            await setDoc(userRef, { cartItems: updated });
          }
          try {
            window.dispatchEvent(new Event("cartUpdated"));
          } catch {}
        } else {
          const stored = JSON.parse(localStorage.getItem("guestCart") || "[]");
          const existing = stored.find((i) => i.id === product.id);
          const newItem = existing ? { ...existing, quantity: existing.quantity + quantity } : { ...product, quantity };
          const updated = [newItem, ...stored.filter((i) => i.id !== product.id)];
          localStorage.setItem("guestCart", JSON.stringify(updated));
          try {
            window.dispatchEvent(new Event("cartUpdated"));
          } catch {}
        }
      } catch (e) {
        console.error("Add to cart failed", e);
      }
    },
    [firebaseUser]
  );

  const handleAddToCart = useCallback(
    async (product, quantity = 1) => {
      if (typeof onAddToCart === "function") return onAddToCart(product, quantity);
      return fallbackAddToCart(product, quantity);
    },
    [onAddToCart, fallbackAddToCart]
  );

    // render list of hotspots in small chunks to avoid jank
  function chunkedRenderHotspots(container, list, onBeforeEach, onAfterAll) {
    const CHUNK = 24; // small batches keep frames under budget
    const total = list.length;
    let i = 0;

    const schedule = window.requestIdleCallback
      ? (cb) => requestIdleCallback(cb, { timeout: 250 })
      : (cb) => setTimeout(cb, 0);

    const tick = () => {
      const end = Math.min(i + CHUNK, total);
      for (; i < end; i++) {
        try { onBeforeEach(list[i]); } catch (e) { console.error(e); }
      }
      if (i < total) schedule(tick);
      else if (typeof onAfterAll === "function") onAfterAll();
    };

    schedule(tick);
  }


    const renderHotspots = useCallback(
    async (sceneId) => {
      if (!sceneRef.current) return;
      clearHotspots();

      const container = sceneRef.current.hotspotContainer?.();
      if (!container) return;

      const hsSnap = await getDocs(collection(db, "publicTours", TOUR_ID, "scenes", sceneId, "hotspots"));
      const list = hsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

      linkHotspotsRef.current = [];

      const toDOM = (h) => {
        const isProduct =
          h.kind === "product" ||
          !!h.productId ||
          (Array.isArray(h.productIds) && h.productIds.length > 0);

        const el = document.createElement("div");
        el.className = `HotspotDot${isProduct ? " ProductDot" : " LinkDot"}`;
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.title = isProduct ? "View product(s)" : "Go to scene";

        if (!isProduct) {
          const to = h.linkedSceneId || h.linkedScenarioId || h.targetSceneId;
          if (to) {
            linkHotspotsRef.current.push({
              yaw: h.yaw,
              pitch: h.pitch,
              to,
            });
          }
          try {
            const deg = Number(h.rotationDeg || 0);
            el.style.setProperty("--rot", `${deg}deg`);
            const wrap = document.createElement("div");
            wrap.className = "LinkDotIconWrap";
            wrap.style.setProperty("--tilt", "40deg");
            el.appendChild(wrap);
            const root = createRoot(wrap);
            if (faCircleChevronUp && typeof faCircleChevronUp === "object" && faCircleChevronUp.iconName) {
              root.render(<FontAwesomeIcon icon={faCircleChevronUp} className="LinkDotChevron" />);
            } else {
              wrap.innerHTML = '<span class="LinkDotChevron" aria-hidden="true">▲</span>';
            }
            hotspotRootsRef.current.push(root);
          } catch (e) {
            console.error("Link icon mount failed", e);
          }
        }

        const onOpen = async () => {
          if (!isProduct) {
            const to = h.linkedSceneId || h.linkedScenarioId || h.targetSceneId;
            if (to && to !== currentSceneIdRef.current) {
              await smoothGotoScene(to, { yaw: h.yaw, pitch: h.pitch });
            }
            return;
          }
          const ids = Array.isArray(h.productIds) && h.productIds.length > 0 ? h.productIds : h.productId ? [h.productId] : [];
          if (ids.length === 1) {
            const p = await resolveProductById(ids[0]);
            if (p) handleSelectProduct(p);
          } else if (ids.length > 1) {
            await openMultiSelector(ids);
          }
        };


        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpen();
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        });

        try {
          const handle = container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
          hotspotHandlesRef.current.push(handle);
        } catch {}
      };

      // render in small batches to keep frames smooth
      chunkedRenderHotspots(container, list, toDOM);
    },
    [clearHotspots, openMultiSelector, resolveProductById, handleSelectProduct]
  );


  // ----- scene loading ------------------------------------------------------
  /* loadScene declaration with early-return guard */
  const loadScene = useCallback(
    async (sceneMeta) => {
      if (!Marzipano || !viewerRef.current || !sceneMeta) return;

      // guard: if same scene, do not rebuild viewer. refresh hotspots only.
      if (sceneRef.current && currentSceneIdRef.current === sceneMeta.id) {
        // No-op to avoid flicker; we’re already on this scene.
        // (If you want to force-refresh hotspots manually, call renderHotspots(sceneMeta.id) here.)
        return;
      }

      setIsLoadingScene(true);
      try {
        clearHotspots();

        const geometry = new Marzipano.EquirectGeometry([{ width: 4000 }]);

        // compute a profile-aware face size cap
        const viewportRect = panoRef.current?.getBoundingClientRect();
        const basePx = Math.max(viewportRect?.width || 1024, viewportRect?.height || 768);
        const perfFace = Math.min(limits.MAX_FACE, Math.ceil(basePx * limits.DPR_CAP));

        // keep your existing face hint but never exceed perfFace
        const sceneFaceHint = Number(sceneMeta?.faceSize) || Number(sceneMeta?.imageWidth) || 2048;
        const face = Math.min(sceneFaceHint, perfFace);

        const limiter = Marzipano.RectilinearView.limit.traditional(2 * face, MIN_FOV, MAX_FOV);

        const initialView = sceneMeta.initialView || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
        if (typeof initialView.fov === "number") {
          initialView.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, initialView.fov));
        }
        const view = new Marzipano.RectilinearView(initialView, limiter);
        const source = Marzipano.ImageUrlSource.fromString(sceneMeta.imageUrl);
        const scene = viewerRef.current.createScene({ source, geometry, view, pinFirstLevel: true });

        viewRef.current = view;
        scene.switchTo({ transitionDuration: 600 });
        sceneRef.current = scene;
        /* NEW: record which scene is actually on screen */
        currentSceneIdRef.current = sceneMeta.id;
        try {
          idleSpinCancelRef.current?.();
        } catch {}
        if (idleSpinActive) {
          try {
            idleSpinCancelRef.current = startIdleSpin(scene.view(), panoRef.current, 0.00005);
          } catch {}
        }

        await renderHotspots(sceneMeta.id);

        // prefetch neighbor scene images (tiny, non-blocking)
        try {
          const idx = manifest.order.findIndex((id) => id === sceneMeta.id);
          const neighbors = [manifest.order[idx - 1], manifest.order[idx + 1]].filter(Boolean);
          for (const id of neighbors) {
            const s = scenes.find((x) => x.id === id);
            if (s?.imageUrl && typeof window !== "undefined" && window.Image) {
              const img = new window.Image(); // IMPORTANT: avoid Next's <Image> name collision
              img.referrerPolicy = "no-referrer";
              img.decoding = "async";
              img.loading = "eager";
              img.src = s.imageUrl;
            }
          }
        } catch {}
      } catch (e) {
        console.error("Load scene failed", e);
      } finally {
        setIsLoadingScene(false);
      }
    },
    [Marzipano, renderHotspots, clearHotspots, idleSpinActive, limits.DPR_CAP, limits.MAX_FACE]
  );


  // load whenever activeSceneId changes
  useEffect(() => {
    const meta = scenes.find((s) => s.id === activeSceneId);
    if (meta) loadScene(meta);
  }, [activeSceneId, scenes, loadScene]);

  useEffect(() => {
    if (!idleSpinActive) return;
    if (!sceneRef.current || !viewRef.current) return;
    if (!idleSpinCancelRef.current) {
      try {
        idleSpinCancelRef.current = startIdleSpin(sceneRef.current.view(), panoRef.current);
      } catch {}
    }
  }, [idleSpinActive, activeSceneId]);

  // cleanup hotspots on unmount
  useEffect(() => () => clearHotspots(), [clearHotspots]);
  useEffect(() => () => {
    try {
      idleSpinCancelRef.current?.();
    } catch {}
  }, []);

    // WASD navigation: walk via nearest link hotspot in the direction of view
  useEffect(() => {
    const onKeyDown = async (e) => {
      // Ignore typing in inputs/textareas/contenteditable
      const t = e.target;
      const tag = (t?.tagName || "").toLowerCase();
      const isTyping =
        tag === "input" || tag === "textarea" || t?.isContentEditable;
      if (isTyping) return;

      if (!viewerRef.current || !linkHotspotsRef.current.length) return;

      const key = e.key?.toLowerCase();
      let dir = null;
      if (key === "w") dir = "forward";
      else if (key === "a") dir = "left";
      else if (key === "s") dir = "back";
      else if (key === "d") dir = "right";
      else return;

      const target = pickLinkTarget(dir);
      if (!target || target.to === currentSceneIdRef.current) return;

      e.preventDefault();
      try {
        await smoothGotoScene(target.to, { yaw: target.yaw, pitch: target.pitch });
      } catch {}
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickLinkTarget, smoothGotoScene]);


  // Setup wheel zoom handler for Marzipano
  useEffect(() => {
    const target = getWheelTarget();
    const view = viewRef.current;
    if (!target || !view) return;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const step = limits.ZOOM_STEP; // profile-aware
    let wheelRAF = null;
    let pendingDelta = 0;

    const onWheel = (e) => {
      // IMPORTANT: cancel immediately so the browser never scrolls the page
      e.preventDefault();
      e.stopPropagation();

      // accumulate deltas and process once per frame
      pendingDelta += e.deltaY;
      if (wheelRAF) return;

      wheelRAF = requestAnimationFrame(() => {
        wheelRAF = null;
        try {
          const dir = Math.sign(pendingDelta); // down -> +1 (zoom out), up -> -1 (zoom in)
          pendingDelta = 0;
          const cur = view.fov();
          const next = clamp(cur + dir * step, MIN_FOV, MAX_FOV);
          if (Math.abs(next - cur) < 1e-6) return;
          view.setParameters({ fov: next });
        } catch {}
      });
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (wheelRAF) cancelAnimationFrame(wheelRAF);
      target.removeEventListener("wheel", onWheel);
    };
  }, [activeSceneId, limits.ZOOM_STEP]);

  // Auto-close scene list on mobile when scene is selected
  const handleSceneSelect = useCallback((sceneId) => {
    const meta = scenes.find(s => s.id === sceneId);
    if (!meta) return;
    if (sceneId !== currentSceneIdRef.current) {
      setActiveSceneId(sceneId);
    }
    if (window.innerWidth <= 768) setIsSceneListOpen(false);
  }, [scenes]);

  // ----- render -------------------------------------------------------------
  return (
    <div className="VS-Root">
      {/* Scene List Toggle Button */}
      <button
        className="VS-SceneToggle"
        onClick={() => setIsSceneListOpen(!isSceneListOpen)}
        aria-label={isSceneListOpen ? "Close scene list" : "Open scene list"}
        title={isSceneListOpen ? "Close scene list" : "Open scene list"}
      >
        <FontAwesomeIcon icon={isSceneListOpen ? faTimes : faBars} />
      </button>

      {/* Scene List Overlay */}
      <SimpleBar className={`VS-SceneList Custom-Scrollbar ${isSceneListOpen ? "VS-SceneList--open" : ""}`}>
        <div className="VS-SceneList-Header">
          <span>Navigation Menu</span>
          <button className="VS-SceneList-Close" onClick={() => setIsSceneListOpen(false)} aria-label="Close scene list">
            <FontAwesomeIcon icon={faTimes} />
          </button>
        </div>
        <div className="VS-SceneList-Body">
          {scenes.map((s) => (
            <button
              key={s.id}
              className={"VS-SceneBtn" + (s.id === activeSceneId ? " VS-SceneBtn--active" : "")}
              onClick={() => handleSceneSelect(s.id)}
              disabled={isLoadingScene}
              title={sceneDisplayName(s.id)}
            >
              {sceneDisplayName(s.id)}
            </button>
          ))}
          {!isBooting && scenes.length === 0 && <div className="VS-EmptyNote">No published scenes.</div>}
        </div>
      </SimpleBar>

      {/* Scene List Backdrop (for mobile) */}
      {isSceneListOpen && <div className="VS-SceneList-Backdrop" onClick={() => setIsSceneListOpen(false)} />}

      {/* Marzipano Viewer - Full Screen */}
      <main className="VS-Viewer">
        {isLoadingScene && (
          <div className="VS-SpinnerOverlay">
            <div className="VS-Spinner" />
          </div>
        )}
        <div className="VS-Canvas" ref={panoRef} />
        <button
          className={`VS-IdleSpinBtn${idleSpinActive ? " IsActive" : ""}`}
          onClick={handleIdleSpinToggle}
          aria-label="Toggle auto rotate"
          title={idleSpinActive ? "Auto rotate On" : "Auto rotate Off"}
        >
          <FontAwesomeIcon icon={faRotate} />
        </button>
      </main>

      {/* MULTI-PRODUCT PICKER */}
      {Array.isArray(multiPickerItems) && (
        <div className="MultiPicker-Backdrop" onClick={closeMultiSelector}>
          <div className="MultiPicker-Panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="MultiPicker-Header">
              <h3 className="MultiPicker-Title">Select a product</h3>
              <button className="CloseBtnSV" onClick={closeMultiSelector} aria-label="Close multi-product list">
                ×
              </button>
            </div>

            <div className="MultiPicker-Grid">
              {multiPickerItems.map((p) => (
                <button key={p.id} className="MP-Card" onClick={() => handleSelectProduct(p)} title={p.name}>
                  <div className="MP-Thumb">
                    {p.imageUrl ? (
                      <Image src={p.imageUrl} alt={p.name} width={220} height={140} className="MP-Img" />
                    ) : (
                      <div className="MP-Img MP-Img--placeholder" />
                    )}
                  </div>
                  <div className="MP-Name">{p.name}</div>
                  <div className="MP-PriceRow">
                    <span className="MP-Price">₱{p.price}</span>
                    {p.originalPrice && p.originalPrice > p.price && (
                      <>
                        <span className="MP-Old">₱{p.originalPrice}</span>
                        <span className="MP-Disc">-{Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100)}%</span>
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Intro overlay → delegates to homepage modal */}
      <VSIntroSalesArrivals
        onClose={() => {}}
        onSelectProduct={(p) => handleSelectProduct(p)}
      />
    </div>
  );
}