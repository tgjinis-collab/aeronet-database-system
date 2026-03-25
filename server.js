// =============================================================================
// AeroNetB Aerospace Supply Chain Management System
// server.js — Express REST API
//
// Stack:
//   Express 4        — HTTP server & routing
//   pg (node-postgres)— PostgreSQL client
//   mongodb          — MongoDB native driver
//   jsonwebtoken     — JWT auth
//   bcryptjs         — password hashing
//   express-validator— request validation
//   morgan           — HTTP logging
//   helmet           — security headers
//   cors             — cross-origin resource sharing
//
// Install:
//   npm install express pg mongodb jsonwebtoken bcryptjs
//               express-validator morgan helmet cors dotenv
//
// Environment variables (.env):
//   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
//   MONGO_URI, MONGO_DB_NAME
//   JWT_SECRET, JWT_EXPIRES_IN
//   PORT
// =============================================================================

require("dotenv").config();
const express    = require("express");
const { Pool }   = require("pg");
const { MongoClient, ObjectId } = require("mongodb");
const jwt        = require("jsonwebtoken");
const bcrypt     = require("bcryptjs");
const { body, param, query, validationResult } = require("express-validator");
const morgan     = require("morgan");
const helmet     = require("helmet");
const cors       = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// DATABASE CONNECTIONS
// =============================================================================

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pgPool = new Pool({
  host:     process.env.PG_HOST     || "localhost",
  port:     parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "aeronetb",
  user:     process.env.PG_USER     || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  max:      10,
  idleTimeoutMillis: 30000,
  ssl: process.env.PG_SSL === "false" ? false : { rejectUnauthorized: false },
});

pgPool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

// ── MongoDB ───────────────────────────────────────────────────────────────────
const mongoClient = new MongoClient(
  process.env.MONGO_URI || "mongodb://localhost:27017"
);
let mongoDB;

async function connectMongo() {
  await mongoClient.connect();
  mongoDB = mongoClient.db(process.env.MONGO_DB_NAME || "aeronetb_db");
  console.log("✓ MongoDB connected:", mongoDB.databaseName);
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(morgan("dev"));

// ── Validation error handler ──────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

// ── JWT authentication ────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    return res.status(401).json({ success: false, message: "No token provided." });

  try {
    const decoded = jwt.verify(
      header.split(" ")[1],
      process.env.JWT_SECRET || "changeme"
    );
    req.user = decoded; // { emp_id, email, roles: [...] }
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

// ── RBAC — check if user holds at least one of the required roles ─────────────
const authorize = (...roles) => (req, res, next) => {
  const userRoles = req.user?.roles || [];
  const allowed   = roles.some((r) => userRoles.includes(r));
  if (!allowed)
    return res.status(403).json({ success: false, message: "Access denied." });
  next();
};

// ── Audit logger — call inside route handlers after DB write ──────────────────
async function logAudit(empId, actionType, entityType, entityId, outcome = "SUCCESS", req = {}, detail = null) {
  try {
    await pgPool.query(
      `INSERT INTO audit_log
         (emp_id, action_type, entity_type, entity_id, outcome, ip_address, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [empId, actionType, entityType, String(entityId), outcome,
       req.ip || null, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    console.error("Audit log failed:", err.message);
  }
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get("/health", async (_req, res) => {
  try {
    await pgPool.query("SELECT 1");
    await mongoDB.command({ ping: 1 });
    res.json({ success: true, postgres: "ok", mongodb: "ok" });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
});

// =============================================================================
// DOMAIN 0 — AUTH
// POST   /api/auth/login
// POST   /api/auth/logout   (client-side; logs the event server-side)
// =============================================================================

app.post(
  "/api/auth/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const { rows } = await pgPool.query(
        `SELECT u.emp_id, u.full_name, u.email, u.password_hash, u.is_active,
                ARRAY_AGG(r.role_name) AS roles
           FROM "user" u
           LEFT JOIN user_role ur ON ur.emp_id = u.emp_id
           LEFT JOIN role       r  ON r.role_id = ur.role_id
          WHERE u.email = $1
          GROUP BY u.emp_id`,
        [email]
      );

      const user = rows[0];
      if (!user || !user.is_active)
        return res.status(401).json({ success: false, message: "Invalid credentials." });

      const valid = await bcrypt.compare(password, user.password_hash || "");
      if (!valid)
        return res.status(401).json({ success: false, message: "Invalid credentials." });

      const token = jwt.sign(
        { emp_id: user.emp_id, email: user.email, roles: user.roles.filter(Boolean) },
        process.env.JWT_SECRET || "changeme",
        { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
      );

      await logAudit(user.emp_id, "LOGIN", "USER", user.emp_id, "SUCCESS", req);
      res.json({ success: true, token, user: { emp_id: user.emp_id, full_name: user.full_name, email: user.email, roles: user.roles } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.post("/api/auth/logout", authenticate, async (req, res) => {
  await logAudit(req.user.emp_id, "LOGOUT", "USER", req.user.emp_id, "SUCCESS", req);
  res.json({ success: true, message: "Logged out." });
});

// =============================================================================
// DOMAIN 1 — SUPPLIERS
// GET    /api/suppliers
// GET    /api/suppliers/:id
// POST   /api/suppliers
// PUT    /api/suppliers/:id
// GET    /api/suppliers/:id/parts     — offerings by supplier
// =============================================================================

app.get("/api/suppliers", authenticate, async (req, res) => {
  try {
    const { accreditation, search, limit = 50, offset = 0 } = req.query;
    let sql    = `SELECT * FROM supplier WHERE 1=1`;
    const params = [];

    if (accreditation) {
      params.push(accreditation);
      sql += ` AND accreditation = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (business_name ILIKE $${params.length} OR contact_email ILIKE $${params.length})`;
    }
    sql += ` ORDER BY business_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));

    const { rows } = await pgPool.query(sql, params);
    await logAudit(req.user.emp_id, "VIEW", "SUPPLIER", "LIST", "SUCCESS", req);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/suppliers/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM supplier WHERE supplier_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Supplier not found." });
    await logAudit(req.user.emp_id, "VIEW", "SUPPLIER", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/suppliers",
  authenticate,
  authorize("PROCUREMENT_OFFICER"),
  [
    body("business_name").notEmpty().trim(),
    body("address").notEmpty().trim(),
    body("contact_email").isEmail().normalizeEmail(),
    body("accreditation").optional().isIn(["ISO9001","AS9100","NADCAP","FAA_APPROVED","EASA_APPROVED","PENDING","SUSPENDED"]),
  ],
  validate,
  async (req, res) => {
    const { business_name, address, contact_name, contact_email, contact_phone, accreditation } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO supplier (business_name, address, contact_name, contact_email, contact_phone, accreditation)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [business_name, address, contact_name || null, contact_email, contact_phone || null, accreditation || "PENDING"]
      );
      await logAudit(req.user.emp_id, "CREATE", "SUPPLIER", rows[0].supplier_id, "SUCCESS", req, { business_name });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.put(
  "/api/suppliers/:id",
  authenticate,
  authorize("PROCUREMENT_OFFICER"),
  [param("id").isUUID()],
  validate,
  async (req, res) => {
    const allowed = ["business_name","address","contact_name","contact_email","contact_phone","accreditation"];
    const fields  = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ success: false, message: "No valid fields to update." });

    const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [req.params.id, ...fields.map((f) => req.body[f])];
    try {
      const { rows } = await pgPool.query(
        `UPDATE supplier SET ${sets} WHERE supplier_id = $1 RETURNING *`, values
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "Supplier not found." });
      await logAudit(req.user.emp_id, "UPDATE", "SUPPLIER", req.params.id, "SUCCESS", req, req.body);
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/suppliers/:id/parts", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT spo.*, p.part_name, p.description
         FROM supplier_part_offering spo
         JOIN part p ON p.part_id = spo.part_id
        WHERE spo.supplier_id = $1 AND spo.is_active = true`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// DOMAIN 1 — PARTS
// GET    /api/parts
// GET    /api/parts/:id
// POST   /api/parts
// GET    /api/parts/:id/spec          — PostgreSQL scalar spec
// GET    /api/parts/:id/spec/full     — + MongoDB rich doc (CAD refs, notes)
// =============================================================================

app.get("/api/parts", authenticate, async (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    let sql = "SELECT * FROM part WHERE 1=1";
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (part_name ILIKE $1 OR description ILIKE $1)`;
    }
    sql += ` ORDER BY part_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/parts/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM part WHERE part_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Part not found." });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/parts",
  authenticate,
  authorize("PROCUREMENT_OFFICER"),
  [body("part_name").notEmpty().trim()],
  validate,
  async (req, res) => {
    const { part_name, description } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO part (part_name, description) VALUES ($1,$2) RETURNING *`,
        [part_name, description || null]
      );
      await logAudit(req.user.emp_id, "CREATE", "PART", rows[0].part_id, "SUCCESS", req);
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/parts/:id/spec", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM part_baseline_spec WHERE part_id = $1", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Spec not found." });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/parts/:id/spec/full", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM part_baseline_spec WHERE part_id = $1", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Spec not found." });

    const mongoDoc = await mongoDB
      .collection("manufacturing_specs")
      .findOne({ _pgPartRef: req.params.id });

    await logAudit(req.user.emp_id, "VIEW", "PART_SPEC", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: { relational: rows[0], document: mongoDoc || null } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// DOMAIN 2 — PURCHASE ORDERS
// GET    /api/orders
// GET    /api/orders/:id
// POST   /api/orders
// PATCH  /api/orders/:id/status
// GET    /api/orders/:id/lines
// =============================================================================

app.get("/api/orders", authenticate, async (req, res) => {
  try {
    const { status, supplier_id, from, to, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT po.*, s.business_name AS supplier_name
                 FROM purchase_order po
                 JOIN supplier s ON s.supplier_id = po.supplier_id
                WHERE 1=1`;
    const params = [];

    if (status)      { params.push(status);      sql += ` AND po.status = $${params.length}`; }
    if (supplier_id) { params.push(supplier_id); sql += ` AND po.supplier_id = $${params.length}`; }
    if (from)        { params.push(from);         sql += ` AND po.order_date >= $${params.length}`; }
    if (to)          { params.push(to);           sql += ` AND po.order_date <= $${params.length}`; }

    sql += ` ORDER BY po.order_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));

    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/orders/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT po.*, s.business_name AS supplier_name
         FROM purchase_order po
         JOIN supplier s ON s.supplier_id = po.supplier_id
        WHERE po.order_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Order not found." });
    await logAudit(req.user.emp_id, "VIEW", "PURCHASE_ORDER", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/orders",
  authenticate,
  authorize("PROCUREMENT_OFFICER"),
  [
    body("supplier_id").isUUID(),
    body("order_date").isISO8601().optional(),
    body("desired_delivery_date").isISO8601().optional(),
    body("lines").isArray({ min: 1 }),
    body("lines.*.supplier_part_id").isUUID(),
    body("lines.*.quantity").isInt({ min: 1 }),
    body("lines.*.unit_price_usd").isFloat({ min: 0 }).optional(),
  ],
  validate,
  async (req, res) => {
    const { supplier_id, order_date, desired_delivery_date, lines } = req.body;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      const { rows: [order] } = await client.query(
        `INSERT INTO purchase_order (supplier_id, order_date, desired_delivery_date, created_by_emp_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [supplier_id, order_date || new Date(), desired_delivery_date || null, req.user.emp_id]
      );

      const insertedLines = [];
      for (const line of lines) {
        const { rows: [ol] } = await client.query(
          `INSERT INTO purchase_order_line (order_id, supplier_part_id, quantity, unit_price_usd)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [order.order_id, line.supplier_part_id, line.quantity, line.unit_price_usd || null]
        );
        insertedLines.push(ol);
      }

      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "PURCHASE_ORDER", order.order_id, "SUCCESS", req, { supplier_id, lines: lines.length });
      res.status(201).json({ success: true, data: { order, lines: insertedLines } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  }
);

app.patch(
  "/api/orders/:id/status",
  authenticate,
  authorize("PROCUREMENT_OFFICER", "SUPPLY_CHAIN_MANAGER"),
  [
    param("id").isUUID(),
    body("status").isIn(["PLACED","CONFIRMED","DISPATCHED","DELIVERED","COMPLETED","CANCELLED"]),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `UPDATE purchase_order SET status = $2 WHERE order_id = $1 RETURNING *`,
        [req.params.id, req.body.status]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "Order not found." });
      await logAudit(req.user.emp_id, "UPDATE", "PURCHASE_ORDER", req.params.id, "SUCCESS", req, { status: req.body.status });
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/orders/:id/lines", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT pol.*, spo.customisation_summary, p.part_name
         FROM purchase_order_line pol
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
        WHERE pol.order_id = $1`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// DOMAIN 2 — SHIPMENTS
// GET    /api/shipments
// GET    /api/shipments/:id
// POST   /api/shipments
// GET    /api/shipments/:id/events    — MongoDB checkpoint/condition docs
// POST   /api/shipments/:id/events    — log new checkpoint to MongoDB
// GET    /api/shipments/:id/items     — delivered items
// =============================================================================

app.get("/api/shipments", authenticate, async (req, res) => {
  try {
    const { order_id, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT s.*, po.status AS order_status FROM shipment s JOIN purchase_order po ON po.order_id = s.order_id WHERE 1=1`;
    const params = [];
    if (order_id) { params.push(order_id); sql += ` AND s.order_id = $1`; }
    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/shipments/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT s.*, po.supplier_id FROM shipment s JOIN purchase_order po ON po.order_id = s.order_id WHERE s.shipment_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Shipment not found." });
    await logAudit(req.user.emp_id, "VIEW", "SHIPMENT", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/shipments",
  authenticate,
  authorize("PROCUREMENT_OFFICER", "SUPPLY_CHAIN_MANAGER"),
  [
    body("order_id").isUUID(),
    body("tracking_number").notEmpty().trim(),
  ],
  validate,
  async (req, res) => {
    const { order_id, tracking_number, port_of_entry, carrier_name } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO shipment (order_id, tracking_number, port_of_entry, carrier_name)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [order_id, tracking_number, port_of_entry || null, carrier_name || null]
      );
      await logAudit(req.user.emp_id, "CREATE", "SHIPMENT", rows[0].shipment_id, "SUCCESS", req, { tracking_number });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/shipments/:id/events", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const events = await mongoDB
      .collection("shipment_events")
      .find({ _pgShipmentRef: req.params.id })
      .sort({ timestamp: 1 })
      .toArray();
    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/shipments/:id/events",
  authenticate,
  authorize("SUPPLY_CHAIN_MANAGER", "PROCUREMENT_OFFICER"),
  [
    param("id").isUUID(),
    body("eventType").isIn(["CHECKPOINT", "CONDITION_UPDATE"]),
    body("location").notEmpty(),
    body("containerCondition").optional().isObject(),
  ],
  validate,
  async (req, res) => {
    try {
      const doc = {
        _pgShipmentRef: req.params.id,
        trackingNumber: req.body.trackingNumber || null,
        eventType:      req.body.eventType,
        timestamp:      new Date(),
        location:       req.body.location,
        containerCondition: req.body.containerCondition || {},
        notes:          req.body.notes || null,
        loggedBy:       req.user.emp_id,
      };
      const result = await mongoDB.collection("shipment_events").insertOne(doc);
      await logAudit(req.user.emp_id, "CREATE", "SHIPMENT_EVENT", req.params.id, "SUCCESS", req, { eventType: doc.eventType });
      res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/shipments/:id/items", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT di.*, pol.quantity, p.part_name
         FROM delivered_item di
         JOIN purchase_order_line pol ON pol.order_line_id = di.order_line_id
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
        WHERE di.shipment_id = $1`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// DOMAIN 3 — QC REPORTS
// GET    /api/qc-reports
// GET    /api/qc-reports/:id          — PG header + MongoDB full payload
// POST   /api/qc-reports              — creates PG header + MongoDB document
// PATCH  /api/qc-reports/:id/status   — submit / approve / reject
// POST   /api/qc-reports/:id/versions — add a new version to the Mongo doc
// =============================================================================

app.get("/api/qc-reports", authenticate, async (req, res) => {
  try {
    const { status, delivered_item_id, report_type, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT qr.*, di.serial_number, di.batch_number
                 FROM qc_report qr
                 JOIN delivered_item di ON di.delivered_item_id = qr.delivered_item_id
                WHERE 1=1`;
    const params = [];
    if (status)            { params.push(status);            sql += ` AND qr.current_status = $${params.length}`; }
    if (delivered_item_id) { params.push(delivered_item_id); sql += ` AND qr.delivered_item_id = $${params.length}`; }
    if (report_type)       { params.push(report_type);       sql += ` AND qr.report_type = $${params.length}`; }
    sql += ` ORDER BY qr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/qc-reports/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM qc_report WHERE qc_report_id = $1", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "QC report not found." });

    const mongoDoc = rows[0].mongo_doc_ref
      ? await mongoDB.collection("qc_reports").findOne({ _pgRef: req.params.id })
      : null;

    await logAudit(req.user.emp_id, "VIEW", "QC_REPORT", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: { header: rows[0], document: mongoDoc } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/qc-reports",
  authenticate,
  authorize("QUALITY_INSPECTOR"),
  [
    body("delivered_item_id").isUUID(),
    body("report_type").isIn(["VISUAL_INSPECTION","DIMENSIONAL_CHECK","NON_DESTRUCTIVE_TESTING","ENVIRONMENTAL_STRESS"]),
    body("results").notEmpty(),
    body("inspectionDate").isISO8601(),
  ],
  validate,
  async (req, res) => {
    const { delivered_item_id, report_type, results, inspectionDate, notes } = req.body;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      // 1. Create PostgreSQL header row (DRAFT)
      const { rows: [header] } = await client.query(
        `INSERT INTO qc_report (delivered_item_id, report_type, current_status)
         VALUES ($1,$2,'DRAFT') RETURNING *`,
        [delivered_item_id, report_type]
      );

      // 2. Create MongoDB document
      const mongoDoc = {
        _pgRef:          header.qc_report_id,
        deliveredItemId: delivered_item_id,
        report_type,
        current_status:  "DRAFT",
        inspector: {
          _pgEmpId:    req.user.emp_id,
          employeeId:  req.user.emp_id,
        },
        inspectionDate,
        createdAt:  new Date(),
        updatedAt:  new Date(),
        results,
        notes:      notes || null,
        versions: [{
          versionNo:  1,
          createdAt:  new Date(),
          createdBy:  { _pgEmpId: req.user.emp_id },
          status:     "DRAFT",
          summary:    "Initial draft created.",
          resultSnapshot: results,
        }],
      };
      await mongoDB.collection("qc_reports").insertOne(mongoDoc);

      // 3. Update PG header with mongo ref
      await client.query(
        "UPDATE qc_report SET mongo_doc_ref = $1 WHERE qc_report_id = $2",
        [`mongo:qc_reports:${header.qc_report_id}`, header.qc_report_id]
      );

      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "QC_REPORT", header.qc_report_id, "SUCCESS", req, { report_type });
      res.status(201).json({ success: true, data: { header, document: mongoDoc } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  }
);

app.patch(
  "/api/qc-reports/:id/status",
  authenticate,
  authorize("QUALITY_INSPECTOR"),
  [
    param("id").isUUID(),
    body("status").isIn(["SUBMITTED","APPROVED","REJECTED"]),
    body("summary").notEmpty().trim(),
  ],
  validate,
  async (req, res) => {
    const { status, summary, resultSnapshot } = req.body;
    try {
      const { rows } = await pgPool.query(
        `UPDATE qc_report SET current_status = $2 WHERE qc_report_id = $1 RETURNING *`,
        [req.params.id, status]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "QC report not found." });

      // Push new version into MongoDB array
      await mongoDB.collection("qc_reports").updateOne(
        { _pgRef: req.params.id },
        {
          $set:  { current_status: status, updatedAt: new Date() },
          $push: {
            versions: {
              versionNo:      Date.now(),
              createdAt:      new Date(),
              createdBy:      { _pgEmpId: req.user.emp_id },
              status,
              summary,
              resultSnapshot: resultSnapshot || {},
            },
          },
        }
      );

      await logAudit(req.user.emp_id, "UPDATE", "QC_REPORT", req.params.id, "SUCCESS", req, { status });
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// =============================================================================
// DOMAIN 3 — CERTIFICATIONS
// GET    /api/certifications/:id      — PG header + MongoDB full doc
// POST   /api/certifications          — create (Quality Inspector)
// POST   /api/certifications/:id/approve  — approve + lock immutability
// =============================================================================

app.get("/api/certifications/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM certification WHERE certification_id = $1", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Certification not found." });

    const mongoDoc = await mongoDB
      .collection("certification_documents")
      .findOne({ _pgRef: req.params.id });

    await logAudit(req.user.emp_id, "VIEW", "CERTIFICATION", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: { header: rows[0], document: mongoDoc } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/certifications",
  authenticate,
  authorize("QUALITY_INSPECTOR"),
  [
    body("delivered_item_id").isUUID(),
    body("testResults").isArray({ min: 1 }),
    body("materialTraceability").isArray().optional(),
  ],
  validate,
  async (req, res) => {
    const { delivered_item_id, testResults, materialTraceability } = req.body;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      const { rows: [cert] } = await client.query(
        `INSERT INTO certification (delivered_item_id, is_immutable) VALUES ($1, false) RETURNING *`,
        [delivered_item_id]
      );

      const mongoDoc = {
        certificationId:   cert.certification_id,
        _pgRef:            cert.certification_id,
        deliveredItemId:   delivered_item_id,
        certificationDate: new Date(),
        createdAt:         new Date(),
        inspector:         { _pgEmpId: req.user.emp_id },
        testResults,
        materialTraceability: materialTraceability || [],
        approval:          null,
        is_immutable:      false,
      };
      await mongoDB.collection("certification_documents").insertOne(mongoDoc);

      await client.query(
        "UPDATE certification SET mongo_doc_ref = $1 WHERE certification_id = $2",
        [`mongo:certification_documents:${cert.certification_id}`, cert.certification_id]
      );

      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "CERTIFICATION", cert.certification_id, "SUCCESS", req);
      res.status(201).json({ success: true, data: { header: cert, document: mongoDoc } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  }
);

app.post(
  "/api/certifications/:id/approve",
  authenticate,
  authorize("QUALITY_INSPECTOR"),
  [
    param("id").isUUID(),
    body("digitalStamp").notEmpty().trim(),
    body("signatureRef").optional().isString(),
  ],
  validate,
  async (req, res) => {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      // Lock in PostgreSQL — trigger will block future updates
      const { rows } = await client.query(
        `UPDATE certification
            SET is_immutable = true,
                approved_at  = NOW(),
                approved_by_emp_id = $2
          WHERE certification_id = $1
            AND is_immutable = false
         RETURNING *`,
        [req.params.id, req.user.emp_id]
      );

      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Certification not found or already immutable.",
        });
      }

      // Lock in MongoDB
      await mongoDB.collection("certification_documents").updateOne(
        { _pgRef: req.params.id },
        {
          $set: {
            is_immutable: true,
            "approval.approvedAt":    new Date(),
            "approval._pgEmpId":      req.user.emp_id,
            "approval.digitalStamp":  req.body.digitalStamp,
            "approval.signatureRef":  req.body.signatureRef || null,
            "approval.signatureMethod": "AeroNetB SecureSign v3",
          },
        }
      );

      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "APPROVE", "CERTIFICATION", req.params.id, "SUCCESS", req, { is_immutable_set: true });
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      // Immutability trigger raises an exception — surface it as 403
      if (err.message.includes("immutable"))
        return res.status(403).json({ success: false, message: err.message });
      res.status(500).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  }
);

// =============================================================================
// DOMAIN 4 — EQUIPMENT & IoT
// GET    /api/equipment
// GET    /api/equipment/:id
// POST   /api/equipment
// GET    /api/equipment/:id/readings  — MongoDB sensor_readings (time-ranged)
// GET    /api/equipment/:id/devices   — IoT devices attached to equipment
// POST   /api/sensor-readings         — ingest a new IoT reading
// =============================================================================

app.get("/api/equipment", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM equipment WHERE is_active = true ORDER BY equipment_name"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/equipment/:id", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT * FROM equipment WHERE equipment_id = $1", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Equipment not found." });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/equipment",
  authenticate,
  authorize("EQUIPMENT_ENGINEER"),
  [
    body("equipment_name").notEmpty().trim(),
    body("equipment_type").notEmpty().trim(),
  ],
  validate,
  async (req, res) => {
    const { equipment_name, facility_plant, equipment_type, manufacturer, model_number, install_date } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO equipment (equipment_name, facility_plant, equipment_type, manufacturer, model_number, install_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [equipment_name, facility_plant || null, equipment_type, manufacturer || null, model_number || null, install_date || null]
      );
      await logAudit(req.user.emp_id, "CREATE", "EQUIPMENT", rows[0].equipment_id, "SUCCESS", req);
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/equipment/:id/readings", authenticate,
  authorize("EQUIPMENT_ENGINEER", "SUPPLY_CHAIN_MANAGER"),
  [param("id").isUUID()], validate,
  async (req, res) => {
    try {
      const { from, to, anomaly_only, limit = 100 } = req.query;
      const filter = { assignedToId: req.params.id };
      if (from || to) {
        filter.timestamp = {};
        if (from) filter.timestamp.$gte = new Date(from);
        if (to)   filter.timestamp.$lte = new Date(to);
      }
      if (anomaly_only === "true") filter.anomaly = true;

      const readings = await mongoDB
        .collection("sensor_readings")
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(Number(limit))
        .toArray();

      res.json({ success: true, count: readings.length, data: readings });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/equipment/:id/devices", authenticate, [param("id").isUUID()], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM iot_device WHERE assigned_to_type = 'EQUIPMENT' AND assigned_to_id = $1`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post(
  "/api/sensor-readings",
  authenticate,
  authorize("EQUIPMENT_ENGINEER"),
  [
    body("deviceId").isUUID(),
    body("assignedToId").isUUID(),
    body("assignedToType").isIn(["EQUIPMENT","SHIPMENT","CONTAINER"]),
    body("temperature_c").isFloat().optional(),
    body("vibration_mm_s").isFloat().optional(),
    body("rawReadings").optional().isObject(),
  ],
  validate,
  async (req, res) => {
    try {
      const doc = {
        ...req.body,
        timestamp: new Date(),
        anomaly:   req.body.anomaly || false,
      };
      const result = await mongoDB.collection("sensor_readings").insertOne(doc);
      res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// =============================================================================
// DOMAIN 5 — USERS
// GET    /api/users            (SUPPLY_CHAIN_MANAGER, AUDITOR)
// GET    /api/users/:id
// GET    /api/users/me         — current user from token
// POST   /api/users            (admin: not role-locked for brevity)
// =============================================================================

app.get("/api/users/me", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT u.emp_id, u.full_name, u.email, u.job_title, u.department,
              ARRAY_AGG(r.role_name) AS roles
         FROM "user" u
         LEFT JOIN user_role ur ON ur.emp_id = u.emp_id
         LEFT JOIN role       r  ON r.role_id  = ur.role_id
        WHERE u.emp_id = $1
        GROUP BY u.emp_id`,
      [req.user.emp_id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/users", authenticate,
  authorize("SUPPLY_CHAIN_MANAGER", "AUDITOR"),
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT u.emp_id, u.full_name, u.email, u.job_title, u.department, u.is_active,
                ARRAY_AGG(r.role_name) AS roles
           FROM "user" u
           LEFT JOIN user_role ur ON ur.emp_id  = u.emp_id
           LEFT JOIN role       r  ON r.role_id  = ur.role_id
          GROUP BY u.emp_id
          ORDER BY u.full_name`
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.post(
  "/api/users",
  authenticate,
  [
    body("full_name").notEmpty().trim(),
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("role").isIn(["PROCUREMENT_OFFICER","QUALITY_INSPECTOR","SUPPLY_CHAIN_MANAGER","EQUIPMENT_ENGINEER","AUDITOR"]),
  ],
  validate,
  async (req, res) => {
    const { full_name, email, password, job_title, department, phone, role } = req.body;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const hash = await bcrypt.hash(password, 12);

      const { rows: [user] } = await client.query(
        `INSERT INTO "user" (full_name, email, password_hash, job_title, department, phone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING emp_id, full_name, email, job_title, department`,
        [full_name, email, hash, job_title || null, department || null, phone || null]
      );

      await client.query(
        `INSERT INTO user_role (emp_id, role_id)
         SELECT $1, role_id FROM role WHERE role_name = $2`,
        [user.emp_id, role]
      );

      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "USER", user.emp_id, "SUCCESS", req, { role });
      res.status(201).json({ success: true, data: { ...user, role } });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "23505")
        return res.status(409).json({ success: false, message: "Email already exists." });
      res.status(500).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  }
);

// =============================================================================
// DOMAIN 5 — AUDIT LOG
// GET    /api/audit-logs       — AUDITOR only, filterable
// =============================================================================

app.get(
  "/api/audit-logs",
  authenticate,
  authorize("AUDITOR", "SUPPLY_CHAIN_MANAGER"),
  async (req, res) => {
    try {
      const { emp_id, entity_type, entity_id, action_type, from, to, limit = 100, offset = 0 } = req.query;
      let sql = `SELECT al.*, u.full_name, u.email
                   FROM audit_log al
                   LEFT JOIN "user" u ON u.emp_id = al.emp_id
                  WHERE 1=1`;
      const params = [];
      if (emp_id)      { params.push(emp_id);      sql += ` AND al.emp_id = $${params.length}`; }
      if (entity_type) { params.push(entity_type); sql += ` AND al.entity_type = $${params.length}`; }
      if (entity_id)   { params.push(entity_id);   sql += ` AND al.entity_id = $${params.length}`; }
      if (action_type) { params.push(action_type); sql += ` AND al.action_type = $${params.length}`; }
      if (from)        { params.push(from);         sql += ` AND al.created_at >= $${params.length}`; }
      if (to)          { params.push(to);           sql += ` AND al.created_at <= $${params.length}`; }
      sql += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(Number(limit), Number(offset));

      const { rows } = await pgPool.query(sql, params);
      await logAudit(req.user.emp_id, "VIEW", "AUDIT_LOGS", "LIST", "SUCCESS", req);
      res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// =============================================================================
// DASHBOARD AGGREGATIONS
// GET    /api/dashboard/summary            — counts overview for all roles
// GET    /api/dashboard/supplier-kpis      — delivery rate, QC pass rate per supplier
// GET    /api/dashboard/shipment-status    — active shipments + last event
// GET    /api/dashboard/qc-insights        — QC status breakdown + recent anomalies
// GET    /api/dashboard/iot-anomalies      — recent anomaly readings from MongoDB
// =============================================================================

app.get("/api/dashboard/summary", authenticate, async (req, res) => {
  try {
    const [sup, parts, orders, ships, certs, qc] = await Promise.all([
      pgPool.query("SELECT COUNT(*) FROM supplier"),
      pgPool.query("SELECT COUNT(*) FROM part"),
      pgPool.query("SELECT COUNT(*) FROM purchase_order WHERE status NOT IN ('COMPLETED','CANCELLED')"),
      pgPool.query("SELECT COUNT(*) FROM shipment WHERE arrived_at IS NULL"),
      pgPool.query("SELECT COUNT(*) FROM certification WHERE is_immutable = true"),
      pgPool.query("SELECT current_status, COUNT(*) FROM qc_report GROUP BY current_status"),
    ]);
    res.json({
      success: true,
      data: {
        active_suppliers:    parseInt(sup.rows[0].count),
        total_parts:         parseInt(parts.rows[0].count),
        open_orders:         parseInt(orders.rows[0].count),
        in_transit_shipments:parseInt(ships.rows[0].count),
        approved_certs:      parseInt(certs.rows[0].count),
        qc_by_status:        Object.fromEntries(qc.rows.map((r) => [r.current_status, parseInt(r.count)])),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/dashboard/supplier-kpis", authenticate,
  authorize("SUPPLY_CHAIN_MANAGER", "PROCUREMENT_OFFICER", "AUDITOR"),
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT s.supplier_id, s.business_name, s.accreditation,
                COUNT(po.order_id)                                         AS total_orders,
                COUNT(po.order_id) FILTER (WHERE po.status = 'COMPLETED') AS completed_orders,
                ROUND(AVG(po.actual_delivery_date - po.desired_delivery_date)) AS avg_delay_days,
                COUNT(qr.qc_report_id)                                     AS total_qc_reports,
                COUNT(qr.qc_report_id) FILTER (WHERE qr.current_status = 'APPROVED') AS approved_qc
           FROM supplier s
           LEFT JOIN purchase_order po     ON po.supplier_id = s.supplier_id
           LEFT JOIN purchase_order_line pol ON pol.order_id = po.order_id
           LEFT JOIN delivered_item di    ON di.order_line_id = pol.order_line_id
           LEFT JOIN qc_report qr         ON qr.delivered_item_id = di.delivered_item_id
          GROUP BY s.supplier_id
          ORDER BY total_orders DESC`
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/dashboard/shipment-status", authenticate,
  authorize("SUPPLY_CHAIN_MANAGER", "PROCUREMENT_OFFICER"),
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT sh.shipment_id, sh.tracking_number, sh.carrier_name, sh.port_of_entry,
                sh.dispatched_at, po.status AS order_status, s.business_name AS supplier_name
           FROM shipment sh
           JOIN purchase_order po ON po.order_id = sh.order_id
           JOIN supplier s ON s.supplier_id = po.supplier_id
          WHERE sh.arrived_at IS NULL
          ORDER BY sh.dispatched_at ASC`
      );

      // Enrich with latest MongoDB event per shipment
      const enriched = await Promise.all(
        rows.map(async (ship) => {
          const lastEvent = await mongoDB
            .collection("shipment_events")
            .findOne(
              { _pgShipmentRef: ship.shipment_id },
              { sort: { timestamp: -1 } }
            );
          return { ...ship, last_event: lastEvent || null };
        })
      );
      res.json({ success: true, data: enriched });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

app.get("/api/dashboard/qc-insights", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT qr.report_type, qr.current_status, COUNT(*) AS count,
              MAX(qr.created_at) AS latest
         FROM qc_report qr
        GROUP BY qr.report_type, qr.current_status
        ORDER BY qr.report_type`
    );
    const recentDrafts = await pgPool.query(
      `SELECT qr.*, di.serial_number
         FROM qc_report qr
         JOIN delivered_item di ON di.delivered_item_id = qr.delivered_item_id
        WHERE qr.current_status = 'DRAFT'
        ORDER BY qr.created_at DESC LIMIT 5`
    );
    res.json({ success: true, data: { breakdown: rows, pending_drafts: recentDrafts.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/dashboard/iot-anomalies", authenticate,
  authorize("EQUIPMENT_ENGINEER", "SUPPLY_CHAIN_MANAGER"),
  async (req, res) => {
    try {
      const anomalies = await mongoDB
        .collection("sensor_readings")
        .find({ anomaly: true })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();
      res.json({ success: true, count: anomalies.length, data: anomalies });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error." });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

// =============================================================================
// START
// =============================================================================

(async () => {
  try {
    await connectMongo();
    await pgPool.query("SELECT 1"); // verify PG
    console.log("✓ PostgreSQL connected");
    app.listen(PORT, () => console.log(`✓ AeroNetB API running on port ${PORT}`));
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
})();

module.exports = app;
