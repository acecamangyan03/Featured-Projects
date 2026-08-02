/* src/pages/api/Chat/trackOrder.js */
/* Track by OrderID for guests, or latest-by-user with index fallback */

import { adminApp } from "../_lib/adminApp"
import { requireUser } from "../_lib/requireAdmin"

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const { orderId = null } = req.body || {}
    const admin = adminApp()
    const db = admin.firestore()

    // 1) Guest path by explicit OrderID (unchanged)
    if (orderId && typeof orderId === "string" && orderId.trim()) {
      const snap = await db.collection("orders")
        .where("orderID", "==", orderId.trim())
        .limit(1)
        .get()

      if (snap.empty) return res.json({ found: false, message: "No order found for that ID." })
      const d = snap.docs[0]?.data() || null
      if (!d) return res.json({ found: false, message: "No order found for that ID." })
      return res.json(formatOrderResponse(d))
    }

    // 2) Signed-in path, latest order for user (supports userId or uid)
    const user = await requireUser(req, res)
    if (!user) return

    const userField = "userId" // default field name in your data
    const altUserField = "uid" // some older docs use uid

    try {
      // Preferred: composite index userId asc, orderDate desc
      const snap = await db.collection("orders")
        .where(userField, "==", user.uid)
        .orderBy("orderDate", "desc")
        .limit(1)
        .get()

      if (!snap.empty) {
        const d = snap.docs[0]?.data() || null
        if (d) return res.json(formatOrderResponse(d))
      }
    } catch (err) {
      // ignore, we will fall back below
    }

    // Fallback A: same field, but no index
    const snap2 = await db.collection("orders")
      .where(userField, "==", user.uid)
      .limit(50)
      .get()

    // Fallback B: try alt field if nothing came back
    const pool = []
    if (!snap2.empty) pool.push(...snap2.docs.map(doc => doc.data()))
    if (pool.length === 0) {
      const snap3 = await db.collection("orders")
        .where(altUserField, "==", user.uid)
        .limit(50)
        .get()
      if (!snap3.empty) pool.push(...snap3.docs.map(doc => doc.data()))
    }

    if (pool.length === 0) return res.json({ found: false, message: "No order found." })

    // Pick latest by orderDate regardless of type
    const latest = pool.sort((a, b) => ts(b.orderDate) - ts(a.orderDate))[0]
    return res.json(formatOrderResponse(latest))
  } catch (e) {
    console.error("trackOrder failed", e)
    return res.status(500).json({ error: e.message || "Server error" })
  }
}

// Normalize orderDate for robust sorting
function ts(v) {
  if (!v) return 0
  if (typeof v?.toMillis === "function") return v.toMillis()
  const n = Number(new Date(v))
  return Number.isFinite(n) ? n : 0
}

function formatOrderResponse(d) {
  if (!d) return { found: false, message: "No order found." }
  const items = Array.isArray(d.customerOrder) ? d.customerOrder : []
  return {
    found: true,
    orderID: d.orderID || null,
    status: d.orderStatus || "Processing",
    placedAt: d.orderDate || null,
    trackingNumber: d.trackingNumber || null,
    totalAmount: toNum(d.totalAmount),
    totalItems: items.reduce((n, it) => n + Number(it?.quantity || 0), 0),
    items
  }
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
