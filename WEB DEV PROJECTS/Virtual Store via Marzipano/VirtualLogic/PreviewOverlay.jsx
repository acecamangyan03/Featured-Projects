// Preview Overlay.Jsx
import React, { useCallback, useEffect, useRef, useState } from "react"

// Firebase
import { db } from "@/firebase/firebaseconfig"
import { collection, getDocs, query, where, setDoc, doc, serverTimestamp } from "firebase/firestore"

// UI
import Image from "next/image"
import { FaStar, FaShoppingCart } from "react-icons/fa"
import { useRouter } from "next/router"

const PRODUCT_HOTSPOT_COLLECTION = "Product Hotspot"


const PreviewOverlay = ({
  show,
  onClose,
  Marzipano,
  activeSceneUrl,
  activeSceneId,
  imageList,
  resolveProductById
}) => {
  const router = useRouter()

  // Viewer refs
  const previewPanoRef = useRef(null)
  const previewViewerRef = useRef(null)
  const previewSceneRef = useRef(null)
  const previewHotspotElsRef = useRef([])

  // State
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [modalQuantity, setModalQuantity] = useState(1)
  const previewIdleSpinCancelRef = useRef(null)
  const previewLiveView = useRef(null)
  const [liveText, setLiveText] = useState("")
  const previewSceneMetaRef = useRef({ id: activeSceneId, url: activeSceneUrl })
  const previewViewCleanupRef = useRef(null)
  const [multiPickerItems, setMultiPickerItems] = useState(null)

  const openMultiSelector = useCallback(async (ids = []) => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!uniq.length) return;
  
    const products = await Promise.all(uniq.map(resolveProductById));
    setMultiPickerItems(products.filter(Boolean));  // Keep the list visible
  }, [resolveProductById]);
  
  const closeMultiSelector = useCallback(() => {
    setMultiPickerItems(null);  // Close the multi product selector
  }, []);
  
  const handleSelectProduct = (product) => {
    setSelectedProduct(product);  // Set selected product
    setModalQuantity(product.stock > 0 ? 1 : 0);
    // Don't close the multi selector here - let it stay open behind the product modal
  };

  // Fetch hotspots for a scene
  const fetchHotspotsForSceneId = useCallback(async (sceneId) => {
    const qLinks = query(collection(db, "hotspots"), where("sceneId", "==", sceneId))
    const qProducts = query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneId))
    const [snapLinks, snapProducts] = await Promise.all([getDocs(qLinks), getDocs(qProducts)])
    const links = snapLinks.docs.map((d) => ({ id: d.id, kind: "link", ...d.data() }))
    const products = snapProducts.docs.map((d) => ({ id: d.id, kind: "product", ...d.data() }))
    return [...links, ...products]
  }, [])

  const updatePreviewReadout = useCallback((view) => {
    try {
      const yaw = (view.yaw() * 180 / Math.PI).toFixed(1)
      const pitch = (view.pitch() * 180 / Math.PI).toFixed(1)
      const fov = (view.fov() * 180 / Math.PI).toFixed(1)
      const next = { yaw, pitch, fov }
      const prev = previewLiveView.current
      if (prev && prev.yaw === yaw && prev.pitch === pitch && prev.fov === fov) return
      previewLiveView.current = next
      setLiveText(`Current: Yaw ${yaw}°, Pitch ${pitch}°, FOV ${fov}°`)
    } catch {}
  }, [])

  const handleSetPreviewInitial = useCallback(async () => {
    try {
      const meta = previewSceneMetaRef.current
      if (!meta?.id || !previewSceneRef.current) return
      const view = previewSceneRef.current.view()
      const initialView = { yaw: view.yaw(), pitch: view.pitch(), fov: view.fov() }
      await setDoc(doc(db, "scenes", "main"), {
        imageUrl: meta.url,
        sceneId: meta.id,
        initialView,
        updatedAt: serverTimestamp()
      })
    } catch (e) {
      console.error("Preview set initial failed", e)
    }
  }, [])
  

  // Clear preview hotspots
  const clearPreviewHotspots = useCallback(() => {
    if (!previewSceneRef.current) return
    const container = previewSceneRef.current.hotspotContainer()
    if (!container) return
    previewHotspotElsRef.current.forEach((hotspot) => {
      try { container.destroyHotspot(hotspot) } catch {}
    })
    previewHotspotElsRef.current = []
  }, [])

  // Render preview hotspots
  const renderPreviewHotspots = useCallback((list) => {
    if (!previewSceneRef.current) return;
    clearPreviewHotspots();
    const container = previewSceneRef.current.hotspotContainer();
    if (!container) return;
    
    list.forEach((h) => {
      const isProduct = (h.kind || "link") === "product";
      const el = document.createElement("div");
      el.className = `HotspotDot${isProduct ? " ProductDot" : ""}`;
      el.title = isProduct ? "Product" : "Go to scene";
      
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
    
        // Check if it's a product hotspot
        const isProduct = (h.kind || "link") === "product";
        
        // Single product flow
        if (isProduct) {
            const productIds = Array.isArray(h.productIds) && h.productIds.length > 0
                ? h.productIds
                : (h.productId ? [h.productId] : []);
            
            if (productIds.length === 1) {
                const product = await resolveProductById(productIds[0]);
                if (product) {
                    setSelectedProduct(product);  // Show single product in modal
                }
            } else {
                await openMultiSelector(productIds);  // Show multi-selector modal if multiple products
            }
        } else {
            // Handle link hotspots (navigating to the next scene)
            const target = imageList.find(x => x.name === h.linkedScenarioId);
            if (target) loadPreviewScene(target.url, target.name);
        }
    });
  
      try {
        const hotspot = container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
        previewHotspotElsRef.current.push(hotspot);
      } catch (e) {
        console.error("Preview hotspot create failed", e);
      }
    });
  }, [clearPreviewHotspots, imageList, resolveProductById, openMultiSelector]);
  

  // Load preview scene
  const loadPreviewScene = useCallback(async (url, sceneId) => {
    if (!Marzipano || !previewViewerRef.current) return
    setIsLoadingPreview(true)
    try {
      const geometry = new Marzipano.EquirectGeometry([{ width: 4000 }])
      const limiter = Marzipano.RectilinearView.limit.traditional(1024, (150 * Math.PI) / 180)
      const view = new Marzipano.RectilinearView({ yaw: 0, pitch: 0, fov: Math.PI / 2 }, limiter)
      const source = Marzipano.ImageUrlSource.fromString(url)
      const scene = previewViewerRef.current.createScene({ source, geometry, view, pinFirstLevel: true })
      scene.switchTo()
      try { previewViewerRef.current?.resize() } catch {}
        if (previewViewCleanupRef.current) { try { previewViewCleanupRef.current() } catch {} previewViewCleanupRef.current = null }
          updatePreviewReadout(view)
          const debounced = (() => {
            let t
            return () => { clearTimeout(t); t = setTimeout(() => updatePreviewReadout(view), 120) }
          })()
          view.addEventListener("change", debounced)
          previewViewCleanupRef.current = () => view.removeEventListener("change", debounced)
          previewSceneMetaRef.current = { id: sceneId, url }
          
        if (previewIdleSpinCancelRef.current) previewIdleSpinCancelRef.current()
        previewIdleSpinCancelRef.current = startIdleSpin(scene.view(), previewPanoRef.current)
        previewSceneRef.current = scene
        const list = await fetchHotspotsForSceneId(sceneId)
        renderPreviewHotspots(list)
    } finally {
      setIsLoadingPreview(false)
    }
  }, [Marzipano, fetchHotspotsForSceneId, renderPreviewHotspots])

  // Start idle spin
  const startIdleSpin = (view, elem, speed = 0.00005) => {
    const target = elem || window
    if (!target || typeof target.addEventListener !== "function") return () => {}
    let spinning = true
    let last = null
    let rafId = null
    const step = t => {
      if (!spinning) return
      if (last != null) {
        const dt = t - last
        try { view.setYaw(view.yaw() + dt * speed) } catch {}
      }
      last = t
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)
    const stop = () => {
      if (!spinning) return
      spinning = false
      if (rafId) cancelAnimationFrame(rafId)
      try {
        target.removeEventListener("mousedown", stop)
        target.removeEventListener("touchstart", stop)
        target.removeEventListener("wheel", stop)
        window.removeEventListener("keydown", stop)
      } catch {}
    }
    try {
      target.addEventListener("mousedown", stop)
      target.addEventListener("touchstart", stop)
      target.addEventListener("wheel", stop)
      window.addEventListener("keydown", stop)
    } catch {}
    return stop
  }
  

  // Open on show
  useEffect(() => {
    if (!show) return
    const open = () => {
      if (!Marzipano || !previewPanoRef.current) return
      if (!previewViewerRef.current) {
        previewViewerRef.current = new Marzipano.Viewer(previewPanoRef.current)
      }
      if (activeSceneUrl && activeSceneId) {
        loadPreviewScene(activeSceneUrl, activeSceneId)
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(open))
  }, [show, Marzipano, activeSceneUrl, activeSceneId, loadPreviewScene])

  useEffect(() => {
    if (!show) return
    const onResize = () => { try { previewViewerRef.current?.resize() } catch {} }
    window.addEventListener("resize", onResize)
    requestAnimationFrame(() => onResize())
    return () => window.removeEventListener("resize", onResize)
  }, [show])

  // Reset on close
  useEffect(() => {
    if (show) return
    if (previewViewCleanupRef.current) { try { previewViewCleanupRef.current() } catch {} previewViewCleanupRef.current = null }
        setLiveText("")
    if (previewIdleSpinCancelRef.current) {
      try { previewIdleSpinCancelRef.current() } catch {}
      previewIdleSpinCancelRef.current = null
    }
    clearPreviewHotspots()
    previewSceneRef.current = null
    previewViewerRef.current = null
  }, [show, clearPreviewHotspots])

  // Quantity reset when product changes
  useEffect(() => {
    const s = Number(selectedProduct?.stock ?? 0)
    setModalQuantity(s > 0 ? 1 : 0)
  }, [selectedProduct])

  // Close modal
  const closeModal = useCallback(() => {
    setSelectedProduct(null);
    setModalQuantity(1);
    // Close the multi selector when the product modal is closed
    closeMultiSelector();
  }, [closeMultiSelector]);

  // Add to cart minimal guest flow
  const handleAddToCart = useCallback((product, quantity = 1) => {
    try {
      const storedCart = JSON.parse(localStorage.getItem("guestCart") || "[]")
      const existing = storedCart.find(i => i.id === product.id)
      const newItem = existing
        ? { ...existing, quantity: existing.quantity + quantity }
        : { ...product, quantity }
      const updated = [newItem, ...storedCart.filter(i => i.id !== product.id)]
      localStorage.setItem("guestCart", JSON.stringify(updated))
      try { window.dispatchEvent(new Event("cartUpdated")) } catch {}
    } catch (err) {
      console.error("Preview Add to Cart failed", err)
    }
  }, [])

  if (!show) return null

  return (
    <div className="PreviewOverlay" onClick={onClose}>
      <div className="PreviewBox" onClick={(e) => e.stopPropagation()}>
        <div className="PreviewHeader">
          <h2>Live Preview</h2>
          <button className="CloseBtn" onClick={onClose}>×</button>
        </div>
        <div className="PreviewViewerWrapper" >
          <div ref={previewPanoRef} className="PreviewViewer" ></div>
          {isLoadingPreview && <div className="SceneSpinnerOverlay"><div className="SceneSpinner"></div></div>}

          {/* Multi-product picker modal */}
          {Array.isArray(multiPickerItems) && (
          <div className="MultiPicker-Backdrop" onClick={closeMultiSelector}>
            <div className="MultiPicker-Panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <div className="MultiPicker-Header">
                <h3 className="MultiPicker-Title">Select a product</h3>
                <button className="CloseBtn" onClick={closeMultiSelector} aria-label="Close multi-product list">×</button>
              </div>

              <div className="MultiPicker-Grid">
                {multiPickerItems.map((p) => (
                  <button
                    key={p.id}
                    className="MP-Card"
                    onClick={() => handleSelectProduct(p)} // Use the function to select product
                    title={p.name}
                  >
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
                          <span className="MP-Disc">
                            -{Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100)}%
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}


          {selectedProduct && (
                  <div className="Homepage-Product-Modal-Backdrop" onClick={closeModal}>
                    <div
                      className="Homepage-Product-Modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="Homepage-Product-Modal-Title"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="Homepage-Product-Details-Main">
                        {/* Image */}
                        <div className="Homepage-Product-Image-Large">
                          {selectedProduct.imageUrl && (
                            <Image src={selectedProduct.imageUrl} alt={selectedProduct.name} width={400} height={400} style={{ objectFit: 'contain' }} />
                          )}
                        </div>
          
                        {/* Info */}
                        <div className="Homepage-Product-Info-Details">
                          <h1 id="Homepage-Product-Modal-Title" className="Homepage-Product-Title">
                            {selectedProduct.name}
                          </h1>
                          <div className="Homepage-Price-Info">
                            <span className="Homepage-Current-Price">₱{selectedProduct.price}</span>
                            {selectedProduct.originalPrice > selectedProduct.price && (
                              <>
                                <span className="Homepage-Original-Price">₱{selectedProduct.originalPrice}</span>
                                <span className="Homepage-Discount-Tag">
                                  -
                                  {Math.round(
                                    ((selectedProduct.originalPrice - selectedProduct.price) / selectedProduct.originalPrice) * 100
                                  )}%
                                </span>
                              </>
                            )}
                          </div>
          
                          {/* Ratings */}
                          <div className="Homepage-Product-Rating-Details">
                            {[...Array(5)].map((_, i) => (
                              <FaStar key={i} className={i < Math.floor(selectedProduct.rating || 0) ? 'Homepage-Star-Filled' : 'Homepage-Star-Empty'} />
                            ))}
                            <span className="Homepage-Reviews-Count-Details">({selectedProduct.reviews || 0} reviews)</span>
                          </div>
          
                          {/* Description */}
                          <p className="Homepage-Product-Description">
                            <strong>Description:</strong> {selectedProduct.description || 'No description provided.'}
                          </p>
          
                          {/* Quantity */}
                          <div className="Homepage-Quantity-Selector">
                            <span>Quantity:</span>
                            <button className="Homepage-Quantity-Button" onClick={() => setModalQuantity((prev) => Math.max(1, prev - 1))} disabled={modalQuantity <= 1}>
                              −
                            </button>
                            <span className="Homepage-Quantity-Value">{selectedProduct?.stock === 0 ? 0 : modalQuantity}</span>
                            <button
                              className="Homepage-Quantity-Button"
                              onClick={() => setModalQuantity((prev) => prev + 1)}
                              disabled={modalQuantity >= (selectedProduct?.stock || 0)}
                            >
                              ＋
                            </button>
                            <span className="Homepage-Quantity-Stock">(In Stock: {selectedProduct?.stock || 0})</span>
                          </div>
          
                          {/* Actions */}
                          <div className="Homepage-Action-Buttons">
                            <button
                              className="Homepage-Button-Add-To-Cart"
                              disabled={selectedProduct?.stock === 0}
                              onClick={() => {
                                if (selectedProduct?.stock === 0) return;
                                handleAddToCart(selectedProduct, modalQuantity);
                                closeModal();
                              }}
                            >
                              <FaShoppingCart /> Add to Cart
                            </button>
          
                            <button
                              className="Homepage-Button-Buy-Now"
                              disabled={selectedProduct?.stock === 0}
                              onClick={() => {
                                if (selectedProduct?.stock === 0) return;
                                const tempItem = { ...selectedProduct, quantity: modalQuantity };
                                localStorage.setItem('buyNowItem', JSON.stringify(tempItem));
                                localStorage.removeItem('selectedCheckoutItems');
                                closeModal();
                                setTimeout(() => {
                                  router.push('/homepage?view=checkout');
                                }, 50);
                              }}
                            >
                              Buy Now
                            </button>
                          </div>
                        </div>
                      </div>
                      <button className="Homepage-Modal-Close-Button" onClick={closeModal} aria-label="Close modal">
                        ×
                      </button>
                    </div>
                  </div>
                )}
        </div>
        <div className="PreviewNote">This is a preview. Changes are not saved here.</div>
      </div>
    </div>
  )
}

export default PreviewOverlay
