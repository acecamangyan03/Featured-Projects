// HotspotLogic.js — full file with per-type calibration and tilted link icon
import React from "react"
import { createRoot } from "react-dom/client"
import { collection, doc, getDocs, query, where, updateDoc, serverTimestamp } from "firebase/firestore"

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faCircleChevronUp } from "@fortawesome/free-solid-svg-icons"

export const STAGING_SESSIONS = "editorSessions"
export const STAGING_OPS_SUB = "stagingOps"
export const PRODUCT_HOTSPOT_COLLECTION = "Product Hotspot"
export const isProductHotspot = h => (h?.kind || "link") === "product"
export const getHotspotDocRef = (db, h) =>
  doc(db, isProductHotspot(h) ? PRODUCT_HOTSPOT_COLLECTION : "hotspots", h.id)

// Visual anchors for icon centering if needed later
export const LinkAnchorPx = { dx: 5, dy: 5 }
export const ProductAnchorPx = { dx: 0, dy: 0 }
export const getAnchorPx = h => isProductHotspot(h) ? ProductAnchorPx : LinkAnchorPx

// Separate placement calibration for link vs product
export const LinkPlacementCalibration = {
  dx: -10,
  dy: -10,
  dYawDeg: -10,
  dPitchDeg: 15,
}

export const ProductPlacementCalibration = {
  dx: 0,
  dy: 0,
  dYawDeg: 0,
  dPitchDeg: 0
}

export const getPlacementCalibration = h =>
  isProductHotspot(h) ? ProductPlacementCalibration : LinkPlacementCalibration

// Optional inspector for degrees per pixel at a screen point
export const measureDegreesPerPixel = (view, x, y) => {
  try {
    const c0 = view.screenToCoordinates({ x, y })
    const cx = view.screenToCoordinates({ x: x + 1, y })
    const cy = view.screenToCoordinates({ x, y: y + 1 })
    if (!c0 || !cx || !cy) return null
    const k = 180 / Math.PI
    return {
      yawPerPxX: (cx.yaw - c0.yaw) * k,
      yawPerPxY: (cy.yaw - c0.yaw) * k,
      pitchPerPxX: (cx.pitch - c0.pitch) * k,
      pitchPerPxY: (cy.pitch - c0.pitch) * k
    }
  } catch (e) { console.error("measureDegreesPerPixel failed", e); return null }
}

const getHotspotProductIds = h => {
  if (!isProductHotspot(h)) return []
  if (Array.isArray(h.productIds) && h.productIds.length > 0) return h.productIds
  if (h.productId && typeof h.productId === "string") return [h.productId]
  return []
}

const mountLinkIcon = wrap => {
  try {
    const root = createRoot(wrap)
    root.render(<FontAwesomeIcon icon={faCircleChevronUp} className="LinkDotChevron" />)
    return root
  } catch (e) {
    console.error("Render link icon failed", e)
    return null
  }
}

export async function loadHotspotsForScene({ db, sceneId, token, sceneLoadTokenRef, activeSceneIdRef, setHotspots }) {
  try {
    const qLinks = query(collection(db, "hotspots"), where("sceneId", "==", sceneId))
    const qProducts = query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneId))
    const [snapLinks, snapProducts] = await Promise.all([getDocs(qLinks), getDocs(qProducts)])
    if (token !== sceneLoadTokenRef.current) return
    if (sceneId !== activeSceneIdRef.current) return
    const links = snapLinks.docs.map(d => ({ id: d.id, kind: "link", ...d.data() }))
    const products = snapProducts.docs.map(d => ({ id: d.id, kind: "product", ...d.data() }))
    const merged = [...links, ...products].filter(x => typeof x.yaw === "number" && typeof x.pitch === "number")
    setHotspots(merged)
  } catch (error) {
    console.error("Failed to load hotspots for scene:", sceneId, error)
  }
}

export function clearHotspotsFromViewer(currentSceneRef, hotspotElsRef) {
  if (!currentSceneRef.current) return
  const container = currentSceneRef.current.hotspotContainer()
  if (!container) return

  const map = hotspotElsRef.current || {}
  Object.keys(map).forEach(id => {
    const entry = map[id]
    try {
      if (entry?.hotspot) container.destroyHotspot(entry.hotspot)
      if (entry?.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
    } catch (e) { console.error("Failed to destroy hotspot", id, e) }
    delete map[id]
  })
  hotspotElsRef.current = {}
}


export function safeDestroyHotspot(currentSceneRef, hotspotElsRef, id, deletedHotspotIdsRef) {
  if (!currentSceneRef.current) return
  const container = currentSceneRef.current.hotspotContainer()
  const hotspotData = hotspotElsRef.current[id]

  if (hotspotData && hotspotData.root) {
    try { hotspotData.root.unmount() } catch (e) {
      console.error("Failed to unmount hotspot icon root safely:", id, e)
    }
  }
  if (hotspotData && hotspotData.hotspot && container) {
    try { container.destroyHotspot(hotspotData.hotspot) } catch (e) {
      console.error("Failed to destroy hotspot safely:", id, e)
    }
  }
  delete hotspotElsRef.current[id]
  deletedHotspotIdsRef.current.add(id)
}

export function renderHotspotsOnScene({
  currentSceneRef,
  hotspots,
  activeSceneId,
  addLinkMode,
  addProductMode,
  movingHotspotId,
  moveHotspotId,
  isLoadingScene,
  hotspotElsRef,
  openHotspotMenu,
  onHotspotMouseDown,
  productsById
}) {
  if (!currentSceneRef.current) return
  if (isLoadingScene) return

  clearHotspotsFromViewer(currentSceneRef, hotspotElsRef)

  const container = currentSceneRef.current.hotspotContainer()
  if (!container) return

  const disabled = addLinkMode || addProductMode || movingHotspotId

  hotspots.forEach(h => {
    if (h.sceneId !== activeSceneId) return

    const isProduct = isProductHotspot(h)
    const el = document.createElement("div")

    let className = "HotspotDot"
    if (moveHotspotId === h.id) className += " IsDraggable"
    className += isProduct ? " ProductDot" : " LinkDot"
    el.className = className

    let linkIconRoot = null
    if (!isProduct) {
      const wrap = document.createElement("div")
      wrap.className = "LinkDotIconWrap"
      const deg = Number(h.rotationDeg || 0)
      try { wrap.style.setProperty("--rot", `${deg}deg`) } catch {}
      el.appendChild(wrap)
      linkIconRoot = mountLinkIcon(wrap)
    }

    if (isProduct) {
      const ids = getHotspotProductIds(h)
      const names = ids.map(pid => productsById.get(pid)?.name).filter(Boolean)
      const count = ids.length
      el.title = count === 1 && names.length === 1 ? names[0] : count > 1 ? `${count} Products` : "Product Hotspot"
    } else {
      el.title = "Link to scene"
      const deg = Number(h.rotationDeg || 0)
      try { el.style.setProperty("--rot", `${deg}deg`) } catch {}
    }

    el.style.pointerEvents = disabled ? "none" : "auto"

    el.addEventListener("click", e => {
      if (disabled) return
      e.stopPropagation()
      openHotspotMenu(h.id, h)
    })

    el.addEventListener("mousedown", e => {
      if (disabled) return
      e.preventDefault()
      onHotspotMouseDown(h.id, e)
    })

    try {
      const hotspotObj = container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch })
      hotspotElsRef.current[h.id] = { el, hotspot: hotspotObj, root: linkIconRoot }
    } catch (e) {
      console.error("Failed to create hotspot:", h.id, e)
    }
  })
}

/* replace the whole function with this updated version */
export async function handleMovePlaceClickOnScene({
  e,
  movingHotspotId,
  currentSceneRef,
  panoRef,
  hotspotElsRef,
  setHotspots,
  hotspots,
  db,
  stopMenuTracking,
  setSelectedHotspotId,
  setMoveHotspotId,
  setMovingHotspotId,
  onAfterMove // callback for history tracking
}) {
  if (!movingHotspotId || !currentSceneRef.current || !panoRef.current) return

  const prevHotspot = hotspots.find(x => x.id === movingHotspotId)
  if (!prevHotspot) return

  const rect = panoRef.current.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const coords = currentSceneRef.current.view().screenToCoordinates({ x, y })
  if (!coords) return

  // Store previous position for history
  const prevPosition = { yaw: prevHotspot.yaw, pitch: prevHotspot.pitch }

  const entry = hotspotElsRef.current[movingHotspotId]
  if (entry && entry.hotspot) {
    try {
      entry.hotspot.setPosition({ yaw: coords.yaw, pitch: coords.pitch })
    } catch (err) {
      console.error("Failed to update hotspot position", err)
    }
  }

  // Update local state
  setHotspots(prevArr => prevArr.map(h =>
    h.id === movingHotspotId ? { ...h, yaw: coords.yaw, pitch: coords.pitch } : h
  ))

  try {
    // Save to Firebase
    await updateDoc(getHotspotDocRef(db, prevHotspot), {
      yaw: coords.yaw,
      pitch: coords.pitch,
      updatedAt: serverTimestamp()
    })

    // Call history tracking callback if provided
    if (typeof onAfterMove === "function") {
      await onAfterMove({
        hotspot: { ...prevHotspot, yaw: coords.yaw, pitch: coords.pitch },
        id: movingHotspotId,
        kind: prevHotspot.kind || (isProductHotspot(prevHotspot) ? "product" : "link"),
        prev: prevPosition,
        next: { yaw: coords.yaw, pitch: coords.pitch }
      })
    }
  } catch (err) {
    console.error("Failed to save hotspot position", err)
  }

  // Reset move state
  stopMenuTracking()
  setSelectedHotspotId(null)
  setMoveHotspotId(null)
  setMovingHotspotId(null)
}