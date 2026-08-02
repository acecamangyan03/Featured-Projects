// HistoryManager.js - Fixed version with proper hotspot cleanup
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  writeBatch,
  getDocs,
  query,
  where,
  doc
} from "firebase/firestore"
import { 
  PRODUCT_HOTSPOT_COLLECTION, 
  getHotspotDocRef, 
  isProductHotspot 
} from "./HotspotLogic"

export class HistoryManager {
  constructor(db, maxHistorySize = 100) {
    this.db = db
    this.maxHistorySize = maxHistorySize
    this.history = []
    this.currentIndex = -1
    this.listeners = new Set()
  }

  // Subscribe to history changes
  subscribe(callback) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  // Notify all listeners of history state changes
  notifyListeners() {
    const state = {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      history: this.getHistoryPreview(),
      currentIndex: this.currentIndex
    }
    this.listeners.forEach(callback => callback(state))
  }

  // Check if undo is possible
  canUndo() {
    return this.currentIndex > 0
  }

  // Check if redo is possible
  canRedo() {
    return this.currentIndex < this.history.length - 1
  }

  // Get history preview for dropdown
  getHistoryPreview() {
    return this.history.map((entry, index) => ({
      id: entry.id,
      action: entry.action,
      timestamp: entry.timestamp,
      description: entry.description,
      isCurrent: index === this.currentIndex,
      sceneId: entry.sceneId
    }))
  }

  getState() {
    return {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      history: this.getHistoryPreview(),
      currentIndex: this.currentIndex
    }
  }

  // Create a snapshot of current hotspots state
  async createSnapshot(hotspots, sceneId, action, description, extras = {}) {
    // Ensure we have valid data before creating snapshot
    if (!Array.isArray(hotspots)) {
      console.warn("Invalid hotspots array provided to createSnapshot")
      return null
    }
    
    const snapshot = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      action,
      description,
      sceneId,
      hotspots: hotspots.map(h => {
        if (!h || !h.id) return null
        return {
          id: h.id,
          kind: h.kind || (isProductHotspot(h) ? 'product' : 'link'),
          sceneId: h.sceneId,
          yaw: typeof h.yaw === 'number' ? h.yaw : 0,
          pitch: typeof h.pitch === 'number' ? h.pitch : 0,
          rotationDeg: h.rotationDeg || 0,
          linkedScenarioId: h.linkedScenarioId,
          productId: h.productId,
          productIds: Array.isArray(h.productIds) ? [...h.productIds] : null
        }
      }).filter(Boolean), // Remove any null entries
      ...extras
    }
  
    // Clear future history if we're not at the end
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1)
    }
  
    this.history.push(snapshot)
    this.currentIndex = this.history.length - 1
  
    // Maintain history size limit
    if (this.history.length > this.maxHistorySize) {
      this.history.shift()
      this.currentIndex--
    }
  
    this.notifyListeners()
    return snapshot.id
  }

  // Undo to previous state
  async undo() {
    if (!this.canUndo()) return null

    this.currentIndex--
    const targetSnapshot = this.history[this.currentIndex]
    
    this.notifyListeners()
    return targetSnapshot
  }

  // Redo to next state
  async redo() {
    if (!this.canRedo()) return null

    this.currentIndex++
    const targetSnapshot = this.history[this.currentIndex]
    
    this.notifyListeners()
    return targetSnapshot
  }

  // Jump to specific history point
  async jumpToHistory(targetIndex) {
    if (targetIndex < 0 || targetIndex >= this.history.length) return null

    this.currentIndex = targetIndex
    const targetSnapshot = this.history[this.currentIndex]
    
    this.notifyListeners()
    return targetSnapshot
  }

  // Safe hotspot cleanup - prevents the style error
  safeCleanupHotspots(currentSceneRef, hotspotElsRef, deletedHotspotIdsRef) {
    const map = hotspotElsRef.current || {}
    const container =
      currentSceneRef?.current && typeof currentSceneRef.current.hotspotContainer === "function"
        ? currentSceneRef.current.hotspotContainer()
        : null
  
    Object.keys(map).forEach(id => {
      const entry = map[id]
      try {
        if (entry?.hotspot && container) container.destroyHotspot(entry.hotspot)
        if (entry?.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
      } catch (e) { console.error("Failed to destroy hotspot safely", id, e) }
      deletedHotspotIdsRef?.current?.add?.(id)
      delete map[id]
    })
    hotspotElsRef.current = {}
  }

  // Apply a snapshot to current scene
  async applySnapshot(
    snapshot,
    currentHotspots,
    setHotspots,
    hotspotElsRef,
    currentSceneRef,
    deletedHotspotIdsRef
  ) {
    if (!snapshot || !Array.isArray(snapshot.hotspots)) {
      console.error("Invalid snapshot data")
      return
    }

    try {
      // Step 1: Identify what changed (diff-based approach)
      const currentMap = new Map(currentHotspots.map(h => [h.id, h]))
      const snapshotMap = new Map(snapshot.hotspots.map(h => [h.id, h]))
      
      const toAdd = []
      const toUpdate = []
      const toRemove = []
      
      // Find additions and updates
      for (const [id, snapH] of snapshotMap) {
        const currentH = currentMap.get(id)
        if (!currentH) {
          toAdd.push(snapH)
        } else if (this.hasHotspotChanged(currentH, snapH)) {
          toUpdate.push(snapH)
        }
      }
      
      // Find removals
      for (const [id, currentH] of currentMap) {
        if (!snapshotMap.has(id)) {
          toRemove.push(id)
        }
      }
      
      // Step 2: Apply minimal changes to DOM
      // Remove only deleted hotspots
      for (const id of toRemove) {
        const entry = hotspotElsRef.current[id]
        if (entry) {
          try {
            if (entry.hotspot && currentSceneRef?.current) {
              const container = currentSceneRef.current.hotspotContainer()
              if (container) container.destroyHotspot(entry.hotspot)
            }
            if (entry.el?.parentNode) entry.el.parentNode.removeChild(entry.el)
          } catch (e) {
            console.error("Failed to remove hotspot", id, e)
          }
          delete hotspotElsRef.current[id]
          deletedHotspotIdsRef?.current?.add(id)
        }
      }
      
      // Update existing hotspots in place
      for (const h of toUpdate) {
        const entry = hotspotElsRef.current[h.id]
        if (entry?.hotspot) {
          // Update position without recreating
          entry.hotspot.setPosition({ yaw: h.yaw, pitch: h.pitch })
          
          // Update rotation if it's a link hotspot
          if (h.kind !== 'product' && entry.el) {
            const rotDeg = h.rotationDeg || 0
            entry.el.style.setProperty("--rot", `${rotDeg}deg`)
            const iconWrapper = entry.el.querySelector('.LinkDotIconWrap')
            if (iconWrapper) {
              iconWrapper.style.setProperty("--rot", `${rotDeg}deg`)
            }
          }
        }
      }
      
      // Step 3: Update state with all changes at once
      const newHotspots = snapshot.hotspots.map(h => ({
        id: h.id,
        kind: (h.kind || "link") === "product" ? "product" : "link",
        sceneId: h.sceneId,
        yaw: h.yaw,
        pitch: h.pitch,
        rotationDeg: h.rotationDeg || 0,
        ...(h.linkedScenarioId ? { linkedScenarioId: h.linkedScenarioId } : {}),
        ...(h.productId ? { productId: h.productId } : {}),
        ...(Array.isArray(h.productIds) && h.productIds.length ? { productIds: [...h.productIds] } : {})
      }))
      
      setHotspots(newHotspots)
      
      // Step 4: Defer Firestore sync (don't block UI) with better product data handling
      this.deferredFirestoreSync(snapshot.hotspots)
      
    } catch (error) {
      console.error("Apply snapshot failed:", error)
      throw error
    }
  }
  
  hasHotspotChanged(h1, h2) {
    // Basic position and rotation changes
    if (h1.yaw !== h2.yaw || h1.pitch !== h2.pitch || h1.rotationDeg !== h2.rotationDeg) {
      return true
    }
    
    // Link hotspot changes
    if (h1.linkedScenarioId !== h2.linkedScenarioId) {
      return true
    }
    
    // Product hotspot changes - handle both single and multiple products
    if (h1.productId !== h2.productId) {
      return true
    }
    
    // Compare productIds arrays properly
    const ids1 = Array.isArray(h1.productIds) ? h1.productIds : []
    const ids2 = Array.isArray(h2.productIds) ? h2.productIds : []
    
    if (ids1.length !== ids2.length) {
      return true
    }
    
    // Check if arrays have same elements (order-independent)
    const set1 = new Set(ids1)
    const set2 = new Set(ids2)
    
    if (set1.size !== set2.size) {
      return true
    }
    
    for (const id of set1) {
      if (!set2.has(id)) {
        return true
      }
    }
    
    return false
  }
  
  // Add deferred sync method
  deferredFirestoreSync(hotspots) {
    // Use requestIdleCallback for non-blocking sync
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        this.syncHotspotsToFirestoreLightweight(hotspots)
      }, { timeout: 2000 })
    } else {
      setTimeout(() => {
        this.syncHotspotsToFirestoreLightweight(hotspots)
      }, 100)
    }
  }
  
  // Lightweight sync that only updates changed documents
  async syncHotspotsToFirestoreLightweight(hotspots) {
    try {
            // Use a write batch to perform atomic writes. When restoring hotspots
      // from history, some documents may no longer exist (e.g., after deletion),
      // so use set() with merge to create or update documents as needed.
      let batch = writeBatch(this.db)
      let batchSize = 0

      for (const h of hotspots) {
        const isProduct = (h.kind || "link") === "product"
        const docRef = doc(
          this.db,
          isProduct ? PRODUCT_HOTSPOT_COLLECTION : "hotspots",
          h.id
        )

        // Build data payload. Always include sceneId so a new document
        // associates to the correct scene. For products, also include productId/productIds.
        const baseData = {
          yaw: h.yaw,
          pitch: h.pitch,
          sceneId: h.sceneId,
          updatedAt: serverTimestamp()
        }
        let data
        if (isProduct) {
          data = {
            ...baseData,
            ...(h.productId ? { productId: h.productId } : {}),
            ...(Array.isArray(h.productIds) && h.productIds.length ? { productIds: h.productIds } : {})
          }
        } else {
          data = {
            ...baseData,
            rotationDeg: h.rotationDeg || 0,
            ...(h.linkedScenarioId ? { linkedScenarioId: h.linkedScenarioId } : {})
          }
        }
        // Use set with merge to avoid the "No document to update" error.
        batch.set(docRef, data, { merge: true })

        batchSize++ 
        if (batchSize >= 450) {
          await batch.commit()
          batchSize = 0
        }
      }

      if (batchSize > 0) {
        await batch.commit()
      }
    } catch (error) {
      console.error("Lightweight sync failed, falling back:", error)
    }
  }

  async syncHotspotsToFirestore(affectedScenes, hotspotsByScene) {
    try {
      let batch = writeBatch(this.db)
      let batchSize = 0
  
      for (const sceneId of affectedScenes) {
        // Delete existing hotspots for this scene
        const [linksSnap, prodsSnap] = await Promise.all([
          getDocs(query(collection(this.db, "hotspots"), where("sceneId", "==", sceneId))),
          getDocs(query(collection(this.db, PRODUCT_HOTSPOT_COLLECTION), where("sceneId", "==", sceneId)))
        ])
  
        // Add delete operations to batch
        linksSnap.docs.forEach(doc => {
          batch.delete(doc.ref)
          batchSize++
        })
        prodsSnap.docs.forEach(doc => {
          batch.delete(doc.ref)
          batchSize++
        })
        const sceneHotspots = hotspotsByScene.get(sceneId) || []
        for (const h of sceneHotspots) {
          const isProduct = (h.kind || "link") === "product"
          const docRef = doc(
            this.db,
            isProduct ? PRODUCT_HOTSPOT_COLLECTION : "hotspots",
            h.id
          )
  
          const data = {
            sceneId: h.sceneId,
            yaw: h.yaw,
            pitch: h.pitch,
            updatedAt: serverTimestamp(),
            ...(isProduct 
              ? {
                  ...(h.productId ? { productId: h.productId } : {}),
                  ...(Array.isArray(h.productIds) && h.productIds.length ? { productIds: h.productIds } : {})
                }
              : {
                  rotationDeg: h.rotationDeg || 0,
                  ...(h.linkedScenarioId ? { linkedScenarioId: h.linkedScenarioId } : {})
                }
            )
          }
  
          batch.set(docRef, data)
          batchSize++
  
          // Firebase has a 500 operation limit per batch
          if (batchSize >= 450) {
            await batch.commit()
            const newBatch = writeBatch(this.db)
            batch = newBatch
            batchSize = 0
          }
        }
      }
  
      // Commit remaining operations
      if (batchSize > 0) {
        await batch.commit()
      }
  
    } catch (error) {
      console.error("Firestore sync failed:", error)
      throw error
    }
  }

  // Clear all history
  clearHistory() {
    this.history = []
    this.currentIndex = -1
    this.notifyListeners()
  }

  // Initialize with current state
  async initialize(hotspots, sceneId) {
    if (this.history.length === 0) {
      await this.createSnapshot(hotspots, sceneId, 'initialize', 'Initial state')
      console.log('History initialized with', hotspots.length, 'hotspots for scene', sceneId)
      this.notifyListeners() // Ensure listeners are notified
    }
  }  
}