const jwt = require("jsonwebtoken");
const Provider = require("../models/Provider");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret123";

module.exports = async function labProviderAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "Provider authentication required" });

    const payload = jwt.verify(token, JWT_SECRET);
    const providerId = payload?.sub || payload?.id;
    const provider = providerId ? await Provider.findById(providerId) : null;
    if (!provider || provider.providerType !== "lab") {
      return res.status(403).json({ error: "Lab provider access required" });
    }

    req.labProvider = provider;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired provider token" });
  }
};