/* pages/api/health.js */
/* Simple health check endpoint */

export default function handler(req, res) {
    res.setHeader("Content-Type","application/json")
    if (req.method !== "GET") return res.status(405).json({ error:"Method not allowed" })
    res.status(200).json({ status:"ok" })
  }