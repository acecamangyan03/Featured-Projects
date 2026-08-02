/* Admin editor with upload, scene order, search, drag, hotspots, and preview */

/* React */
import React, { 
  useEffect, useRef, useState, useCallback, useMemo, 
  memo
} from "react"

/* Firebase */
import { db, storage } from "@/firebase/firebaseconfig"
import { 
  doc, setDoc, collection, addDoc, getDoc, getDocs, onSnapshot, 
  query, where, orderBy, updateDoc, deleteDoc, serverTimestamp, writeBatch 
} from "firebase/firestore"
import { ref, uploadBytes, listAll, getDownloadURL, deleteObject } from "firebase/storage"
import { onSnapshot as onFsSnapshot } from "firebase/firestore"

/* Third party */
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faRotateRight,
  faPen,
  faTrash,
  faChevronUp,
  faCircleXmark,
  faCircleCheck,
  faGripVertical,
  faStar,
  faSearch,
  faPlus,
  faEye,
  faStreetView,
} from "@fortawesome/free-solid-svg-icons"
import SimpleBar from 'simplebar-react'
import 'simplebar-react/dist/simplebar.min.css'

/* Local */
import PreviewOverlay from "./VirtualLogic/PreviewOverlay"
import {
  PRODUCT_HOTSPOT_COLLECTION,
  isProductHotspot,
  getHotspotDocRef,
  clearHotspotsFromViewer,
  safeDestroyHotspot,
  renderHotspotsOnScene,
  loadHotspotsForScene,
  handleMovePlaceClickOnScene,
  STAGING_SESSIONS,
  STAGING_OPS_SUB
} from "./VirtualLogic/HotspotLogic"
import {
  ToastProvider,
  useToast,
  GlobalBusyOverlay as BlockingOverlay,
  ConfirmModal,
  withBusy,
  LiveViewDisplay
} from "./VirtualLogic/EditorUIComponents"
import { HistoryManager } from "./VirtualLogic/HistoryManager"
import { HistoryToolbar, useHistoryKeyboardShortcuts } from "./VirtualLogic/HistoryComponents"

function useChunkedRenderCount(total, showAll) {
  const [count, setCount] = React.useState(showAll ? Math.min(total, 24) : Math.min(total, 2))
  React.useEffect(() => {
    if (!showAll) { setCount(Math.min(total, 2)); return }
    if (total <= 40) { setCount(total); return }
    setCount(Math.min(total, 24))
    let canceled = false
    const schedule = window.requestIdleCallback || (cb => setTimeout(cb, 0))
    const pump = () => {
      if (canceled) return
      setCount(c => {
        const next = Math.min(total, c + 24)
        if (next < total) schedule(pump)
        return next
      })
    }
    schedule(pump)
    return () => { canceled = true }
  }, [total, showAll])
  return count
}

/* MEMOIZED card component, keep it OUTSIDE the main component */
const SceneCard = memo(function SceneCard({
  scene,
  indexInFiltered,
  isActive,
  isDragging,
  isDefault,
  hotspotCount,
  imageIndex,
  busy,
  isRenaming,
  h,
  thumbSrc
}) {
  return (
    <div
      className={`SceneCard ${isActive ? "Active" : ""} ${isDragging ? "Dragging" : ""}`}
      data-scene-id={scene.name}
      role="listitem"
      draggable={!busy && !isRenaming}
      onDragStart={e => h.handleSceneDragStart(e, scene.name)}
      onDragEnd={h.handleSceneDragEnd}
      onDragOver={e => h.handleSceneDragOver(e, indexInFiltered)}
      onDrop={e => h.handleSceneDrop(e, indexInFiltered)}
      aria-grabbed={isDragging ? "true" : "false"}
      aria-dropeffect={!isRenaming && isDragging ? "move" : "none"}
      onMouseEnter={() => h.prefetch(scene.url)}
      onFocus={() => h.prefetch(scene.url)}
    >
      <div className="SceneMeta">
        <div className="SceneHeader">
          <button
            className="DragHandle"
            tabIndex={0}
            title={isRenaming ? "Reorder disabled while renaming" : "Drag or use arrows"}
            disabled={!!busy || isRenaming}
            onKeyDown={e => h.handleSceneKeyDown(e, scene.name, indexInFiltered)}
            onClick={h.stopCardClick}
            aria-label={`Reorder ${scene.name.replace(/\.[^/.]+$/, "")} scene`}
          >
            <FontAwesomeIcon icon={faGripVertical} />
          </button>
          <div className="SceneName" title={scene.name}>
            {scene.name.replace(/\.[^/.]+$/, "")}
          </div>
        </div>

        <div className="SceneInfo">
          {scene.isEditing && (
            <input
              className="RenameInput"
              value={scene.draftBase ?? scene.name.replace(/\.[^/.]+$/, "")}
              onClick={h.stopCardClick}
              onChange={e => h.setDraftBase(imageIndex, e.target.value)}
              onKeyDown={async e => {
                if (e.key === "Enter") await h.handleRenameConfirm(imageIndex)
                else if (e.key === "Escape") h.cancelRename(imageIndex)
              }}
              autoFocus
              disabled={!!busy}
            />
          )}
        </div>

        <div className="SceneActions">
          {!isDefault && (
            <button
              className="IconButton"
              onClick={e => { h.stopCardClick(e); if (!busy) h.setAsDefault(scene.name) }}
              disabled={!!busy}
              aria-pressed={isDefault ? "true" : "false"}
              title="Set default"
            >
              <FontAwesomeIcon icon={faStar} />
            </button>
          )}

          {!scene.isEditing ? (
            <button
              className="IconButton"
              onClick={e => { h.stopCardClick(e); if (!busy) h.beginRename(imageIndex) }}
              disabled={!!busy}
              title="Rename"
              aria-label="Rename"
            >
              <FontAwesomeIcon icon={faPen} />
            </button>
          ) : (
            <>
              <button
                className="IconButton"
                onClick={e => { h.stopCardClick(e); if (!busy) h.cancelRename(imageIndex) }}
                disabled={!!busy}
                title="Cancel rename"
                aria-label="Cancel rename"
              >
                <FontAwesomeIcon icon={faCircleXmark} />
              </button>
              <button
                className="IconButton"
                onClick={e => { h.stopCardClick(e); if (!busy) h.handleRenameConfirm(imageIndex) }}
                disabled={!!busy}
                title="Confirm rename"
                aria-label="Confirm rename"
              >
                <FontAwesomeIcon icon={faCircleCheck} />
              </button>
            </>
          )}

          <button
            className="IconButton Danger"
            onClick={e => { h.stopCardClick(e); if (!busy) h.showDeleteConfirmation(indexInFiltered) }}
            disabled={!!busy}
            title="Delete"
            aria-label="Delete"
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
        </div>
      </div>

      <div className="SceneThumbWrap">
        {isDefault && (<div className="DefaultBadge" title="Default scene"><FontAwesomeIcon icon={faStar} /></div>)}
        <img
          className="SceneThumb"
          src={thumbSrc}
          alt={`${scene.name} preview`}
          loading="lazy"
          decoding="async"
        />
      </div>
    </div>
  )
})


/* Product mapper */
const MapProductFromFirestore = (docSnap) => {
  const d = docSnap.data() || {}
  const resolvedName =
    (typeof d.productName === "string" && d.productName.trim()) ||
    (typeof d.name === "string" && d.name.trim()) ||
    (typeof d.title === "string" && d.title.trim()) ||
    (typeof d.ProductName === "string" && d.ProductName.trim()) ||
    (typeof d.product_name === "string" && d.product_name.trim()) ||
    docSnap.id
  const discountActive = d.isDiscountEnabled === true
  const price = discountActive ? (d.discountedPrice ?? Math.floor(d.price * (1 - (d.manualDiscountPercent ?? 0) / 100))) : d.price
  const discountText = discountActive && (d.manualDiscountPercent || d.discountedPrice)
    ? `${d.manualDiscountPercent ?? Math.round(((d.price - price) / d.price) * 100)}% OFF`
    : null
  return {
    id: docSnap.id,
    name: resolvedName,
    imageUrl: d.imageUrl || "",
    price: Number(price) || 0,
    originalPrice: discountActive ? Number(d.price) || null : null,
    discount: discountText,
    description: d.description || "",
    rating: Number(d.rating ?? 0),
    reviews: Number(d.reviews ?? 0),
    category: d.category || "Uncategorized",
    stock: Number(d.stock ?? 0),
    isNewArrival: d.isNewArrival ?? false,
    isDiscountEnabled: d.isDiscountEnabled ?? false,
    discountedPrice: Number(d.discountedPrice) || null,
    rawPrice: d.price
  }
}

/* Scene order helper */

const UpdateSceneOrder = async (idsInNewOrder) => {
  try {
    const batch = writeBatch(db)
    idsInNewOrder.forEach((sceneId, index) => {
      const sceneRef = doc(db, "sceneOrder", sceneId)
      batch.set(sceneRef, { sceneId, order: index, parentId: null, updatedAt: serverTimestamp() }, { merge: true })
    })
    await batch.commit()
  } catch (error) {
    console.error("Failed to update scene order", error)
    throw error
  }
}
const measurePerformance = (operation, callback) => {
  if (process.env.NODE_ENV === 'development') {
    const start = performance.now()
    const result = callback()
    const end = performance.now()
    console.log(`${operation} took ${(end - start).toFixed(2)}ms`)
    return result
  }
  return callback()
}
function useSceneImagePreloader(maxEntries = 6){
  const cacheRef = React.useRef(new Map())
  const orderRef = React.useRef([])
  const controllersRef = React.useRef(new Map())

  const getCachedUrl = React.useCallback((src, key) => {
    const rec = cacheRef.current.get(key || src)
    return rec?.objectUrl || null
  }, [])

  const prefetch = React.useCallback(async (src, key) => {
    try{
      if (!src) return
      const cacheKey = key || src
      if (cacheRef.current.has(cacheKey)) return
      if (document.visibilityState === "hidden") return
      try {
        const c = navigator?.connection
        if (c && (c.saveData || /2g/.test(c.effectiveType || ""))) return
      } catch {}

      const ctrl = new AbortController()
      controllersRef.current.set(cacheKey, ctrl)

      const idle = typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback
        : cb => setTimeout(cb, 0)

      idle(async () => {
        try{
          const res = await fetch(src, { cache: "force-cache", mode: "cors", signal: ctrl.signal })
          if (!res.ok) throw new Error(`Prefetch failed ${res.status}`)
          const blob = await res.blob()
          const objectUrl = URL.createObjectURL(blob)
          cacheRef.current.set(cacheKey, { objectUrl, size: blob.size })
          orderRef.current.push(cacheKey)
          while (orderRef.current.length > maxEntries){
            const old = orderRef.current.shift()
            const rec = cacheRef.current.get(old)
            if (rec?.objectUrl) URL.revokeObjectURL(rec.objectUrl)
            cacheRef.current.delete(old)
          }
        }catch(e){
          if (e?.name !== "AbortError") console.error("Prefetch error", e)
        }finally{
          controllersRef.current.delete(cacheKey)
        }
      })
    }catch(e){
      console.error("Prefetch setup failed", e)
    }
  }, [maxEntries])

  const clear = React.useCallback(() => {
    try{
      for (const [k, rec] of cacheRef.current){
        if (rec?.objectUrl) URL.revokeObjectURL(rec.objectUrl)
      }
      cacheRef.current.clear()
      orderRef.current = []
      for (const ctrl of controllersRef.current.values()) ctrl.abort()
      controllersRef.current.clear()
    }catch(e){
      console.error("Prefetch clear failed", e)
    }
  }, [])

  return React.useMemo(() => ({ prefetch, getCachedUrl, clear }), [prefetch, getCachedUrl, clear])
}

// --- Perf profile (additive) ---
function usePerfProfile() {
  const [profile, setProfile] = React.useState("balanced");
  const limits = React.useMemo(() => {
    if (profile === "high") {
      return {
        DPR_CAP: 2.0,
        MAX_FACE: 4096,          // upper bound for view 'face' used by limiter
        ZOOM_STEP: 0.07,
        PREFETCH_ENTRIES: 10,
        USE_THUMB_PREVIEW: false
      };
    }
    if (profile === "eco") {
      return {
        DPR_CAP: 1.0,
        MAX_FACE: 2048,
        ZOOM_STEP: 0.05,
        PREFETCH_ENTRIES: 6,
        USE_THUMB_PREVIEW: true
      };
    }
    // balanced
    return {
      DPR_CAP: 1.5,
      MAX_FACE: 3072,
      ZOOM_STEP: 0.06,
      PREFETCH_ENTRIES: 8,
      USE_THUMB_PREVIEW: true
    };
  }, [profile]);

  React.useEffect(() => {
    try {
      const dm = navigator.deviceMemory || 4;
      const hc = navigator.hardwareConcurrency || 4;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const eff = navigator.connection?.effectiveType || "";
      // Heuristic buckets
      if (eff.includes("2g") || eff.includes("3g") || dm <= 3 || hc <= 4) {
        setProfile("eco");
      } else if (dpr >= 2.5 || dm <= 5) {
        setProfile("balanced");
      } else {
        setProfile("high");
      }
    } catch {
      setProfile("balanced");
    }
  }, []);

  return { profile, limits };
}



const VirtualEditorCore = () => {
  const toast = useToast()
  const [busyState, setBusyState] = useState(null)
  const loadSceneRef = useRef(null)
  const thumbCacheRef = useRef(new Map())

  /* ALL STATE DECLARATIONS - MOVED TO TOP */
  const [imageList, setImageList] = useState([])
  const [sceneOrder, setSceneOrder] = useState([])
  const [sceneSearch, setSceneSearch] = useState("")
  const [sceneSearchInput, setSceneSearchInput] = useState("")
  const [showAllScenes, setShowAllScenes] = useState(false)
  const [activeSceneUrl, setActiveSceneUrl] = useState("")
  const [activeSceneId, setActiveSceneId] = useState("")
  const [isLoadingScene, setIsLoadingScene] = useState(false)
  const [sceneHotspotCounts, setSceneHotspotCounts] = useState({})
  const [draggedSceneId, setDraggedSceneId] = useState(null)
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState(-1)
  
  /* Hotspots */
  /* Hotspots */
  const [hotspots, setHotspots] = useState([])
  const hotspotsRef = useRef([])
  useEffect(() => { hotspotsRef.current = hotspots }, [hotspots])
  const [selectedHotspotId, setSelectedHotspotId] = useState(null)
  const [menuPos, setMenuPos] = useState(null)
  const [moveHotspotId, setMoveHotspotId] = useState(null)
  const [movingHotspotId, setMovingHotspotId] = useState(null)
  const [addLinkMode, setAddLinkMode] = useState(false)
  const [addProductMode, setAddProductMode] = useState(false)
  const [pendingHotspot, setPendingHotspot] = useState(null)
  const [pendingProductHotspot, setPendingProductHotspot] = useState(null)
  const lastLinkTargetRef = useRef("")
  const menuSelectedOrderRef = useRef([])
  
  /* Products */
  const [products, setProducts] = useState([])
  const [productSearch, setProductSearch] = useState("")
  const [pendingProductSelection, setPendingProductSelection] = useState(new Set())
  const [menuProductSelection, setMenuProductSelection] = useState(new Set())
  const [menuProductSearch, setMenuProductSearch] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmPayload, setConfirmPayload] = useState(null)
  
  /* Upload */
  const [showPopup, setShowPopup] = useState(false)
  const [uploadFile, setUploadFile] = useState(null)
  const [previewURL, setPreviewURL] = useState("")
  const [renameMode, setRenameMode] = useState(false)
  const [customFileName, setCustomFileName] = useState("")
  const [imageError, setImageError] = useState("")
  
  /* Modals */
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmRename, setConfirmRename] = useState(null)
  const isDeletingRef = useRef(false)

  const guardBusy = useCallback(msg => {
    if (!busyState) return false
    toast.showInfo(msg || busyState?.label || 'Working')
    return true
  }, [busyState, toast])
  
  /* Preview */
  const [showPreview, setShowPreview] = useState(false)
  
  /* Live view */
  const [liveView, setLiveView] = useState(null)
  const [stagingOpsCount, setStagingOpsCount] = useState(0)
  const [showStagingConfirm, setShowStagingConfirm] = useState(false)
  
  /* History Management */
  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
    history: [],
    currentIndex: -1
  })
  const [isApplyingHistory, setIsApplyingHistory] = useState(false)
  
  /* ALL REFS - MOVED TO TOP */
  const historyManagerRef = useRef(null)
  const panoRef = useRef(null)
  const viewerRef = useRef(null)
  const currentSceneRef = useRef(null)
  const liveViewRef = useRef(null)
  const hotspotElsRef = useRef({})
  const deletedHotspotIdsRef = useRef(new Set())
  const selectedHotspotRef = useRef(null)
  const menuTrackCleanupRef = useRef(null)
  const draggingRef = useRef({ id: null })
  const sceneLoadTokenRef = useRef(0)
  const activeSceneIdRef = useRef("")
  const getWheelTarget = () => {
    if (!viewerRef.current) return panoRef.current
    try {
      const stage = viewerRef.current.stage()
      if (stage && stage.domElement) return stage.domElement()
    } catch {}
    return panoRef.current
  }
  
  

  const dragMoveTimeoutRef = useRef(null)

  const editorSessionIdRef = useRef(null)
  const hasStagedOpsRef = useRef(false)


  const { profile, limits } = usePerfProfile();

  const { prefetch, getCachedUrl, clear } = useSceneImagePreloader(limits.PREFETCH_ENTRIES);
  useEffect(() => () => clear(), [clear]);
  

  const ensureEditorSession = useCallback(async () => {
    let id = editorSessionIdRef.current
    if (!id) {
      id = localStorage.getItem("EditorSessionId")
      if (!id) {
        id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`
        localStorage.setItem("EditorSessionId", id)
      }
      editorSessionIdRef.current = id
      try {
        await setDoc(doc(db, STAGING_SESSIONS, id), { startedAt: serverTimestamp(), active: true }, { merge: true })
      } catch (e) { console.error("Staging session init failed", e) }
    }
    return id
  }, [])
  const stageOp = useCallback(async (op) => {
    try {
      const sid = await ensureEditorSession()
      await addDoc(collection(db, STAGING_SESSIONS, sid, STAGING_OPS_SUB), {
        ...op,
        ts: serverTimestamp()
      })
      hasStagedOpsRef.current = true
    } catch (e) { console.error("Stage op failed", e) }
  }, [ensureEditorSession])
    
    /* VIEWER STATE */
    const [Marzipano, setMarzipano] = useState(null)
    const MIN_FOV = 100 * Math.PI / 180;
    const MAX_FOV = 120 * Math.PI / 180;

    // Keep a handle to the current view for wheel-zoom
    const viewRef = useRef(null);
  
  /* Guards and tokens - UPDATED */
  useEffect(() => { activeSceneIdRef.current = activeSceneId }, [activeSceneId])

  /* Menu geometry */
  const LINK_ARC = { radius: 62, angles: [-160, -110, -60, -10], xOffset: 13, yOffset: 20, panelOffset: 55 }
  const PRODUCT_ARC = { radius: 52, angles: [-150, -90, -30], xOffset: -9, yOffset: 1, panelOffset: 35 }
  /* Busy */

  /* BASIC UTILITY FUNCTIONS - MOVED UP */

  const withBusyWrapper = useCallback((fn, label) => withBusy(fn, label, setBusyState, toast), [toast])
  
  const stopMenuTracking = useCallback(() => {
    try { menuTrackCleanupRef.current?.() } catch {}
    menuTrackCleanupRef.current = null
  }, [])

  /* Ordered scenes */
  const orderedScenes = useMemo(() => {
    if (imageList.length === 0) return []
    const orderMap = new Map()
    sceneOrder.forEach(({ sceneId, order }) => orderMap.set(sceneId, order))
    return [...imageList].sort((a, b) => {
      const orderA = orderMap.get(a.name) ?? 9999
      const orderB = orderMap.get(b.name) ?? 9999
      return orderA - orderB
    })
  }, [imageList, sceneOrder])

  /* Filtered scenes */
  const filteredScenes = useMemo(() => {
    if (!sceneSearch.trim()) return orderedScenes
    const search = sceneSearch.toLowerCase()
    return orderedScenes.filter(s => s.name.toLowerCase().includes(search))
  }, [orderedScenes, sceneSearch])

  const visibleCount = useChunkedRenderCount(filteredScenes.length, showAllScenes);
  const scenesToRender = useMemo(() => {
    const base = filteredScenes;
    if (!showAllScenes) return base.slice(0, Math.min(2, visibleCount));
    return base.slice(0, visibleCount);
  }, [filteredScenes, showAllScenes, visibleCount]);

  const filteredIndexMap = useMemo(() => {
    const m = new Map()
    filteredScenes.forEach((s, i) => m.set(s.name, i))
    return m
  }, [filteredScenes])

  const isRenaming = useMemo(() => imageList.some(i => i.isEditing), [imageList])

  /* HOTSPOT COUNT FUNCTIONS - FIXED ORDER */

  const handleHistoryError = useCallback((error, operation) => {
    console.error(`History ${operation} failed:`, error)
    toast.showError(`Failed to ${operation}. Please try again.`)
    setIsApplyingHistory(false)
  }, [toast])

  const countHotspotsForScene = useCallback(async (sceneName) => {
    try {
      const [linkQ, prodQ, linkTargetQ] = [
        query(collection(db, "hotspots"), where("sceneId", "==", sceneName)),
        query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneName)),
        query(collection(db, "hotspots"), where("linkedScenarioId", "==", sceneName))
      ]
      const [linkSnap, prodSnap, linkTargetSnap] = await Promise.all([getDocs(linkQ), getDocs(prodQ), getDocs(linkTargetQ)])
      return linkSnap.size + prodSnap.size + linkTargetSnap.size
    } catch (e) {
      console.error("Count hotspots failed", e)
      return 0
    }
  }, [])

  const fetchHotspotCounts = useCallback(async () => {
    if (imageList.length === 0) return
    try {
      const counts = {}
      await Promise.all(imageList.map(async s => { counts[s.name] = await countHotspotsForScene(s.name) }))
      setSceneHotspotCounts(counts)
    } catch (e) { console.error("Fetch hotspot counts failed", e) }
  }, [imageList, countHotspotsForScene])

  /* Order fetch */
  const fetchSceneOrder = useCallback(async () => {
    try {
      const orderQuery = query(collection(db, "sceneOrder"), orderBy("order"))
      const snapshot = await getDocs(orderQuery)
      const orderData = snapshot.docs.map(d => ({
        sceneId: d.id,
        order: d.data().order || 0,
        parentId: d.data().parentId || null
      }))
      setSceneOrder(orderData)
    } catch (error) {
      console.error("Failed to fetch scene order", error)
      setSceneOrder([])
    }
  }, [])

  const captureSceneManifest = useCallback(() => ({
    imageList,
    sceneOrder,
    activeSceneId
  }), [imageList, sceneOrder, activeSceneId])

  /* History wrapper, saves snapshot after the operation finishes */
  const withHistoryTracking = useCallback((operation, actionType, description) => {
    return async (...args) => {
      if (isApplyingHistory) return operation(...args)
      
      const result = await operation(...args)
      
      // Create snapshot immediately, no delay
      const currentHotspots = hotspotsRef.current
      if (historyManagerRef.current && activeSceneId && currentHotspots) {
        try {
          await historyManagerRef.current.createSnapshot(
            currentHotspots,
            activeSceneId,
            actionType,
            description,
            { sceneManifest: captureSceneManifest() }
          )
        } catch (error) {
          console.error("Failed to create history snapshot:", error)
        }
      }
      
      return result
    }
  }, [activeSceneId, isApplyingHistory, captureSceneManifest])


  const fetchImages = useCallback(async () => {
    try {
      const listRef = ref(storage, "panos/")
      const res = await listAll(listRef)
      const urls = await Promise.all(res.items.map(i => getDownloadURL(i)))
      setImageList(res.items.map((i, idx) => ({ name: i.name, url: urls[idx], isEditing: false })))
  
      /* New: try to load pre-made thumbs from panos/thumbs */
      try {
        const tasks = res.items.map(async i => {
          const base = i.name.replace(/\.[^.]+$/, "")
          const tRef = ref(storage, `panos/thumbs/${base}_thumb.jpg`)
          try {
            const tUrl = await getDownloadURL(tRef)
            thumbCacheRef.current.set(i.name, tUrl)
          } catch {}
        })
        await Promise.all(tasks)
      } catch (e) { console.error("Fetch thumbs failed", e) }
    } catch (e) { console.error("Fetch images failed", e) }
  }, [])

  const saveSceneHistory = useCallback(async (action, description) => {
    if (!historyManagerRef.current) return
    try {
      await historyManagerRef.current.createSnapshot(
        hotspotsRef.current,
        activeSceneId || "SCENES",
        action,
        description,
        { sceneManifest: captureSceneManifest() }
      )
    } catch (e) { console.error("Save scene history failed", e) }
  }, [captureSceneManifest, activeSceneId])
  
  const applySceneManifest = useCallback(async (manifest) => {
    try {
      const imgs = manifest?.imageList || []
      const ord = manifest?.sceneOrder || []
      const activeId = manifest?.activeSceneId || null
  
      setImageList(imgs)
      setSceneOrder(ord)
  
      const idsInOrder = [...ord]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(o => o.sceneId)
      if (idsInOrder.length) await UpdateSceneOrder(idsInOrder)
  
      if (activeId && loadSceneRef.current) {
        const s = imgs.find(i => i.name === activeId)
        if (s) await loadSceneRef.current(s.url, s.name)
      }
    } catch (e) { console.error("Apply scene manifest failed", e) }
  }, [setImageList, setSceneOrder])


  const handleUndo = useCallback(async () => {
    if (!historyManagerRef.current || !historyManagerRef.current.canUndo() || busyState) return
    
    setIsApplyingHistory(true)
    
    try {
      const snap = await historyManagerRef.current.undo()
      if (snap) {
        // Only apply scene manifest if scene actually changed
        if (snap.sceneManifest && snap.sceneManifest.activeSceneId !== activeSceneId) {
          await applySceneManifest(snap.sceneManifest)
        }
        
        // Apply hotspot changes immediately without delays
        await historyManagerRef.current.applySnapshot(
          snap, 
          hotspotsRef.current,
          setHotspots, 
          hotspotElsRef, 
          currentSceneRef, 
          deletedHotspotIdsRef
        )
      }
    } catch (e) { 
      console.error("Undo failed", e)
      toast.showError("Failed to undo. Please try again.")
    } finally { 
      setIsApplyingHistory(false) 
    }
  }, [activeSceneId, busyState, applySceneManifest, toast])

  const handleRedo = useCallback(async () => {
    if (!historyManagerRef.current || !historyManagerRef.current.canRedo() || busyState) return
  
    setIsApplyingHistory(true)
    try {
      // Apply next snapshot in history
      const snap = await historyManagerRef.current.redo()
      if (!snap) return
  
      // Apply scene manifest only when it differs
      if (snap.sceneManifest && snap.sceneManifest.activeSceneId !== activeSceneId) {
        await applySceneManifest(snap.sceneManifest)
      }
  
      // Apply hotspot diffs immediately
      await historyManagerRef.current.applySnapshot(
        snap,
        hotspotsRef.current,
        setHotspots,
        hotspotElsRef,
        currentSceneRef,
        deletedHotspotIdsRef
      )
  
      // If the entry requests a scene switch, switch directly without buffer
      if (snap.type === 'scene-switch' && snap.payload && loadSceneRef.current) {
        const { url, name } = snap.payload
        await loadSceneRef.current(url, name)
      }
    } catch (e) {
      console.error('Redo failed', e)
      toast.showError('Failed to redo. Please try again.')
    } finally {
      setIsApplyingHistory(false)
    }
  }, [activeSceneId, applySceneManifest, busyState, toast, setHotspots])

  const handleJumpToHistory = useCallback(async (targetIndex) => {
    if (!historyManagerRef.current || busyState) return
    const jumpOperation = withBusyWrapper(async () => {
      setIsApplyingHistory(true)
      try {
        const snapshot = await historyManagerRef.current.jumpToHistory(targetIndex)
        if (snapshot) {
          if (snapshot.sceneManifest) await applySceneManifest(snapshot.sceneManifest)
          await historyManagerRef.current.applySnapshot(
            snapshot, hotspots, setHotspots, hotspotElsRef, currentSceneRef, deletedHotspotIdsRef
          )
          await fetchHotspotCounts()
        }
      } catch (error) {
        console.error("History jump failed", error)
      } finally {
        setIsApplyingHistory(false)
      }
    }, "Jumping to history...")
    await jumpOperation()
  }, [hotspots, withBusyWrapper, fetchHotspotCounts, busyState, applySceneManifest])

  // Enable keyboard shortcuts
  useHistoryKeyboardShortcuts(handleUndo, handleRedo, !!busyState || isApplyingHistory)


  const UploadButton = ({ setShowPopup, busyState }) => {
    return (
      <button
        className="UploadBtn"
        onClick={() => setShowPopup(true)}
        disabled={!!busyState}
      >
        <div className="icon-1">
          <svg xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 26.3 65.33">
            <g>
              
            </g>
          </svg>
        </div>
  
        Upload Image
  
        <div className="icon-2">
          <svg xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 11.67 37.63">
            <g>
              <path d="M7.63 35.26c-0.02,0.13 0.01,0.05 -0.06,0.14..." />
            </g>
          </svg>
        </div>
  
        <div className="icon-3">
          <svg xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 25.29 76.92">
            <g>
              <path d="M19.14 6.58c0.09,0.1 -0.02,0.03 0.17,0.15..." />
            </g>
          </svg>
        </div>
      </button>
    );
  };

  const handleMenuRotate45 = useCallback(async () => {
    const sel = hotspots.find(h => h.id === selectedHotspotId)
    if (!sel || isProductHotspot(sel)) return
    
    const next = ((Number(sel.rotationDeg || 0) + 45) % 360)
    const entry = hotspotElsRef.current[selectedHotspotId]
    
    // Safer style manipulation
    if (entry?.el && entry.el.style) { 
      try { 
        entry.el.style.setProperty("--rot", `${next}deg`)
        
        // Also apply rotation to the icon wrapper with safety check
        const iconWrapper = entry.el.querySelector('.LinkDotIconWrap')
        if (iconWrapper && iconWrapper.style) {
          iconWrapper.style.setProperty("--rot", `${next}deg`)
        }
      } catch (e) { 
        console.warn("Style update failed:", e)
      } 
    }
    
    setHotspots(prev => prev.map(h => h.id === selectedHotspotId ? { ...h, rotationDeg: next } : h))
    
    const rotateHotspot = withHistoryTracking(async () => {
      await updateDoc(getHotspotDocRef(db, sel), { rotationDeg: next, updatedAt: serverTimestamp() })
      return true
    }, 'rotate', `Rotated link hotspot to ${next}°`)
    
    try {
      await rotateHotspot()
    } catch (e) { 
      console.error("Rotate hotspot failed", e) 
    }
  }, [hotspots, selectedHotspotId, withHistoryTracking])


  const beginRename = useCallback((index) => {
    setImageList(prev => prev.map((img, i) =>
      i === index ? { ...img, isEditing: true, draftBase: img.name.replace(/\.[^/.]+$/, "") } : img
    ))
  }, [])
  
  const cancelRename = useCallback((index) => {
    setImageList(prev => prev.map((img, i) =>
      i === index ? { ...img, isEditing: false, draftBase: undefined } : img
    ))
  }, [])
  
  const setDraftBase = useCallback((index, base) => {
    setImageList(prev => prev.map((img, i) =>
      i === index ? { ...img, draftBase: base } : img
    ))
  }, [])

  

  /* Debounce search */
  useEffect(() => {
    const t = setTimeout(() => setSceneSearch(sceneSearchInput), 250)
    return () => clearTimeout(t)
  }, [sceneSearchInput])

  useEffect(() => {
    if (db && !historyManagerRef.current) {
      historyManagerRef.current = new HistoryManager(db, 100)
      const unsubscribe = historyManagerRef.current.subscribe(setHistoryState)
      
      // Initialize with empty state immediately
      setHistoryState({
        canUndo: false,
        canRedo: false,
        history: [],
        currentIndex: -1
      })
      
      return unsubscribe
    }
  }, [db])



  
  /* Helpers */
  
  
  const updateLiveView = useCallback(() => {
    if (!currentSceneRef.current) return
    try {
      const view = currentSceneRef.current.view()
      const next = { yaw: view.yaw(), pitch: view.pitch(), fov: view.fov() }
      const prev = liveViewRef.current
      const near = (a, b) => Math.abs(a - b) < 0.001
      if (prev && near(prev.yaw, next.yaw) && near(prev.pitch, next.pitch) && near(prev.fov, next.fov)) return
      liveViewRef.current = next
      setLiveView(next)
    } catch (e) { console.error("View update failed", e) }
  }, [])

  useEffect(() => {
    if (!currentSceneRef.current) return
    const view = currentSceneRef.current.view()
    updateLiveView()
    let timeoutId
    const debounced = () => { clearTimeout(timeoutId); timeoutId = setTimeout(updateLiveView, 120) }
    view.addEventListener("change", debounced)
    return () => { view.removeEventListener("change", debounced); clearTimeout(timeoutId) }
  }, [updateLiveView])

  

  useEffect(() => {
    let unsub = () => {}
    const init = async () => {
      const sid = await ensureEditorSession()
      unsub = onFsSnapshot(collection(db, STAGING_SESSIONS, sid, STAGING_OPS_SUB), snap => {
        const count = snap.size
        setStagingOpsCount(count)
        hasStagedOpsRef.current = count > 0
        if (count > 0) setShowStagingConfirm(true)
      }, err => console.error("Staging listen failed", err))
    }
    init()
    return () => unsub()
  }, [ensureEditorSession])
  

  /* Modes */
  const EnterAddMode = useCallback(() => {
    stopMenuTracking()
    setSelectedHotspotId(null)
    setMoveHotspotId(null)
    setMovingHotspotId(null)
    setPendingHotspot(null)
    setPendingProductHotspot(null)
    setAddProductMode(false)
    setAddLinkMode(true)
  }, [stopMenuTracking])

  const EnterAddProductMode = useCallback(() => {
    stopMenuTracking()
    setSelectedHotspotId(null)
    setMoveHotspotId(null)
    setMovingHotspotId(null)
    setPendingHotspot(null)
    setPendingProductHotspot(null)
    setAddLinkMode(false)
    setAddProductMode(true)
    setProductSearch("")
    setPendingProductSelection(new Set())
  }, [stopMenuTracking])

  const EnterMoveMode = useCallback((id) => {
    if (!id) return
    stopMenuTracking()
    setSelectedHotspotId(null)
    setAddLinkMode(false)
    setAddProductMode(false)
    setPendingHotspot(null)
    setPendingProductHotspot(null)
    setMoveHotspotId(null)
    setMovingHotspotId(id)
  }, [stopMenuTracking])

  /* Storage fetch */
  

 

  

  

  /* Hotspot menu */
  // VirtualEditor.jsx — replace the whole openHotspotMenu with this
const openHotspotMenu = useCallback((id, hotspotData) => {
  if (!panoRef.current || !currentSceneRef.current) return
  if (addLinkMode || addProductMode || movingHotspotId) return

  stopMenuTracking()
  setSelectedHotspotId(id)
  setMoveHotspotId(null)
  selectedHotspotRef.current = hotspotData

  if (isProductHotspot(hotspotData)) {
    const ids = []
    if (Array.isArray(hotspotData.productIds)) ids.push(...hotspotData.productIds)
    else if (hotspotData.productId) ids.push(hotspotData.productId)
    setMenuProductSelection(new Set(ids))
    menuSelectedOrderRef.current = ids // preserve the saved order
    setMenuProductSearch("")
  }

  const view = currentSceneRef.current.view()
  const updatePos = () => {
    const h = selectedHotspotRef.current
    if (!h) return
    const pt = view.coordinatesToScreen({ yaw: h.yaw, pitch: h.pitch })
    if (!pt) return

    // Apply per-kind offsets here
    const arc = isProductHotspot(h) ? PRODUCT_ARC : LINK_ARC
    const left = pt.x + (arc.xOffset || 0)
    const top = pt.y + (arc.yOffset || 0)
    setMenuPos({ left, top })
  }

  updatePos()
  view.addEventListener("change", updatePos)
  menuTrackCleanupRef.current = () => view.removeEventListener("change", updatePos)
}, [addLinkMode, addProductMode, movingHotspotId, stopMenuTracking])


  const onHotspotMouseDown = useCallback((id, ev) => {
    if (id !== moveHotspotId) return
    ev.stopPropagation()
    ev.preventDefault()
    draggingRef.current.id = id
    
    // Store the initial offset for better cursor alignment
    const hotspotEl = hotspotElsRef.current[id]?.el
    if (hotspotEl) {
      const rect = hotspotEl.getBoundingClientRect()
      draggingRef.current.offsetX = ev.clientX - (rect.left + rect.width / 2)
      draggingRef.current.offsetY = ev.clientY - (rect.top + rect.height / 2)
    }
    
    window.addEventListener("mousemove", onDragMove)
    window.addEventListener("mouseup", onDragEnd, { once: true })
  }, [moveHotspotId])

  const onDragMove = useCallback((ev) => {
    const id = draggingRef.current.id
    if (!id || deletedHotspotIdsRef.current.has(id) || !currentSceneRef.current) return
    if (!panoRef.current) return
    
    const rect = panoRef.current.getBoundingClientRect()
    
    // Apply the stored offset for better alignment
    const offsetX = draggingRef.current.offsetX || 0
    const offsetY = draggingRef.current.offsetY || 0
    const x = ev.clientX - rect.left - offsetX
    const y = ev.clientY - rect.top - offsetY
    
    const coords = currentSceneRef.current.view().screenToCoordinates({ x, y })
    if (!coords) return
    
    const hotspotData = hotspotElsRef.current[id]
    if (!hotspotData || !hotspotData.hotspot) return
    
    try { 
      hotspotData.hotspot.setPosition({ yaw: coords.yaw, pitch: coords.pitch }) 
    } catch (e) {
      console.warn("Failed to update hotspot position:", e)
    }
    
    setHotspots(prev => prev.map(h => h.id === id ? { ...h, yaw: coords.yaw, pitch: coords.pitch } : h))
  }, [])

  const safeRenderHotspotsOnScene = useCallback(() => {
    const productsById = new Map(products.map(p => [p.id, p]))
    const run = () => {
      try {
        renderHotspotsOnScene({
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
        })
      } catch (e) {
        console.error("Failed to render hotspots", e)
      }
    }
    if ("startTransition" in React && typeof React.startTransition === "function") {
      React.startTransition(() => run())
    } else {
      requestAnimationFrame(() => run())
    }
  }, [
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
    products
  ])


  const onDragEnd = useCallback(async () => {
    const id = draggingRef.current.id
    draggingRef.current.id = null
    window.removeEventListener("mousemove", onDragMove)
    if (!id) return
  
    const h = hotspots.find(x => x.id === id)
    if (!h || typeof h.yaw !== 'number' || typeof h.pitch !== 'number') return
  
    if (dragMoveTimeoutRef.current) clearTimeout(dragMoveTimeoutRef.current)
    const snapshotHotspot = { ...h }
    dragMoveTimeoutRef.current = setTimeout(() => {
      ;(async () => {
        try {
          const moveHotspot = withHistoryTracking(async () => {
            await updateDoc(getHotspotDocRef(db, snapshotHotspot), {
              yaw: snapshotHotspot.yaw,
              pitch: snapshotHotspot.pitch,
              updatedAt: serverTimestamp()
            })
            return true
          }, 'move', `Moved ${snapshotHotspot.kind === 'product' ? 'product' : 'link'} hotspot`)
          const wrappedMove = withBusyWrapper(moveHotspot, 'Moving hotspot...')
          await wrappedMove()
        } catch (err) {
          console.error('Move history batching failed', err)
        }
      })()
    }, 200)
  }, [hotspots, onDragMove, withBusyWrapper, withHistoryTracking])

  const closeHotspotMenu = useCallback(() => {
    stopMenuTracking()
    setSelectedHotspotId(null)
    setMoveHotspotId(null)
    setMenuPos(null)
  }, [stopMenuTracking])

  const clearBeforeSwitch = useCallback(() => {

    
    stopMenuTracking()
    deletedHotspotIdsRef.current.clear()
  
    // Clean up hotspots
    if (historyManagerRef.current) {
      historyManagerRef.current.safeCleanupHotspots(
        currentSceneRef,
        hotspotElsRef,
        deletedHotspotIdsRef
      )
    } else {
      // Fallback cleanup
      Object.keys(hotspotElsRef.current).forEach(id => {
        const entry = hotspotElsRef.current[id]
        if (entry?.hotspot && typeof entry.hotspot.destroy === "function") {
          try {
            deletedHotspotIdsRef.current.add(id)
            entry.hotspot.destroy()
          } catch (e) {
            console.error("Failed to destroy hotspot", id, e)
          }
        }
        delete hotspotElsRef.current[id]
      })
    }
    
    // Reset all interactive state
    setSelectedHotspotId(null)
    setMoveHotspotId(null)
    setMovingHotspotId(null)
    setAddLinkMode(false)
    setAddProductMode(false)
    setPendingHotspot(null)
    setPendingProductHotspot(null)
    setMenuPos(null)
    setLiveView(null)
    
    // Clear hotspots array for clean slate
    setHotspots([])
  }, [stopMenuTracking])

  
  const loadScene = useCallback(async (url, sceneId) => {
    if (!Marzipano || !viewerRef.current) return
    const token = ++sceneLoadTokenRef.current
    setIsLoadingScene(true)
    
    try {
      clearBeforeSwitch()
      const geometry = new Marzipano.EquirectGeometry([{ width: 4000 }]);
      const viewportRect = panoRef.current?.getBoundingClientRect();
      const basePx = Math.max(viewportRect?.width || 1024, viewportRect?.height || 768);
      const face = Math.min(limits.MAX_FACE, Math.ceil(basePx * limits.DPR_CAP));
      const limiter = Marzipano.RectilinearView.limit.traditional(2 * face, MIN_FOV, MAX_FOV);
      const initialView = { yaw: 0, pitch: 0, fov: Math.PI / 2 };
      const thumbUrlMaybe = thumbCacheRef.current.get(sceneId);
      const wantThumb = Boolean(limits.USE_THUMB_PREVIEW && thumbUrlMaybe && thumbUrlMaybe !== url);

      if (wantThumb) {
        try {
          const previewGeometry = new Marzipano.EquirectGeometry([{ width: Math.min(2048, face) }]);
          const previewView = new Marzipano.RectilinearView({ yaw: 0, pitch: 0, fov: Math.max(MIN_FOV, Math.min(MAX_FOV, Math.PI / 2)) }, limiter);
          const previewSource = Marzipano.ImageUrlSource.fromString(thumbUrlMaybe);
          const previewScene = viewerRef.current.createScene({ source: previewSource, geometry: previewGeometry, view: previewView, pinFirstLevel: true });
          try { viewerRef.current.resize() } catch {}
          await new Promise(requestAnimationFrame);
          currentSceneRef.current = previewScene;
          previewScene.switchTo({ transitionDuration: 200 });
        } catch (e) {
          console.warn("Thumb preview failed, continuing with full-res:", e);
        }
      }
      // clamp initial fov into the allowed range
      if (typeof initialView.fov === 'number') {
         initialView.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, initialView.fov));
      }
      const view = new Marzipano.RectilinearView(initialView, limiter);
      viewRef.current = view;
      const srcUrl = getCachedUrl(url, sceneId) || url
      const source = Marzipano.ImageUrlSource.fromString(srcUrl)
      const scene = viewerRef.current.createScene({ source, geometry, view, pinFirstLevel: true })
      
      try { viewerRef.current.resize() } catch {}
      await new Promise(requestAnimationFrame)
      
      currentSceneRef.current = scene
      scene.switchTo({ transitionDuration: 800 })
      
      
      
      setActiveSceneUrl(url)
      setActiveSceneId(sceneId)
      
      // Load initial view
      try {
        const sceneDoc = await getDoc(doc(db, "scenes", "main"))
        if (sceneDoc.exists() && sceneDoc.data().sceneId === sceneId) {
          const initialView = sceneDoc.data().initialView
          if (initialView) {
            view.setYaw(initialView.yaw || 0)
            view.setPitch(initialView.pitch || 0)
            view.setFov(initialView.fov || Math.PI / 2)
          }
        }
      } catch (e) { console.error("Load initial view failed", e) }
      
      // Load hotspots for this scene
      await loadHotspotsForScene({ db, sceneId, token, sceneLoadTokenRef, activeSceneIdRef, setHotspots })
      
      // Initialize history for new scene after everything is loaded
      if (historyManagerRef.current) {
        // Small delay to ensure hotspots are fully loaded and rendered
        setTimeout(async () => {
          try {
            const currentHotspots = hotspotsRef.current || []
            await historyManagerRef.current.initialize(currentHotspots, sceneId)
          } catch (error) {
            console.error("History initialization failed:", error)
          }
        }, 300)
      }
      
    } finally { 
      setIsLoadingScene(false) 
    }
  }, [Marzipano, clearBeforeSwitch])

  useEffect(() => { loadSceneRef.current = loadScene }, [loadScene])

  const setAsDefault = useCallback(async (sceneId) => {
    if (!sceneId) return
    
    const setDefaultScene = withHistoryTracking(async () => {
      const currentOrder = orderedScenes.map(s => s.name)
      const filteredOrder = currentOrder.filter(id => id !== sceneId)
      const newOrder = [sceneId, ...filteredOrder]
      await UpdateSceneOrder(newOrder)
      await fetchSceneOrder()
      return true
    }, "scene-reorder", `Set ${sceneId} as default scene`)
    
    const wrappedOperation = withBusyWrapper(setDefaultScene, "Setting default...")
    await wrappedOperation()
  }, [orderedScenes, withBusyWrapper, fetchSceneOrder, withHistoryTracking])

  const setInitialView = useCallback(async () => {
    if (!currentSceneRef.current || !activeSceneId) return
    
    const saveInitialViewOperation = withHistoryTracking(async () => {
      const view = currentSceneRef.current.view()
      const initialView = { 
        yaw: view.yaw(), 
        pitch: view.pitch(), 
        fov: view.fov() 
      }
      
      await setDoc(doc(db, "scenes", "main"), { 
        imageUrl: activeSceneUrl, 
        sceneId: activeSceneId, 
        initialView, 
        updatedAt: serverTimestamp() 
      })
      
      return { sceneId: activeSceneId, initialView }
    }, "view-update", `Updated initial view for ${activeSceneId}`)
    
    const wrappedOperation = withBusyWrapper(saveInitialViewOperation, "Saving initial view...")
    await wrappedOperation()
  }, [activeSceneId, activeSceneUrl, withBusyWrapper, withHistoryTracking])

  const renderHotspotsCb = useCallback(() => {
    renderHotspotsOnScene({
      currentSceneRef, hotspots, activeSceneId, addLinkMode, addProductMode,
      movingHotspotId, moveHotspotId, isLoadingScene, hotspotElsRef,
      openHotspotMenu, onHotspotMouseDown, productsById: new Map(products.map(p => [p.id, p]))
    })
  }, [hotspots, activeSceneId, addLinkMode, addProductMode, movingHotspotId, moveHotspotId, isLoadingScene, openHotspotMenu, onHotspotMouseDown, products])

  const handleMenuDelete = useCallback(async () => {
    const id = selectedHotspotId
    if (!id) return
    const h = hotspots.find(x => x.id === id)
    if (!h) return
    
    const deleteHotspot = withHistoryTracking(async () => {
      safeDestroyHotspot(currentSceneRef, hotspotElsRef, id, deletedHotspotIdsRef)
      stopMenuTracking()
      selectedHotspotRef.current = null
      await deleteDoc(getHotspotDocRef(db, h))
      setHotspots(prev => prev.filter(x => x.id !== id))
      setSelectedHotspotId(null)
      setMoveHotspotId(null)
      return true
    }, 'delete', `Deleted ${h.kind === 'product' ? 'product' : 'link'} hotspot`)
    
    const wrappedDelete = withBusyWrapper(deleteHotspot, "Deleting hotspot...")
    await wrappedDelete()
  }, [selectedHotspotId, hotspots, stopMenuTracking, withBusyWrapper, withHistoryTracking])

  const handleMenuChangeScene = useCallback(async (newTarget) => {
    const id = selectedHotspotId
    if (!id) return
    const h = hotspots.find(x => x.id === id)
    if (!h || isProductHotspot(h)) return
    
    const updateScene = withHistoryTracking(async () => {
      await updateDoc(getHotspotDocRef(db, h), { 
        linkedScenarioId: newTarget, 
        updatedAt: serverTimestamp() 
      })
      setHotspots(prev => prev.map(x => x.id === id ? { ...x, linkedScenarioId: newTarget } : x))
      setSelectedHotspotId(null)
      setMoveHotspotId(null)
      return true
    }, "update", `Changed link target to ${newTarget}`)
    
    const run = withBusyWrapper(updateScene, "Updating hotspot...")
    await run()
  }, [selectedHotspotId, hotspots, withHistoryTracking, withBusyWrapper])

  const handleMenuToggleProduct = useCallback((id) => {
    setMenuProductSelection(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const applyProductsToHotspot = useCallback(async (hotspotId, ids) => {
    const h = hotspots.find(x => x.id === hotspotId)
    if (!h || !isProductHotspot(h)) return
    
    const updateProducts = withHistoryTracking(async () => {
      const updateData = ids.length === 1 
        ? { productId: ids[0], productIds: null } 
        : { productIds: ids, productId: null }
      
      await updateDoc(getHotspotDocRef(db, h), { 
        ...updateData, 
        updatedAt: serverTimestamp() 
      })
      
      setHotspots(prev => prev.map(x => x.id === hotspotId ? { 
        ...x, 
        ...updateData,
        // Ensure we clear the opposite field
        ...(ids.length === 1 ? { productIds: null } : { productId: null })
      } : x))
      
      setSelectedHotspotId(null)
      setMoveHotspotId(null)
      return true
    }, "update", `Updated products (${ids.length} product${ids.length > 1 ? 's' : ''})`)
    
    const run = withBusyWrapper(updateProducts, "Saving products...")
    await run()
  }, [hotspots, withHistoryTracking, withBusyWrapper])

  const handleMenuSaveProducts = useCallback(async () => {
    const id = selectedHotspotId
    if (!id) return
    const h = hotspots.find(x => x.id === id)
    if (!h || !isProductHotspot(h)) return
    const ids = Array.from(menuProductSelection)
    if (ids.length === 0) return
    
    // Store the previous state for history
    const previousProductIds = Array.isArray(h.productIds) ? [...h.productIds] : []
    const previousProductId = h.productId || null
    
    await applyProductsToHotspot(id, ids)
  }, [selectedHotspotId, hotspots, menuProductSelection, applyProductsToHotspot])

  /* Scene DnD */
  const handleSceneDragStart = useCallback((e, sceneId) => {
    if (isRenaming) { e.preventDefault(); return }
      setDraggedSceneId(sceneId)
      e.dataTransfer.effectAllowed = "move"
      e.dataTransfer.setData("text/plain", sceneId)
      const el = e.target.closest(".SceneCard")
      if (el) el.setAttribute("aria-grabbed", "true")
  }, [isRenaming])

  const handleSceneDragEnd = useCallback((e) => {
    setDraggedSceneId(null)
    setDropIndicatorIndex(-1)
    const el = e.target.closest(".SceneCard")
    if (el) el.setAttribute("aria-grabbed", "false")
  }, [])

  const handleSceneDragOver = useCallback((e, targetIndex) => {
    if (isRenaming) return
    if (!draggedSceneId) return
      e.preventDefault()
      const draggedIndex = filteredScenes.findIndex(s => s.name === draggedSceneId)
      if (draggedIndex === -1) return
      const rect = e.currentTarget.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      let dropIndex = targetIndex
      const shouldShowAbove = e.clientY < midpoint
      if (!shouldShowAbove && draggedIndex < targetIndex) dropIndex = targetIndex + 1
      else if (shouldShowAbove && draggedIndex > targetIndex) dropIndex = targetIndex
      else if (!shouldShowAbove) dropIndex = targetIndex + 1
      setDropIndicatorIndex(dropIndex)
  }, [draggedSceneId, filteredScenes, isRenaming])

  const handleSceneDrop = useCallback(async (e, targetIndex) => {
    e.preventDefault()
    if (isRenaming) return
    if (!draggedSceneId) return
    
    const reorderScenes = withHistoryTracking(async () => {
      const currentOrder = orderedScenes.map(s => s.name)
      const draggedIndex = currentOrder.indexOf(draggedSceneId)
      if (draggedIndex === -1) return
      
      const newOrder = [...currentOrder]
      newOrder.splice(draggedIndex, 1)
      const targetScene = filteredScenes[targetIndex]
      let insertIndex = targetScene ? newOrder.indexOf(targetScene.name) : newOrder.length
      const rect = e.currentTarget.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      const shouldInsertAfter = e.clientY > midpoint
      if (shouldInsertAfter && targetScene) insertIndex += 1
      newOrder.splice(insertIndex, 0, draggedSceneId)
      
      await UpdateSceneOrder(newOrder)
      await fetchSceneOrder()
      return { draggedScene: draggedSceneId, newOrder }
    }, "scene-reorder", `Reordered scenes (moved ${draggedSceneId})`)
    
    const wrappedReorder = withBusyWrapper(reorderScenes, "Reordering scenes...")
    await wrappedReorder()
    
    setDraggedSceneId(null)
    setDropIndicatorIndex(-1)
  }, [draggedSceneId, filteredScenes, orderedScenes, withBusyWrapper, fetchSceneOrder, isRenaming, withHistoryTracking])

  const showDeleteConfirmation = useCallback(async (index) => {
    const scene = filteredScenes[index]
    if (!scene) return
    const hotspotCount = await countHotspotsForScene(scene.name)
    setConfirmDelete({ scene, index, hotspotCount })
  }, [filteredScenes, countHotspotsForScene])

  const toggleRename = useCallback((index) => {
    setImageList(prev => prev.map((img, i) => i === index ? { ...img, isEditing: !img.isEditing } : img))
  }, [])

  const handleSceneKeyDown = useCallback(async (e, sceneId, currentIndex) => {
    if (isRenaming) return
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault()
      const direction = e.key === "ArrowUp" ? -1 : 1
      const newIndex = currentIndex + direction
      if (newIndex < 0 || newIndex >= filteredScenes.length) return
      const reorderScenes = withBusyWrapper(async () => {
        const currentOrder = orderedScenes.map(s => s.name)
        const draggedIndex = currentOrder.indexOf(sceneId)
        if (draggedIndex === -1) return
        const targetScene = filteredScenes[newIndex]
        const targetIndex = currentOrder.indexOf(targetScene.name)
        const newOrder = [...currentOrder]
        newOrder.splice(draggedIndex, 1)
        newOrder.splice(targetIndex, 0, sceneId)
        await UpdateSceneOrder(newOrder)
        await fetchSceneOrder()
        setTimeout(() => {
          const el = document.querySelector(`[data-scene-id="${sceneId}"] .DragHandle`)
          el?.focus()
        }, 100)
      }, "Reordering scenes...")
      await reorderScenes()
      await saveSceneHistory("scene-reorder", "Reordered scenes via keyboard")
    } else if (e.key === "Enter") {
      e.preventDefault()
      const scene = filteredScenes.find(s => s.name === sceneId)
      if (scene && !busyState) loadScene(scene.url, scene.name)
    } else if (e.key === "Delete") {
      e.preventDefault()
      const sceneIndex = filteredScenes.findIndex(s => s.name === sceneId)
      if (sceneIndex !== -1 && !busyState) showDeleteConfirmation(sceneIndex)
    } else if (e.key.toLowerCase() === "r") {
      e.preventDefault()
      const idx = imageList.findIndex(img => img.name === sceneId)
      if (idx !== -1 && !busyState) toggleRename(idx)
    }
  
  }, [filteredScenes, orderedScenes, withBusyWrapper, fetchSceneOrder, busyState, loadScene, showDeleteConfirmation, toggleRename, imageList, isRenaming])

  /* Editor preview pointer */
  const editorPreviewRef = useRef(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const handleEditorMouseMove = useCallback((e) => {
    if ((!addLinkMode && !addProductMode && !movingHotspotId) || !editorPreviewRef.current) return
    const rect = editorPreviewRef.current.getBoundingClientRect()
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [addLinkMode, addProductMode, movingHotspotId])

  /* Pano clicks */
  const handlePanoClick = useCallback((e) => {
    if (!addLinkMode || !currentSceneRef.current || !panoRef.current) return
    const rect = panoRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const coords = currentSceneRef.current.view().screenToCoordinates({ x, y })
    if (!coords) return
    setPendingHotspot({ yaw: coords.yaw, pitch: coords.pitch, x, y })
    setAddLinkMode(false)
  }, [addLinkMode])

  const handlePanoProductClick = useCallback((e) => {
    if (!addProductMode || !currentSceneRef.current || !panoRef.current) return
    const rect = panoRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const coords = currentSceneRef.current.view().screenToCoordinates({ x, y })
    if (!coords) return
    setPendingProductHotspot({ yaw: coords.yaw, pitch: coords.pitch, x, y })
    setAddProductMode(false)
    setProductSearch("")
  }, [addProductMode])

  const saveNewHotspot = useCallback(async (linkedScenarioId) => {
    if (!pendingHotspot || !activeSceneId) return
    
    const createHotspot = withHistoryTracking(async () => {
      const payload = { 
        kind: "link", 
        sceneId: activeSceneId, 
        yaw: pendingHotspot.yaw, 
        pitch: pendingHotspot.pitch, 
        linkedScenarioId, 
        createdAt: serverTimestamp(), 
        updatedAt: serverTimestamp() 
      }
      const docRef = await addDoc(collection(db, "hotspots"), payload)
      const newHotspot = { id: docRef.id, ...payload }
      setHotspots(prev => [...prev, newHotspot])
      await stageOp({ kind: "hotspot", op: "add", id: newHotspot.id, collection: "hotspots", data: newHotspot })
      setPendingHotspot(null)
      await fetchHotspotCounts()
      return true
    }, 'create', `Created link hotspot to ${linkedScenarioId}`)
    
    const wrappedCreate = withBusyWrapper(createHotspot, "Creating hotspot...")
    await wrappedCreate()
  }, [pendingHotspot, activeSceneId, withBusyWrapper, fetchHotspotCounts, withHistoryTracking])

  const saveNewProductHotspot = useCallback(async (ids) => {
    if (!pendingProductHotspot || !activeSceneId || !ids || ids.length === 0) return
    
    const createProductHotspot = withHistoryTracking(async () => {
      const base = ids.length === 1 ? { productId: ids[0], productIds: null } : { productIds: ids, productId: null }
      const payload = { 
        kind: "product", 
        sceneId: activeSceneId, 
        yaw: pendingProductHotspot.yaw, 
        pitch: pendingProductHotspot.pitch, 
        ...base, 
        createdAt: serverTimestamp(), 
        updatedAt: serverTimestamp() 
      }
      const docRef = await addDoc(collection(db, PRODUCT_HOTSPOT_COLLECTION), payload)
      const newHotspot = { id: docRef.id, ...payload }
      setHotspots(prev => [...prev, newHotspot])
      await stageOp({ kind: "hotspot", op: "add", id: newHotspot.id, collection: PRODUCT_HOTSPOT_COLLECTION, data: newHotspot })
      setPendingProductHotspot(null)
      setPendingProductSelection(new Set())
      await fetchHotspotCounts()
      return true
    }, 'create', `Created product hotspot (${ids.length} product${ids.length > 1 ? 's' : ''})`)
    
    const wrappedCreate = withBusyWrapper(createProductHotspot, "Creating product hotspot...")
    await wrappedCreate()
  }, [pendingProductHotspot, activeSceneId, withBusyWrapper, fetchHotspotCounts, withHistoryTracking])

  const togglePendingProduct = useCallback((id) => {
    setPendingProductSelection(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handlePreviewClick = useCallback((e) => {
    if (addLinkMode) return handlePanoClick(e)
    if (addProductMode) return handlePanoProductClick(e)
    if (movingHotspotId) {
      return handleMovePlaceClickOnScene({
        e,
        movingHotspotId,
        currentSceneRef,
        panoRef,
        hotspotElsRef,
        setHotspots,
        hotspots,
        db,
        activeSceneId,
        loadHotspotsForSceneArgs: { db, sceneId: activeSceneId, token: sceneLoadTokenRef.current, sceneLoadTokenRef, activeSceneIdRef, setHotspots },
        stopMenuTracking,
        setSelectedHotspotId,
        setMoveHotspotId,
        setMovingHotspotId,
        onAfterMove: async ({ hotspot, prev, next }) => {
          // Wrap the history tracking properly
          const recordMove = withHistoryTracking(async () => {
            return true // Already saved in handleMovePlaceClickOnScene
          }, 'move', `Moved ${isProductHotspot(hotspot) ? "product" : "link"} hotspot`)
          await recordMove()
        }
      })
    }
    if (pendingHotspot) setPendingHotspot(null)
    if (pendingProductHotspot) setPendingProductHotspot(null)
    closeHotspotMenu()
  }, [addLinkMode, addProductMode, movingHotspotId, pendingHotspot, pendingProductHotspot, handlePanoClick, handlePanoProductClick, closeHotspotMenu, hotspots, activeSceneId, withHistoryTracking])

  
  /* Upload */
  const handleUploadFile = useCallback((file) => {
    if (!file) return
    const okTypes = ["image/jpeg", "image/png"]
    const okExt = ["jpg", "jpeg", "png"]
    const ext = file.name.split(".").pop().toLowerCase()
    if (!okTypes.includes(file.type) || !okExt.includes(ext)) { setImageError("Please upload a valid PNG or JPG image."); setUploadFile(null); setPreviewURL(""); return }
    if (file.size > 15 * 1024 * 1024) { setImageError("Image file size must be under 15MB."); setUploadFile(null); setPreviewURL(""); return }
    setImageError("")
    setUploadFile(file)
    setPreviewURL(URL.createObjectURL(file))
    setCustomFileName(file.name)
    setRenameMode(false)
  }, [])

  async function makeSceneThumbBlob(file, maxW = 480, quality = 0.68){
    try{
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, maxW / bitmap.width)
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d", { alpha:false })
      ctx.drawImage(bitmap, 0, 0, w, h)
      const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality))
      return blob
    }catch(e){
      console.error("Thumb build failed", e)
      return null
    }
  }

  const handleUploadToFirebase = useCallback(async () => {
    if (!uploadFile) return
    
    const uploadImage = withHistoryTracking(async () => {
      const imgRef = ref(storage, `panos/${customFileName}`)
      await uploadBytes(imgRef, uploadFile, { contentType: uploadFile.type || undefined })
      await stageOp({ kind: "scene", op: "add", id: customFileName, storagePath: `panos/${customFileName}` })
      const url = await getDownloadURL(imgRef)
      let thumbUrl = null
        try{
          const thumbBlob = await makeSceneThumbBlob(uploadFile)
          if (thumbBlob){
            const base = customFileName.replace(/\.[^.]+$/, "")
            const thumbRef = ref(storage, `panos/thumbs/${base}_thumb.jpg`)
            await uploadBytes(thumbRef, thumbBlob, {
              contentType: "image/jpeg",
              cacheControl: "public,max-age=31536000,immutable"
            })
            thumbUrl = await getDownloadURL(thumbRef)
          }
        }catch(e){
          console.error("Thumb upload failed", e)
        }
      if (thumbUrl) thumbCacheRef.current.set(customFileName, thumbUrl)
      await fetchImages()
      await fetchSceneOrder()
      await loadScene(url, customFileName)
      setShowPopup(false)
      setUploadFile(null)
      setPreviewURL("")
      setCustomFileName("")
      setRenameMode(false)
      setImageError("")
      return true
    }, "scene-upload", `Uploaded scene: ${customFileName}`)
    
    const wrappedUpload = withBusyWrapper(uploadImage, "Uploading image...")
    await wrappedUpload()
  }, [uploadFile, customFileName, fetchImages, fetchSceneOrder, loadScene, withBusyWrapper, withHistoryTracking])
  

  const resetUploadState = useCallback(() => {
    setShowPopup(false)
    setUploadFile(null)
    setPreviewURL("")
    setCustomFileName("")
    setRenameMode(false)
    setImageError("")
  }, [])

  const updateName = useCallback((index, newName) => {
    setImageList(prev => prev.map((img, i) => i === index ? { ...img, name: newName } : img))
  }, [])

  const deleteHotspotsForScene = useCallback(async (sceneName) => {
    const q1 = query(collection(db, "hotspots"), where("sceneId", "==", sceneName))
    const q2 = query(collection(db, "hotspots"), where("linkedScenarioId", "==", sceneName))
    const q3 = query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneName))
    const [s1, s2, s3] = await Promise.all([getDocs(q1), getDocs(q2), getDocs(q3)])
    const uniq = new Map()
    s1.docs.forEach((d) => uniq.set(`link:${d.id}`, { kind: "link", id: d.id }))
    s2.docs.forEach((d) => uniq.set(`link:${d.id}`, { kind: "link", id: d.id }))
    s3.docs.forEach((d) => uniq.set(`product:${d.id}`, { kind: "product", id: d.id }))
    await Promise.all([...uniq.values()].map(({ kind, id }) => deleteDoc(doc(db, kind === "product" ? PRODUCT_HOTSPOT_COLLECTION : "hotspots", id))))
    setHotspots(prev => prev.filter(h => h.sceneId !== sceneName && h.linkedScenarioId !== sceneName))
    return uniq.size
  }, [])

  const deleteImage = useCallback(async () => {
    if (!confirmDelete) return
    if (guardBusy('Deleting scene, please wait')) return
    if (isDeletingRef.current) { toast.showInfo('Deleting scene...'); return }
  
    const { scene } = confirmDelete
    const wasActive = activeSceneId === scene.name
    setConfirmDelete(null)
    isDeletingRef.current = true
  
    const run = withBusyWrapper(async () => {
      try {
        if (wasActive) {
          setActiveSceneId('')
          setActiveSceneUrl('')
          try { clearHotspots() } catch {}
        }
  
        const fileRef = ref(storage, `panos/${scene.name}`)
        try {
          await deleteObject(fileRef)
        } catch (e) {
          if (!e || e.code !== 'storage/object-not-found') throw e
        }
  
        try { await deleteHotspotsForScene(scene.name) } catch (e) { console.error(e) }
        try { await deleteDoc(doc(db, 'sceneOrder', scene.name)) } catch (e) { console.error(e) }
  
        await fetchImages()
        await fetchSceneOrder()
  
        const remaining = orderedScenes.filter(s => s.name !== scene.name)
        if (remaining.length) {
          const first = remaining[0]
          await loadScene(first.url, first.name)
        }
      } finally {
        isDeletingRef.current = false
      }
    }, 'Deleting scene.')
  
    await run()
  }, [
    confirmDelete,
    activeSceneId,
    withBusyWrapper,
    orderedScenes,
    loadScene,
    fetchImages,
    fetchSceneOrder,
    deleteHotspotsForScene,
    toast,
    guardBusy
  ])
  

  const showRenameConfirmation = useCallback(async (index, newName) => {
    if (!newName || newName.trim() === "") { alert("File name cannot be empty."); return }
    const current = imageList[index]
    if (newName === current.name) return
    setConfirmRename({ index, oldName: current.name, newName })
  }, [imageList])

  const handleRenameConfirm = useCallback(async (index) => {
    const img = imageList[index]
    if (!img) return
    const base = (img.draftBase || "").trim()
    if (!base) return
    const ext = img.name.split(".").pop()
    const full = `${base}.${ext}`
    await showRenameConfirmation(index, full)
  }, [imageList, showRenameConfirmation])

  const renameImage = useCallback(async () => {
  if (!confirmRename) return
  const { index, oldName, newName } = confirmRename
  setConfirmRename(null)
  
  const renameSceneImage = withHistoryTracking(async () => {
    try {
      const oldRef = ref(storage, `panos/${oldName}`)
      const newRef = ref(storage, `panos/${newName}`)
      const blob = await fetch(imageList[index].url).then(res => res.blob())
      await uploadBytes(newRef, blob, { contentType: blob.type || undefined })
      await deleteObject(oldRef)
      await fetchImages()
      await fetchSceneOrder()
      
      const q1 = query(collection(db, "hotspots"), where("sceneId", "==", oldName))
      const q2 = query(collection(db, "hotspots"), where("linkedScenarioId", "==", oldName))
      const q3 = query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", oldName))
      const [s1, s2, s3] = await Promise.all([getDocs(q1), getDocs(q2), getDocs(q3)])
      
      await Promise.all([
        ...s1.docs.map(d => updateDoc(doc(db, "hotspots", d.id), { sceneId: newName, updatedAt: serverTimestamp() })),
        ...s2.docs.map(d => updateDoc(doc(db, "hotspots", d.id), { linkedScenarioId: newName, updatedAt: serverTimestamp() })),
        ...s3.docs.map(d => updateDoc(doc(db, PRODUCT_HOTSPOT_COLLECTION, d.id), { sceneId: newName, updatedAt: serverTimestamp() }))
      ])
      
      /* inside renameImage > renameSceneImage, replace the same tail section with this */
      const orderRef = doc(db, "sceneOrder", oldName)
      const newOrderRef = doc(db, "sceneOrder", newName)
      const orderDoc = await getDoc(orderRef)
      if (orderDoc.exists()) {
        await setDoc(newOrderRef, orderDoc.data())
        await deleteDoc(orderRef)
      }

      const newUrl = await getDownloadURL(newRef)
      try {
        const tourRef = doc(db, "publicTours", "main")
        const tourSnap = await getDoc(tourRef)
        if (tourSnap.exists()) {
          // move scene doc
          const oldPubRef = doc(db, "publicTours", "main", "scenes", oldName)
          const oldPubSnap = await getDoc(oldPubRef)
          if (oldPubSnap.exists()) {
            const newPubRef = doc(db, "publicTours", "main", "scenes", newName)
            const publishedSceneData = oldPubSnap.data() || {}
            await setDoc(newPubRef, {
              ...publishedSceneData,
              imageUrl: newUrl,
              updatedAt: serverTimestamp()
            }, { merge: true })

            // move hotspots subcollection under the renamed scene
            try {
              const oldHsCol = collection(db, "publicTours", "main", "scenes", oldName, "hotspots")
              const oldHsSnap = await getDocs(oldHsCol)
              for (const h of oldHsSnap.docs) {
                const data = h.data() || {}
                const newHsRef = doc(db, "publicTours", "main", "scenes", newName, "hotspots", h.id)
                await setDoc(newHsRef, { ...data, updatedAt: serverTimestamp() }, { merge: true })
                await deleteDoc(h.ref)
              }
            } catch (e) {
              console.error("Published hotspots move failed", e)
            }

            await deleteDoc(oldPubRef)
          }

          // fix order and default
          const tourData = tourSnap.data() || {}
          const order = Array.isArray(tourData.order) ? tourData.order : []
          const fixedOrder = order.map(id => id === oldName ? newName : id)
          const defaultSceneId = tourData.defaultSceneId === oldName ? newName : tourData.defaultSceneId

          await setDoc(tourRef, {
            order: fixedOrder,
            defaultSceneId,
            updatedAt: serverTimestamp()
          }, { merge: true })

          // update manifest meta if present
          const manifestRef = doc(db, "publicTours", "main", "meta", "manifest")
          await setDoc(manifestRef, {
            order: fixedOrder,
            defaultSceneId,
            updatedAt: serverTimestamp()
          }, { merge: true })

          // fix cross-scene link hotspots that pointed to the old id
          try {
            const scenesCol = collection(db, "publicTours", "main", "scenes")
            const scenesSnap = await getDocs(scenesCol)
            for (const s of scenesSnap.docs) {
              const hsCol = collection(db, "publicTours", "main", "scenes", s.id, "hotspots")
              const hsSnap = await getDocs(hsCol)
              for (const h of hsSnap.docs) {
                const hd = h.data() || {}
                const linkKeys = ["linkedScenarioId", "linkedSceneId", "targetSceneId"]
                let needsUpdate = false
                const patch = {}
                for (const k of linkKeys) {
                  if (hd[k] === oldName) {
                    patch[k] = newName
                    needsUpdate = true
                  }
                }
                if (needsUpdate) {
                  await updateDoc(h.ref, { ...patch, updatedAt: serverTimestamp() })
                }
              }
            }
          } catch (e) {
            console.error("Published link targets update failed", e)
          }
        }
      } catch (e) {
        console.error("Published tour rename sync failed", e)
      }

      return { oldName, newName }

    } catch (err) {
      console.error("Rename failed", err)
      setImageList(prev => prev.map((img, i) => 
        i === index ? { ...img, name: oldName, isEditing: false } : img
      ))
      throw err
    }
  }, "scene-rename", `Renamed scene: ${oldName} → ${newName}`)
  
  try {
    const wrappedRename = withBusyWrapper(renameSceneImage, "Renaming scene...")
    await wrappedRename()
    cancelRename(index)
  } catch (error) {
    console.error("Rename operation failed:", error)
  }
}, [confirmRename, imageList, fetchImages, fetchSceneOrder, withBusyWrapper, cancelRename, withHistoryTracking])

  useEffect(() => {
    if (historyManagerRef.current && activeSceneId && !isApplyingHistory && !isLoadingScene) {
      // Initialize history when we have a scene and hotspots are loaded
      if (hotspots.length >= 0) { // Allow initialization even with 0 hotspots
        const timer = setTimeout(async () => {
          try {
            console.log('Initializing history for scene:', activeSceneId, 'with', hotspots.length, 'hotspots')
            await historyManagerRef.current.initialize(hotspots, activeSceneId)
            // Force a state update
            const state = historyManagerRef.current.getState()
            setHistoryState(state)
          } catch (error) {
            console.error("History initialization failed:", error)
          }
        }, 300)
        
        return () => clearTimeout(timer)
      }
    }
  }, [activeSceneId, hotspots.length, isApplyingHistory, isLoadingScene])

  useEffect(() => {
    // Sync hotspots to ref whenever they change (but not during history operations)
    if (!isApplyingHistory) {
      hotspotsRef.current = hotspots
    }
  }, [hotspots, isApplyingHistory])
  
  const applyStagedOps = useCallback(async () => {
    try {
      const sid = await ensureEditorSession()
      const opsSnap = await getDocs(collection(db, STAGING_SESSIONS, sid, STAGING_OPS_SUB))
  
      await Promise.all(opsSnap.docs.map(d => deleteDoc(d.ref)))
  
      await setDoc(
        doc(db, STAGING_SESSIONS, sid),
        { active: false, appliedAt: serverTimestamp() },
        { merge: true }
      )
      hasStagedOpsRef.current = false
      setStagingOpsCount(0)
    } catch (e) {
      console.error("Apply staged ops failed", e)
    }
  }, [ensureEditorSession])
  
  const discardStagedOps = useCallback(async () => {
    try {
      const sid = await ensureEditorSession()
      const opsSnap = await getDocs(collection(db, STAGING_SESSIONS, sid, STAGING_OPS_SUB))
      const ops = opsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      // Process in reverse to undo in LIFO order
      for (const op of ops.slice().reverse()) {
        if (op.kind === "hotspot" && op.op === "add") {
          try { await deleteDoc(doc(db, op.collection, op.id)) } catch {}
        } else if (op.kind === "hotspot" && op.op === "delete") {
          try { await setDoc(doc(db, op.collection, op.id), { ...op.data, updatedAt: serverTimestamp() }) } catch {}
        } else if (op.kind === "scene" && op.op === "add") {
          try { await deleteObject(ref(storage, op.storagePath)) } catch {}
          try { await deleteDoc(doc(db, "sceneOrder", op.id)) } catch {}
        } else if (op.kind === "scene" && op.op === "delete") {
          if (Array.isArray(op.hotspots)) {
            for (const h of op.hotspots) {
              try {
                await setDoc(doc(db, h.collection, h.id), { ...h.data, updatedAt: serverTimestamp() })
              } catch {}
            }
          }
        }
      }
      // Clear staging
      await Promise.all(opsSnap.docs.map(d => deleteDoc(d.ref)))
      await setDoc(doc(db, STAGING_SESSIONS, sid), { active: false, discardedAt: serverTimestamp() }, { merge: true })
      hasStagedOpsRef.current = false
      setStagingOpsCount(0)
      await fetchImages()
      await fetchSceneOrder()
      if (activeSceneId) await loadSceneRef.current?.(activeSceneUrl, activeSceneId)
    } catch (e) { console.error("Discard staged ops failed", e) }
  }, [ensureEditorSession, fetchImages, fetchSceneOrder, activeSceneId, activeSceneUrl])
  
  /* Publish */
  const clearPublishedTour = useCallback(async (tourId) => {
    const scenesCol = collection(db, "publicTours", tourId, "scenes")
    const scenesSnap = await getDocs(scenesCol)
    let batch = writeBatch(db)
    let ops = 0
    let deletedCount = { scenes: 0, hotspots: 0 }
  
    for (const sceneDoc of scenesSnap.docs) {
      const hotspotsCol = collection(db, "publicTours", tourId, "scenes", sceneDoc.id, "hotspots")
      const hotspotsSnap = await getDocs(hotspotsCol)
      
      for (const h of hotspotsSnap.docs) {
        batch.delete(h.ref)
        deletedCount.hotspots++
        ops++
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0 }
      }
      
      batch.delete(sceneDoc.ref)
      deletedCount.scenes++
      ops++
      if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0 }
    }
    
    // Also delete metadata
    try {
      const metaCol = collection(db, "publicTours", tourId, "meta")
      const metaSnap = await getDocs(metaCol)
      for (const metaDoc of metaSnap.docs) {
        batch.delete(metaDoc.ref)
        ops++
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0 }
      }
    } catch (e) {
      console.warn("Failed to clear metadata:", e)
    }
    
    if (ops > 0) await batch.commit()
    
    return deletedCount
  }, [])

  const handleUnpublishTour = useCallback(async (tourId = "main") => {
    const unpublishOperation = withHistoryTracking(async () => {
      // Count what's being unpublished
      const tourDoc = await getDoc(doc(db, "publicTours", tourId))
      const publishedData = tourDoc.exists() ? tourDoc.data() : null
      
      await clearPublishedTour(tourId)
      
      // Delete the main tour document
      await deleteDoc(doc(db, "publicTours", tourId))
      
      return {
        unpublishedAt: new Date().toISOString(),
        tourId,
        previousData: publishedData
      }
    }, "unpublish", `Unpublished tour: ${tourId}`)
    
    const run = withBusyWrapper(unpublishOperation, "Unpublishing tour...")
    await run()
  }, [clearPublishedTour, withBusyWrapper, withHistoryTracking])

  const checkForUnpublishedChanges = useCallback(async () => {
    try {
      const tourDoc = await getDoc(doc(db, "publicTours", "main"))
      if (!tourDoc.exists()) {
        setPublishStatus({ 
          isPublished: false, 
          lastPublished: null, 
          hasChanges: orderedScenes.length > 0 || hotspots.length > 0 
        })
        return
      }
      
      const publishedData = tourDoc.data()
      const lastPublished = publishedData.publishedAt?.toDate()
      
      // Check if current state differs from published state
      const currentSceneIds = orderedScenes.map(s => s.name)
      const publishedSceneIds = publishedData.order || []
      
      // More comprehensive change detection
      const hasSceneChanges = JSON.stringify(currentSceneIds.sort()) !== JSON.stringify(publishedSceneIds.sort())
      const hasHotspotCountChanges = hotspots.length !== (publishedData.totalHotspots || 0)
      const hasDefaultSceneChange = (orderedScenes[0]?.name || null) !== publishedData.defaultSceneId
      
      // Check for scene content changes (more expensive check)
      let hasContentChanges = false
      if (!hasSceneChanges && !hasHotspotCountChanges) {
        // Check if any scenes have been modified since last publish
        const sceneModificationTimes = await Promise.all(
          orderedScenes.map(async (scene) => {
            try {
              const sceneRef = doc(db, "publicTours", "main", "scenes", scene.name)
              const sceneDoc = await getDoc(sceneRef)
              return sceneDoc.exists() ? sceneDoc.data().updatedAt?.toDate() : null
            } catch {
              return null
            }
          })
        )
        
        // If any scene is missing from published tour or was modified after publish
        hasContentChanges = sceneModificationTimes.some((modTime, index) => {
          return !modTime || (lastPublished && modTime > lastPublished)
        })
      }
      
      const hasChanges = hasSceneChanges || hasHotspotCountChanges || hasDefaultSceneChange || hasContentChanges
      
      setPublishStatus({
        isPublished: true,
        lastPublished,
        hasChanges
      })
    } catch (error) {
      console.error("Failed to check publish status:", error)
      setPublishStatus({ 
        isPublished: false, 
        lastPublished: null, 
        hasChanges: orderedScenes.length > 0 || hotspots.length > 0 
      })
    }
  }, [orderedScenes, hotspots.length])
  
  // Check for changes when scenes or hotspots change
  useEffect(() => {
    if (orderedScenes.length > 0) {
      checkForUnpublishedChanges()
    }
  }, [orderedScenes, hotspots, checkForUnpublishedChanges])
  
  // Add visual indicator for publish status in the UI
  const [publishStatus, setPublishStatus] = useState({
    isPublished: false,
    lastPublished: null,
    hasChanges: false
  })

  useEffect(() => {
    if (orderedScenes.length >= 0) { // Check even when 0 scenes
      // Debounce the check to avoid excessive calls
      const timeoutId = setTimeout(() => {
        checkForUnpublishedChanges()
      }, 1000)
      
      return () => clearTimeout(timeoutId)
    }
  }, [orderedScenes, hotspots, checkForUnpublishedChanges])

  const refreshPublishStatus = useCallback(async () => {
    await checkForUnpublishedChanges()
  }, [checkForUnpublishedChanges])

  const publishTour = useCallback(async (tourId = "main") => {
    // Capture the current state before publishing
    const publishSnapshot = {
      scenes: orderedScenes.map(s => ({ name: s.name, url: s.url })),
      sceneOrder: [...sceneOrder],
      hotspots: [...hotspots],
      defaultSceneId: orderedScenes[0]?.name || null,
      totalScenes: orderedScenes.length,
      totalHotspots: hotspots.length
    }
  
    // 1) Clear previous published tour
    await clearPublishedTour(tourId)
  
    let batch = writeBatch(db)
    let ops = 0
  
    // Order + default
    const orderIds = orderedScenes.map(s => s.name)
    const defaultSceneId = orderIds[0] || null
  
    // Root doc (optional meta)
    const tourDocRef = doc(db, "publicTours", tourId)
    batch.set(tourDocRef, {
      title: "Virtual Store",
      defaultSceneId,
      order: orderIds,
      publishedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true })
    ops++
  
    // Manifest
    const manifestRef = doc(db, "publicTours", tourId, "meta", "manifest")
    batch.set(manifestRef, { 
      defaultSceneId, 
      order: orderIds, 
      publishedAt: serverTimestamp(),
      updatedAt: serverTimestamp() 
    })
    ops++
  
    // Pull the globally saved main initial view
    let mainInitialView = { yaw: 0, pitch: 0, fov: Math.PI / 2 }
    try {
      const mainSceneDoc = await getDoc(doc(db, "scenes", "main"))
      if (mainSceneDoc.exists() && mainSceneDoc.data().initialView) {
        mainInitialView = mainSceneDoc.data().initialView
      }
    } catch (e) { console.error("Get main initial view failed", e) }
  
    // 2) Scenes + hotspots
    for (let i = 0; i < orderedScenes.length; i++) {
      const img = orderedScenes[i]
      const sceneId = img.name
      const imageUrl = img.url
  
      // Prefer per-scene initial if 'sceneId' == active default, else neutral
      const initialView = sceneId === defaultSceneId
        ? mainInitialView
        : { yaw: 0, pitch: 0, fov: Math.PI / 2 }
  
      const sceneRef = doc(db, "publicTours", tourId, "scenes", sceneId)
      batch.set(sceneRef, { 
        imageUrl, 
        initialView, 
        order: i, 
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp() 
      })
      ops++
  
      if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0 }
  
      // Merge hotspots from authoring DB
      const linkQ = query(collection(db, "hotspots"), where("sceneId", "==", sceneId))
      const prodQ = query(collection(db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneId))
      const [linkSnap, prodSnap] = await Promise.all([getDocs(linkQ), getDocs(prodQ)])
  
      const merged = [
        ...linkSnap.docs.map(d => ({ id: d.id, ...d.data(), kind: "link" })),
        ...prodSnap.docs.map(d => ({ id: d.id, ...d.data(), kind: "product" }))
      ].filter(h => typeof h.yaw === "number" && typeof h.pitch === "number")
  
      for (const h of merged) {
        const hsRef = doc(db, "publicTours", tourId, "scenes", sceneId, "hotspots", h.id)
        batch.set(hsRef, {
          kind: (h.kind || "link") === "product" ? "product" : "link",
          yaw: h.yaw, 
          pitch: h.pitch,
          publishedAt: serverTimestamp(),
          ...(h.linkedScenarioId ? { linkedScenarioId: h.linkedScenarioId } : {}),
          ...(h.productId ? { productId: h.productId } : {}),
          ...(Array.isArray(h.productIds) && h.productIds.length ? { productIds: h.productIds } : {}),
          updatedAt: serverTimestamp()
        })
        ops++
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0 }
      }
    }
  
    if (ops > 0) await batch.commit()
    
    return publishSnapshot
  }, [orderedScenes, sceneOrder, hotspots, clearPublishedTour])

  const handlePublishTour = useCallback(async () => {
    const publishOperation = withHistoryTracking(async () => {
      const publishResult = await publishTour("main")
      
      // Update status immediately after successful publish
      setPublishStatus({
        isPublished: true,
        lastPublished: new Date(),
        hasChanges: false
      })
      
      // Flash success animation
      setTimeout(() => {
        const statusElement = document.querySelector('.PublishStatus')
        if (statusElement) {
          statusElement.classList.add('flash')
          setTimeout(() => statusElement.classList.remove('flash'), 1000)
        }
      }, 100)
      
      return {
        ...publishResult,
        publishedAt: new Date().toISOString(),
        tourId: "main"
      }
    }, "publish", `Published tour with ${orderedScenes.length} scenes and ${hotspots.length} hotspots`)
    
    const run = withBusyWrapper(async () => {
      const button = document.querySelector('.SaveBtn')
      if (button) button.classList.add('loading')
      try {
        await publishOperation()
        toast.showSuccess('Virtual store published successfully!')
      } finally {
        if (button) button.classList.remove('loading')
      }
    }, "Publishing tour.")
    
    await run()
  }, [publishTour, orderedScenes.length, hotspots.length, withBusyWrapper, withHistoryTracking, toast])

  const getChangesSummary = useCallback(() => {
    if (!publishStatus.hasChanges) return null
    
    return {
      scenes: orderedScenes.length,
      hotspots: hotspots.length,
      hasNewScenes: !publishStatus.isPublished,
      lastPublished: publishStatus.lastPublished
    }
  }, [publishStatus, orderedScenes.length, hotspots.length])


  const formatRelativeTime = useCallback((date) => {
    if (!date) return 'recently'
    
    const now = new Date()
    const diffInMinutes = Math.floor((now - date) / (1000 * 60))
    
    if (diffInMinutes < 1) return 'just now'
    if (diffInMinutes < 60) return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`
    
    const diffInHours = Math.floor(diffInMinutes / 60)
    if (diffInHours < 24) return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`
    
    const diffInDays = Math.floor(diffInHours / 24)
    if (diffInDays < 7) return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`
    
    return date.toLocaleDateString()
  }, [])

  useEffect(() => {
    if (!isApplyingHistory && historyManagerRef.current) {
      // Small delay to let history operations complete
      const timeoutId = setTimeout(() => {
        refreshPublishStatus()
      }, 500)
      
      return () => clearTimeout(timeoutId)
    }
  }, [isApplyingHistory, refreshPublishStatus])

  /* Idle spin */

  /* Init */
  useEffect(() => {
    let mounted = true
    const init = async () => {
      try {
        const M = await import("marzipano")
        if (!mounted) return
        setMarzipano(M)
        if (panoRef.current && !viewerRef.current) viewerRef.current = new M.Viewer(panoRef.current)
      } catch (e) { console.error("Marzipano init failed", e) }
    }
    if (typeof window !== "undefined") init()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    try { lastLinkTargetRef.current = localStorage.getItem("LastLinkTarget") || "" } catch {}
  }, [])

  useEffect(() => {
    const onResize = () => { try { viewerRef.current?.resize() } catch {} }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (Marzipano) {
      fetchImages()
      fetchSceneOrder()
    }
  }, [Marzipano, fetchImages, fetchSceneOrder])

  useEffect(() => {
    if (Marzipano && viewerRef.current && orderedScenes.length > 0 && !activeSceneUrl) {
      const first = orderedScenes[0]
      loadScene(first.url, first.name)
    }
  }, [Marzipano, orderedScenes, activeSceneUrl, loadScene])

  useEffect(() => { renderHotspotsCb() }, [renderHotspotsCb])

  useEffect(() => {
    if (!selectedHotspotId) { selectedHotspotRef.current = null; return }
    const h = hotspots.find(x => x.id === selectedHotspotId) || null
    selectedHotspotRef.current = h
    if (!h) { stopMenuTracking(); setSelectedHotspotId(null); setMenuPos(null) }
  }, [hotspots, selectedHotspotId, stopMenuTracking])

  useEffect(() => () => window.removeEventListener("mousemove", onDragMove), [onDragMove])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (busyState) return
        setAddLinkMode(false)
        setAddProductMode(false)
        setMovingHotspotId(null)
        setPendingHotspot(null)
        setPendingProductHotspot(null)
        setSelectedHotspotId(null)
        closeHotspotMenu()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeHotspotMenu, busyState])

  useEffect(() => {
    if (!selectedHotspotId) return
    if (!hotspots.some(h => h.id === selectedHotspotId)) closeHotspotMenu()
  }, [hotspots, selectedHotspotId, closeHotspotMenu])

  useEffect(() => {
    const qy = query(collection(db, "products"), orderBy("createdAt", "desc"))
    const unsub = onSnapshot(qy, (snap) => {
      const list = snap.docs.map(MapProductFromFirestore)
      setProducts(list)
    }, (err) => console.error("Products listen failed", err))
    return () => unsub()
  }, [])

  useEffect(() => { fetchHotspotCounts() }, [fetchHotspotCounts])

  const handleRenameInput = useCallback(async (index, newName) => {
    const base = newName.trim()
    if (base === "") return
    const current = imageList[index]
    const ext = current.name.split(".").pop()
    const full = `${base}.${ext}`
    await showRenameConfirmation(index, full)
  }, [imageList, showRenameConfirmation])

  useEffect(() => {
    if (!orderedScenes || orderedScenes.length === 0 || !activeSceneId) return
    const idx = orderedScenes.findIndex(s => s.name === activeSceneId)
    if (idx === -1) return
    const next = orderedScenes[idx + 1]
    const prev = orderedScenes[idx - 1]
    if (next) prefetch(next.url, next.name)
    if (prev) prefetch(prev.url, prev.name)
  }, [activeSceneId, orderedScenes, prefetch])

  useEffect(() => {
    if (orderedScenes.length > 0) {
      const first = orderedScenes[0]
      prefetch(first.url, first.name)
    }
  }, [orderedScenes, prefetch])

  useEffect(() => {
    const target = getWheelTarget();
    const view = viewRef.current;
    if (!target || !view) return;
  
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    let wheelRAF = null;
  
    const onWheel = (e) => {
      // throttle to one update per frame
      if (wheelRAF) return;
      wheelRAF = requestAnimationFrame(() => {
        wheelRAF = null;
        try {
          e.preventDefault();
          e.stopPropagation();
          const dir = Math.sign(e.deltaY); // down -> +1 (zoom out), up -> -1 (zoom in)
          const step = limits.ZOOM_STEP;   // profile-aware
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
  
  

  

  /* Pending link menu */
  const renderPendingHotspot = useCallback(() => {
    if (!pendingHotspot) return null
    const { x, y } = pendingHotspot
    if (x == null || y == null) return null
    const placeholder = "Select target scene"
    return (
      <>
        <div className="HotspotDot AbsoluteDot" style={{ left: `${x - 8}px`, top: `${y - 8}px` }} />
        <div className="HotspotSelect" style={{ left: `${x + 14}px`, top: `${y - 4}px` }} onClick={(e) => e.stopPropagation()}>
          <select
            className="SelectInput"
            autoFocus
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              lastLinkTargetRef.current = id
              try { localStorage.setItem("LastLinkTarget", id) } catch {}
              saveNewHotspot(id)
            }}
          >
            <option value="" disabled>{placeholder}</option>
            {orderedScenes.map((img) => (<option key={img.name} value={img.name}>{img.name.replace(/\.[^/.]+$/, "")}</option>))}
          </select>
        </div>
      </>
    )
  }, [pendingHotspot, orderedScenes, saveNewHotspot])

  

  /* Pending product menu */
  const renderPendingProductHotspot = useCallback(() => {
    if (!pendingProductHotspot) return null
    const { x, y } = pendingProductHotspot
    if (x == null || y == null) return null
    const filtered = products.filter(p =>
      p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.id.toLowerCase().includes(productSearch.toLowerCase())
    )
    const isSelected = id => pendingProductSelection.has(id)
    const onSaveDirectly = async () => {
      const ids = Array.from(pendingProductSelection)
      if (ids.length > 0) await saveNewProductHotspot(ids)
    }

    
    return (
      <>
        <div className="HotspotDot AbsoluteDot ProductDot" style={{ left: `${x - 8}px`, top: `${y - 8}px` }} />
        <div className="ProductSelectPanel" style={{ left: `${x + 14}px`, top: `${y - 4}px` }} onClick={e => e.stopPropagation()}>
          <div className="ProductSelectHeader">
            <span>Select products ({pendingProductSelection.size})</span>
            <button className="HotspotPanelClose" onClick={() => { setPendingProductHotspot(null); setPendingProductSelection(new Set()) }} disabled={!!busyState}>×</button>
          </div>
          <div className="ProductSearchRow">
            <input className="ProductSearchInput" placeholder="Search products..." value={productSearch} onChange={e => setProductSearch(e.target.value)} autoFocus disabled={!!busyState} />
          </div>
          <SimpleBar className="ProductList VS-Editor-Scrollbar">
            {filtered.slice(0, 50).map(p => (
              <button key={p.id} className={`ProductRow${isSelected(p.id) ? " Selected" : ""}`} onClick={() => togglePendingProduct(p.id)} title={p.name} disabled={!!busyState}>
                <img className="ProductThumb" src={p.imageUrl} alt={p.name} />
                <div className="ProductRowMeta">
                  <div className="ProductRowName">{p.name}</div>
                  <div className="ProductRowPrice">₱{p.price}{p.originalPrice && p.originalPrice > p.price ? <span className="ProductRowOld">₱{p.originalPrice}</span> : null}</div>
                  <div className="ProductRowStock">Stock {p.stock}</div>
                </div>
                <div className="ProductRowCheck">{isSelected(p.id) ? "✓" : ""}</div>
              </button>
            ))}
            {filtered.length === 0 && <div className="ProductEmpty">No products found</div>}
          </SimpleBar>
          <div className="AddProductSelectFooter">
            
            <div className="AddProductSelectActions">
              <button className="BtnClear" onClick={() => setPendingProductSelection(new Set())} disabled={pendingProductSelection.size === 0 || !!busyState}>Clear</button>
              <button className="ApplyChangesButton" onClick={onSaveDirectly} disabled={pendingProductSelection.size === 0 || !!busyState}>Save</button>
            </div>
          </div>
        </div>
      </>
    )
  }, [pendingProductHotspot, products, productSearch, pendingProductSelection, togglePendingProduct, saveNewProductHotspot, busyState])

  /* Product edit panel */
  const renderProductMenuPanel = useCallback(() => {
    const selectedCount = menuProductSelection.size

    // Filter by search first (unchanged)
    const filtered = products.filter(p =>
      p.name.toLowerCase().includes(menuProductSearch.toLowerCase()) ||
      p.id.toLowerCase().includes(menuProductSearch.toLowerCase())
    )

    // If no search text, prioritize selected products and keep their saved order
    const orderedList = (() => {
      if (menuProductSearch.trim().length > 0 || selectedCount === 0) return filtered

      const orderIndex = new Map(
        (menuSelectedOrderRef.current || []).map((id, idx) => [id, idx])
      )
      const selected = filtered
        .filter(p => menuProductSelection.has(p.id))
        .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
      const unselected = filtered.filter(p => !menuProductSelection.has(p.id))
      return [...selected, ...unselected]
    })()
    return (
      <div className="HotspotMenuPanel Below" style={{ "--panelOffset": `${PRODUCT_ARC.panelOffset}px` }}>
        <div className="HotspotMenuPanelHeader">
          <span>Edit Products ({selectedCount})</span>
          <button className="HotspotPanelClose" onClick={closeHotspotMenu} disabled={!!busyState}>×</button>
        </div>
        <div className="ProductSelectInner">
          <input className="ProductSearchInput InMenu" placeholder="Search products..." value={menuProductSearch} onChange={e => setMenuProductSearch(e.target.value)} autoFocus disabled={!!busyState} />
          <SimpleBar className="ProductList InMenu VS-Editor-Scrollbar">
            {orderedList.slice(0, 40).map(p => {
              const checked = menuProductSelection.has(p.id)
              return (
                <button key={p.id} className={`ProductRow${checked ? " Selected" : ""}`} onClick={() => handleMenuToggleProduct(p.id)} title={p.name} disabled={!!busyState}>
                  <img className="ProductThumb" src={p.imageUrl} alt={p.name} />
                  <div className="ProductRowMeta">
                    <div className="ProductRowName">{p.name}</div>
                    <div className="ProductRowPrice">₱{p.price}{p.originalPrice && p.originalPrice > p.price && <span className="ProductRowOld">₱{p.originalPrice}</span>}</div>
                    <div className="ProductRowStock">Stock: {p.stock}</div>
                  </div>
                  <div className="ProductRowCheck">{checked ? "✓" : ""}</div>
                </button>
              )
            })}
            {filtered.length === 0 && <div className="ProductEmpty">No products found</div>}
          </SimpleBar>
          <div className="ProductSelectFooter InMenu">
            <div className="ProductSelectInfo">
              {selectedCount === 0 && "Select at least One Product"}
              {selectedCount === 1 && "Single Product Hotspot"}
              {selectedCount > 1 && `Multi-Product Hotspot (${selectedCount})`}
            </div>
            <div className="ProductSelectActions">
              <button className="BtnClear" onClick={() => setMenuProductSelection(new Set())} disabled={selectedCount === 0 || !!busyState}>Clear</button>
              <button className="ApplyChangesButton" onClick={handleMenuSaveProducts} disabled={selectedCount === 0 || !!busyState}>Save Changes</button>
            </div>
          </div>
        </div>
      </div>
    )
  }, [menuProductSelection, products, menuProductSearch, handleMenuToggleProduct, closeHotspotMenu, handleMenuSaveProducts, busyState])

  /* Confirm list */
  const ConfirmProductsModal = ({ open, onCancel, onConfirm, products, ids, isLoading }) => {
    if (!open) return null
    const selected = ids.map(id => products.find(p => p.id === id)).filter(Boolean)
    return (
      <div className="ConfirmOverlay" onClick={isLoading ? undefined : onCancel}>
        <div className="ConfirmBox" onClick={e => e.stopPropagation()}>
          <div className="ConfirmHeader">
            <h3>Confirm products</h3>
            <button className="CloseBtn" onClick={onCancel} disabled={isLoading}>×</button>
          </div>
          <div className="ConfirmBody">
            <div className="ConfirmLine">Selected {selected.length} product{selected.length !== 1 ? "s" : ""}</div>
            <div className="ConfirmList">
              {selected.map(p => (
                <div key={p.id} className="ConfirmRow">
                  <img className="ConfirmThumb" src={p.imageUrl} alt={p.name} />
                  <div className="ConfirmMeta">
                    <div className="ConfirmName">{p.name}</div>
                    <div className="ConfirmPrice">₱{p.price}{p.originalPrice && p.originalPrice > p.price ? <span className="ProductRowOld">₱{p.originalPrice}</span> : null}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="ConfirmFooter">
            <button className="BtnSecondary" onClick={onCancel} disabled={isLoading}>Cancel</button>
            <button className="ApplyChangesButton" onClick={onConfirm} disabled={isLoading}>{isLoading ? "Saving..." : "Save"}</button>
          </div>
          {isLoading && <div className="ConfirmSavingOverlay"><div className="ConfirmSpinner"></div></div>}
        </div>
      </div>
    )
  }

  /* Scene card renderer */
  const renderSceneCard = useCallback((scene, indexInFiltered) => {
    const isActive = scene.url === activeSceneUrl
    const hotspotCount = sceneHotspotCounts[scene.name] || 0
    const imageIndex = imageList.findIndex(img => img.name === scene.name)
    const isDefault = filteredScenes.findIndex(s => s.name === scene.name) === 0 && sceneSearch === ""
    const thumbSrc = scene.thumbUrl || thumbCacheRef.current.get(scene.name) || scene.url
    return (
      <div
        key={scene.name}
        className={`SceneCard ${isActive ? "Active" : ""} ${draggedSceneId === scene.name ? "Dragging" : ""}`}
        data-scene-id={scene.name}
        role="listitem"
        draggable={!busyState && !isRenaming}
        onDragStart={e => handleSceneDragStart(e, scene.name)}
        onDragEnd={handleSceneDragEnd}
        onDragOver={e => handleSceneDragOver(e, indexInFiltered)}
        onDrop={e => handleSceneDrop(e, indexInFiltered)}
        aria-grabbed={draggedSceneId === scene.name ? "true" : "false"}
        aria-dropeffect={!isRenaming && draggedSceneId && draggedSceneId !== scene.name ? "move" : "none"}
        onMouseEnter={() => prefetch(scene.url, scene.name)}
        onFocus={() => prefetch(scene.url, scene.name)}
      >
        <div className="SceneMeta">
          <div className="SceneHeader">
              <button
                className="DragHandle"
                tabIndex={0}
                title={isRenaming ? "Reorder disabled while renaming" : "Drag or use arrows"}
                disabled={!!busyState || isRenaming}
                onKeyDown={e => handleSceneKeyDown(e, scene.name, indexInFiltered)}
                onClick={stopCardClick}
                aria-label={`Reorder ${scene.name.replace(/\.[^/.]+$/, "")} scene`}
              >
              <FontAwesomeIcon icon={faGripVertical} />
            </button>
            <div className="SceneName" title={scene.name}>
                {scene.name.replace(/\.[^/.]+$/, "")}
              </div>
          </div>

          <div className="SceneInfo" >
            {scene.isEditing && (
              <input
                className="RenameInput"
                value={scene.draftBase ?? scene.name.replace(/\.[^/.]+$/, "")}
                onClick={stopCardClick}
                onChange={e => setDraftBase(imageIndex, e.target.value)}
                onKeyDown={async e => {
                  if (e.key === "Enter") {
                    await handleRenameConfirm(imageIndex)
                  } else if (e.key === "Escape") {
                    cancelRename(imageIndex)
                  }
                }}
                autoFocus
                disabled={!!busyState}
              />
            )}
          </div>

          <div className="SceneActions">
            {!isDefault && (
              <button
                className="IconButton"
                onClick={(e) => { stopCardClick(e); !busyState && setAsDefault(scene.name) }}
                disabled={!!busyState}
                aria-pressed={isDefault ? "true" : "false"}
                title="Set default"
              >
                <FontAwesomeIcon icon={faStar} />
              </button>
            )}

            {!scene.isEditing ? (
              <button
                className="IconButton"
                onClick={(e) => { stopCardClick(e); !busyState && beginRename(imageIndex) }}
                disabled={!!busyState}
                title="Rename"
                aria-label="Rename"
              >
                <FontAwesomeIcon icon={faPen} />
              </button>
            ) : (
              <>
                <button
                  className="IconButton"
                  onClick={(e) => { stopCardClick(e); !busyState && cancelRename(imageIndex) }}
                  disabled={!!busyState}
                  title="Cancel rename"
                  aria-label="Cancel rename"
                >
                  <FontAwesomeIcon icon={faCircleXmark} />
                </button>
                <button
                  className="IconButton"
                  onClick={(e) => { stopCardClick(e); !busyState && handleRenameConfirm(imageIndex) }}
                  disabled={!!busyState}
                  title="Confirm rename (Enter)"
                  aria-label="Confirm rename"
                >
                  <FontAwesomeIcon icon={faCircleCheck} />
                </button>
              </>
            )}

            <button
              className="IconButton Danger"
              onClick={(e) => { stopCardClick(e); !busyState && showDeleteConfirmation(indexInFiltered) }}
              disabled={!!busyState}
              title="Delete"
              aria-label="Delete"
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          </div>
        </div>
        <div className="SceneThumbWrap" >
          {isDefault && ( <div className="DefaultBadge" title="Default scene"> <FontAwesomeIcon icon={faStar} /> </div> )}
          <img className="SceneThumb" src={thumbSrc} alt={`${scene.name} preview`} loading="lazy" decoding="async" />
        </div>
      </div>
    )
  }, [
    activeSceneUrl,
    sceneHotspotCounts,
    imageList,
    filteredScenes,
    sceneSearch,
    draggedSceneId,
    busyState,
    isRenaming,
    handleSceneDragStart,
    handleSceneDragEnd,
    handleSceneDragOver,
    handleSceneDrop,
    handleSceneKeyDown,
    setAsDefault,
    showDeleteConfirmation,
    beginRename,
    cancelRename,
    setDraftBase,
    handleRenameConfirm
  ])

  const onScenesListClick = useCallback((e) => {
    if (busyState) return
    const card = e.target.closest(".SceneCard")
    if (!card) return
    if (e.target.closest(".IconButton") || e.target.closest(".DragHandle") || e.target.closest(".RenameInput")) return
    const id = card.dataset.sceneId
    const s = imageList.find(x => x.name === id)
    if (s) loadScene(s.url, s.name)
  }, [busyState, imageList, loadScene])
  
  const stopCardClick = useCallback(e => e.stopPropagation(), [])
  const useDebugHistory = () => {
    useEffect(() => {
      if (process.env.NODE_ENV === 'development') {
        console.log('History Debug:', {
          historyLength: historyState.history.length,
          currentIndex: historyState.currentIndex,
          canUndo: historyState.canUndo,
          canRedo: historyState.canRedo,
          activeSceneId,
          hotspotsCount: hotspots.length,
          isApplyingHistory
        })
      }
    }, [historyState, activeSceneId, hotspots.length, isApplyingHistory])
  }
  
  // Call this hook in your main component
  useDebugHistory()

  const withHistoryErrorHandling = useCallback((operation, operationName) => {
    return async (...args) => {
      try {
        return await operation(...args)
      } catch (error) {
        console.error(`History operation '${operationName}' failed:`, error)
        toast.error(`Failed to ${operationName}. Please try again.`)
        
        // Reset history state if it's corrupted
        if (historyManagerRef.current && error.message?.includes('history')) {
          try {
            await historyManagerRef.current.initialize(hotspotsRef.current, activeSceneId)
          } catch (resetError) {
            console.error('Failed to reset history:', resetError)
          }
        }
        
        throw error
      }
    }
  }, [toast, activeSceneId])

  const validateHotspotState = useCallback((hotspots, context = '') => {
    if (process.env.NODE_ENV === 'development') {
      const issues = []
      
      hotspots.forEach((hotspot, index) => {
        if (!hotspot.id) issues.push(`Hotspot ${index} missing ID`)
        if (!hotspot.sceneId) issues.push(`Hotspot ${hotspot.id || index} missing sceneId`)
        if (typeof hotspot.yaw !== 'number') issues.push(`Hotspot ${hotspot.id || index} invalid yaw`)
        if (typeof hotspot.pitch !== 'number') issues.push(`Hotspot ${hotspot.id || index} invalid pitch`)
        
        if (isProductHotspot(hotspot)) {
          if (!hotspot.productId && (!hotspot.productIds || hotspot.productIds.length === 0)) {
            issues.push(`Product hotspot ${hotspot.id || index} has no products`)
          }
        } else {
          if (!hotspot.linkedScenarioId) {
            issues.push(`Link hotspot ${hotspot.id || index} missing linkedScenarioId`)
          }
        }
      })
      
      if (issues.length > 0) {
        console.warn(`Hotspot validation issues (${context}):`, issues)
      }
      
      return issues.length === 0
    }
    return true
  }, [])

  const recoverFromCorruptedState = useCallback(async () => {
    console.warn('Attempting to recover from corrupted state...')
    
    try {
      // Clear all interactive states
      setSelectedHotspotId(null)
      setMoveHotspotId(null)
      setMovingHotspotId(null)
      setAddLinkMode(false)
      setAddProductMode(false)
      setPendingHotspot(null)
      setPendingProductHotspot(null)
      setIsApplyingHistory(false)
      
      // Clear history and reinitialize
      if (historyManagerRef.current) {
        historyManagerRef.current.clearHistory()
        
        if (activeSceneId) {
          // Reload hotspots from Firebase
          await loadHotspotsForScene({ 
            db, 
            sceneId: activeSceneId, 
            token: sceneLoadTokenRef.current, 
            sceneLoadTokenRef, 
            activeSceneIdRef, 
            setHotspots 
          })
          
          // Reinitialize history
          setTimeout(async () => {
            await historyManagerRef.current.initialize(hotspotsRef.current, activeSceneId)
          }, 500)
        }
      }
      
      toast.success('State recovered successfully')
    } catch (error) {
      console.error('State recovery failed:', error)
      toast.error('Failed to recover state. Please refresh the page.')
    }
  }, [activeSceneId, toast])

  /* VirtualEditor.jsx — replace DebugPanel return with class names only */
const DebugPanel = () => {
  if (process.env.NODE_ENV !== 'development') return null
  return (
    <div className="DebugPanel">
      <div>History: {historyState.history.length} | Index: {historyState.currentIndex}</div>
      <div>Hotspots: {hotspots.length} | Scene: {activeSceneId}</div>
      <div>Applying: {isApplyingHistory ? 'Yes' : 'No'}</div>
      <button className="DebugBtn" onClick={recoverFromCorruptedState}>Recover State</button>
    </div>
  )
}


  /* UI */
  return (
    <div className={`EditorContainer ${busyState ? "EditorLocked" : ""}`}>
      <div className="EditorSidebar">
        <div className="SidebarHeader">
          <h1 className="SidebarTitle">Admin - Virtual Store Editor</h1>
          <p className="SidebarSubtitle">Create immersive shopping experiences</p>
        </div>

        <div className="SidebarContent">
 
          <div className="Section">
            <h3 className="SectionTitle">Upload Scene</h3>
            <p className="SectionDescription">Add panoramic images of your store</p>
            <button className="UploadBtn" onClick={() => setShowPopup(true)} disabled={!!busyState}>
              <FontAwesomeIcon icon={faPlus} className="IconLeft" />
              Upload Image
            </button>
          </div>

          <div className="Section">
            <div className="SectionHeader">
              <h3 className="SectionTitle">Scenes ({filteredScenes.length})</h3>
              {orderedScenes.length > 0 && (
                <div className="SceneSearchWrapper">
                  <FontAwesomeIcon icon={faSearch} className="SearchIcon" />
                  <input
                    className="SceneSearchInput"
                    placeholder="Search scenes..."
                    value={sceneSearchInput}
                    onChange={e => setSceneSearchInput(e.target.value)}
                    disabled={!!busyState}
                  />
                </div>
              )}
            </div>

            <div className="ScenesList" onClick={onScenesListClick} role="list" aria-label="Scene list" aria-live="polite">
              {filteredScenes.length === 0 && orderedScenes.length === 0 ? (
                <div className="SceneEmptyState">
                  <div className="EmptyStateIcon">🏪</div>
                  <div className="EmptyStateTitle">No scenes yet</div>
                  <div className="EmptyStateDescription">Upload your first panoramic image to get started</div>
                  <button className="EmptyStateButton" onClick={() => setShowPopup(true)} disabled={!!busyState}>Upload Scene</button>
                </div>
              ) : filteredScenes.length === 0 ? (
                <div className="SceneEmptyState">
                  <div className="EmptyStateIcon">🔍</div>
                  <div className="EmptyStateTitle">No matching scenes</div>
                  <div className="EmptyStateDescription">Try adjusting your search</div>
                </div>
              ) : (
                scenesToRender.map(scene => renderSceneCard(scene, filteredIndexMap.get(scene.name)))
              )}

              {filteredScenes.length > 2 && !showAllScenes && (
                <div className="ShowMoreRow">
                  <button
                    className="BtnSecondary Small"
                    onClick={() => setShowAllScenes(true)}
                    aria-label="Show more scenes"
                    title="Show more"
                    disabled={!!busyState}
                  >
                    Show More ({filteredScenes.length - 2} more)
                  </button>
                </div>
              )}

              {showAllScenes && filteredScenes.length > 2 && (
                <div className="ShowMoreRow">
                  <button
                    className="BtnSecondary Small"
                    onClick={() => setShowAllScenes(false)}
                    aria-label="Show less scenes"
                    title="Show less"
                    disabled={!!busyState}
                  >
                    Show Less
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="Section">
            <h3 className="SectionTitle">Add Hotspots</h3>
            <div className="HotspotActions">
              <button className="Btn" onClick={EnterAddMode} disabled={!!busyState}>Add Link</button>
              <button className="Btn" onClick={EnterAddProductMode} disabled={!!busyState}>
                Add Product
              </button>
            </div>
          </div>

          <div className="Section">
            <h3 className="SectionTitle">Hotspots ({hotspots.length})</h3>
            <p className="SectionDescription">{hotspots.length === 0 ? "No hotspots added yet" : "Click a circle to edit"}</p>
          </div>
         
        </div>
        

        <div className="SidebarFooter">
          {/* Publish Status Indicator */}
          {publishStatus.isPublished && (
            <div className="PublishStatusBar">
              <div className={`PublishStatus ${publishStatus.hasChanges ? 'HasChanges' : 'Published'}`}>
                <div className="PublishStatusIcon">
                  {publishStatus.hasChanges ? '●' : '✓'}
                </div>
                <div className="PublishStatusText">
                  {publishStatus.hasChanges ? (
                    <span>There Are Unpublished Changes</span>
                  ) : (
                    <span>
                      Published {publishStatus.lastPublished 
                        ? formatRelativeTime(publishStatus.lastPublished)
                        : 'recently'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Enhanced Save Button */}
          <button
              className={`animated-button SaveBtn ${
                publishStatus.hasChanges ? 'HasChanges' :
                publishStatus.isPublished ? 'Published' : ''
              }`}
              onClick={handlePublishTour}
              disabled={!!busyState || (!publishStatus.hasChanges && publishStatus.isPublished)}
              title={
                !publishStatus.isPublished
                  ? `Publish ${orderedScenes.length} scenes and ${hotspots.length} hotspots for the first time`
                  : publishStatus.hasChanges
                  ? `Publish changes: ${orderedScenes.length} scenes, ${hotspots.length} hotspots`
                  : 'All changes are published'
              }
            >
              <span className="text">
                {
                  !publishStatus.isPublished
                    ? 'Publish Virtual Store'
                    : publishStatus.hasChanges
                    ? 'Publish Changes' 
                    : 'Published'
                }
              </span>
             
            </button>


          {/* Change Summary (when there are unpublished changes) */}
          {publishStatus.hasChanges && (
            <div className="ChangesSummary">
              <div className="ChangesSummaryText">
                {orderedScenes.length} scene{orderedScenes.length !== 1 ? 's' : ''}, {hotspots.length} hotspot{hotspots.length !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={editorPreviewRef} className="EditorPreview" onClick={handlePreviewClick} onMouseMove={handleEditorMouseMove}>
        <HistoryToolbar
          historyState={historyState}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onJumpToHistory={handleJumpToHistory}
          disabled={!!busyState || isApplyingHistory}
        />
        <button
          className="PreviewButton"
          onClick={(e) => { e.stopPropagation(); !busyState && setShowPreview(true) }}
          disabled={!!busyState}
        >
        <div className="sign">
          <FontAwesomeIcon icon={faEye} />
        </div>
        
        <div className="text">Preview</div>
      </button>
        

        {isLoadingScene && <div className="SceneSpinnerOverlay"><div className="SceneSpinner"></div></div>}

        <div ref={panoRef} id="pano" className="MarzipanoViewer"></div>
          <div className="InitialViewOverlay">
            <div className="InitialViewReadout">
              <LiveViewDisplay view={liveView} />
            </div>
              <button
                className="InitialViewButton"
                onClick={setInitialView}
                disabled={!!busyState || !currentSceneRef.current}
              >
              <FontAwesomeIcon icon={faStreetView}/>
              </button>
          </div>

        {renderPendingHotspot()}
        {renderPendingProductHotspot()}

        {addLinkMode && (
          <>
            <div className="HotspotDot HotspotDotGhost AbsoluteDot" style={{ left: `${mousePos.x - 8}px`, top: `${mousePos.y - 8}px` }} />
            <button type="button" className="AddHotspotCancelBtn" onClick={(e) => { e.stopPropagation(); setAddLinkMode(false); setPendingHotspot(null) }} title="Cancel adding hotspot">Cancel</button>
          </>
        )}

        {addProductMode && (
          <>
            <div className="HotspotDot HotspotDotGhost ProductDot AbsoluteDot" style={{ left: `${mousePos.x - 8}px`, top: `${mousePos.y - 8}px` }} />
            <button type="button" className="AddHotspotCancelBtn" onClick={(e) => { e.stopPropagation(); setAddProductMode(false); setPendingProductHotspot(null) }} title="Cancel adding product hotspot">Cancel</button>
          </>
        )}

        {movingHotspotId && !addLinkMode && !addProductMode && (
          <>
            <div className="HotspotDot HotspotDotGhost AbsoluteDot" style={{ left: `${mousePos.x - 8}px`, top: `${mousePos.y - 8}px` }} />
            <button type="button" className="AddHotspotCancelBtn" onClick={(e) => { e.stopPropagation(); setMovingHotspotId(null) }} title="Cancel moving hotspot">Cancel</button>
          </>
        )}

          {selectedHotspotId && menuPos && !busyState && (
            <div className="HotspotMenu" style={{ left: `${menuPos.left}px`, top: `${menuPos.top}px` }} onClick={(e) => e.stopPropagation()}>
              {(() => {
                const sel = hotspots.find(h => h.id === selectedHotspotId)
                const isProduct = (sel?.kind || "link") === "product"
                const currentArc = isProduct ? PRODUCT_ARC : LINK_ARC
                
                return (
                  <>
                    <div className="HotspotArc" style={{ "--radius": `${currentArc.radius}px` }}>
                      <button className="ArcBtn" style={{ "--a": `${currentArc.angles[0]}deg` }} title="Move" onClick={() => EnterMoveMode(selectedHotspotId)}>
                        <FontAwesomeIcon icon={faChevronUp} />
                      </button>
                      {!isProduct && (
                        <button className="ArcBtn" style={{ "--a": `${currentArc.angles[1]}deg` }} title="Rotate" onClick={handleMenuRotate45}>
                          <FontAwesomeIcon icon={faRotateRight} />
                        </button>
                      )}
                      <button className="ArcBtn Danger" style={{ "--a": `${currentArc.angles[isProduct ? 1 : 2]}deg` }} title="Delete" onClick={handleMenuDelete}>
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                      <button className="ArcBtn" style={{ "--a": `${currentArc.angles[isProduct ? 2 : 3]}deg` }} title="Close" onClick={closeHotspotMenu}>×</button>
                    </div>

                    {(() => {
                      if (!isProduct) {
                        return (
                          <div className="HotspotMenuPanel Below" style={{ "--panelOffset": `${currentArc.panelOffset}px` }}>
                            <div className="HotspotMenuPanelHeader">
                              <span>Select target scene</span>
                              <button className="HotspotPanelClose" onClick={closeHotspotMenu}>×</button>
                            </div>
                            <select
                              className="HotspotMenuSelect"
                              value={sel?.linkedScenarioId ?? ""}
                              onChange={(e) => {
                                e.stopPropagation()
                                handleMenuChangeScene(e.target.value)
                              }}
                            >
                              <option value="" disabled>
                                {sel?.linkedScenarioId ? `Current: ${sel.linkedScenarioId.replace(/\.[^/.]+$/, "")}` : "Select target scene"}
                              </option>
                              {orderedScenes.map((img) => (
                                <option key={img.name} value={img.name}>
                                  {img.name.replace(/\.[^/.]+$/, "")}
                                </option>
                              ))}
                            </select>
                          </div>
                        )
                      }
                      return renderProductMenuPanel()
                    })()}
                  </>
                )
              })()}
            </div>
          )}
      </div>

      {showPopup && (
        <div className="UploadPanoramaOverlay">
          <div className="UploadPanoramaBox">
            <div className="UploadPanoramaHeader">
              <h2>Upload Panorama</h2>
              <button className="CloseBtn" onClick={resetUploadState} disabled={!!busyState}>×</button>
            </div>
            <div className="UploadPanoramaDropArea" onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; !busyState && handleUploadFile(f) }} onDragOver={(e) => e.preventDefault()}>
              <input type="file" id="fileInput" accept="image/*" className="HiddenInput" onChange={(e) => !busyState && handleUploadFile(e.target.files[0])} disabled={!!busyState} />
              {previewURL ? (
                <>
                  <div className="UploadPanoramaPreview"><img src={previewURL} alt="preview" /></div>
                  <div className="UploadPanoramaAttached">
                    <p><strong>Attached:</strong></p>
                    {renameMode ? (
                      <div className="UploadPanoramaNameRow">
                        <input className="RenameInput" value={customFileName.replace(/\.[^/.]+$/, "")} onChange={(e) => {
                          const ext = uploadFile?.name.split(".").pop()
                          setCustomFileName(`${e.target.value}.${ext}`)
                        }} onBlur={() => setRenameMode(false)} autoFocus disabled={!!busyState} />
                        <span className="FileExtension">.{uploadFile?.name.split(".").pop()}</span>
                      </div>
                    ) : (
                      <div className="UploadPanoramaNameRow">
                        <span className="UploadPanoramaFileName" onDoubleClick={() => !busyState && setRenameMode(true)}>{customFileName}</span>
                        <button className="RenameIcon" onClick={() => setRenameMode(true)} disabled={!!busyState}><FontAwesomeIcon icon={faPen} /></button>
                      </div>
                    )}
                    <br />
                    <button className="ReplaceImageButton" onClick={() => document.getElementById("fileInput").click()} disabled={!!busyState}>Replace Image</button>
                  </div>
                  {imageError && <small className="ImageErrorMessage">{imageError}</small>}
                  <div className="UploadPanoramaFooter">
                    <button className="BtnSecondary" onClick={resetUploadState} disabled={!!busyState}>Cancel</button>
                    <button className="ApplyChangesButton" onClick={handleUploadToFirebase} disabled={!!busyState || !uploadFile}>Upload</button>
                  </div>
                </>
              ) : (
                <label htmlFor="fileInput" className="UploadPanoramaLabel">
                  <p><b>Click to Upload</b> or <span className="UploadPanoramaHighlight">Drag and Drop</span></p>
                  <p>PNG, JPG, Max 15MB</p>
                  {imageError && <small className="ImageErrorMessage">{imageError}</small>}
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      {showPreview && (
        <PreviewOverlay
          show={showPreview}
          onClose={() => setShowPreview(false)}
          Marzipano={Marzipano}
          activeSceneUrl={activeSceneUrl}
          activeSceneId={activeSceneId}
          imageList={orderedScenes}
          resolveProductById={async (id) => {
            try {
              const snap = await getDoc(doc(db, "products", id))
              if (snap.exists()) return MapProductFromFirestore(snap)
            } catch (e) { console.error("Resolve product failed", e) }
            return null
          }}
        />
      )}

      {confirmOpen && (
        <ConfirmProductsModal
          open={confirmOpen}
          onCancel={() => { if (!busyState) { setConfirmOpen(false); setConfirmPayload(null) } }}
          onConfirm={async () => {
            const p = confirmPayload
            if (!p || !p.ids || p.ids.length === 0) { setConfirmOpen(false); setConfirmPayload(null); return }
            setConfirmOpen(false)
            setConfirmPayload(null)
            try {
              if (p.type === "create") await saveNewProductHotspot(p.ids)
              else if (p.type === "update" && p.hotspotId) await applyProductsToHotspot(p.hotspotId, p.ids)
            } catch (e) { console.error("Confirm products failed", e) }
          }}
          products={products}
          ids={confirmPayload?.ids || []}
          isLoading={!!busyState}
        />
      )}

      {confirmDelete && (
        <div className="Delete-Modal-Overlay" role="dialog" aria-modal="true">
          <div className="Delete-Modal-Box">
            <div className="Delete-Modal-Icon">
              <FontAwesomeIcon icon={faTrash} size="2x" />
            </div>

            <h2>
              You are about to <span className="Delete-Product-Warning">DELETE</span> a Scene!
            </h2>
            <p>
              This will permanently delete <span className="Delete-Product-Name">{confirmDelete.scene.name}</span> from the tour.<br />
              Are you sure? This action cannot be undone.
            </p>

            <div className="ConfirmLine"><b>Scene:</b> {confirmDelete.scene.name}</div>
            <div className="SubConfirmLine">This removes the scene image and all associated hotspots.</div>


            <div className="Delete-Modal-Actions">
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="Delete-Modal-Confirm" onClick={deleteImage}>Delete</button>
            </div>
          </div>
        </div>
      )}

        {confirmRename && (
          <div className="Delete-Modal-Overlay" role="dialog" aria-modal="true">
            <div className="Delete-Modal-Box">
              <div className="Delete-Modal-Icon">
                <FontAwesomeIcon icon={faTrash} size="2x" />
              </div>
              <h2>
                You are about to <span className="Delete-Product-Warning">RENAME</span> a Scene!
              </h2>
              <p>
                This will permanently alter <span className="Delete-Product-Name">{confirmRename.oldName}</span> from the catalog.<br />
                Are you sure? This action cannot be undone.
              </p>

              <div className="ConfirmLine"><b>Old:</b> {confirmRename.oldName}</div>
              <div className="ConfirmLine"><b>New:</b> {confirmRename.newName}</div>
              <div className="SubConfirmLine">This re-uploads under the new name and updates hotspot references.</div>

              <div className="Delete-Modal-Actions">
                <button onClick={() => setConfirmRename(null)}>Cancel</button>
                <button className="Delete-Modal-Confirm" onClick={renameImage}>Rename</button>
              </div>
            </div>
          </div>
        )}

      <BlockingOverlay show={!!busyState} label={busyState?.label || "Processing..."} />
    </div>
  )
}

const VirtualEditor = () => (
  <ToastProvider>
    <VirtualEditorCore />
  </ToastProvider>
)

export default VirtualEditor