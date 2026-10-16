const EarlyAccess = require("../models/EarlyAccess");
const express = require("express");
const auth = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminAuth");
const router = express.Router();
const app = express.Router()
app.use(express.json())

app.use(express.urlencoded({ extended: true }));
router.post("/", async (req, res) => {
    try {
        console.log(req.body)
        console.log(req.headers);
        console.log(req.body);
        const earlyAccess = await EarlyAccess.create(req.body);
        res.status(201).json(earlyAccess);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get("/return", auth, requireAdmin, async (req, res) => {
    try {
        const earlyAccess = await EarlyAccess.find();
        res.json(earlyAccess);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;