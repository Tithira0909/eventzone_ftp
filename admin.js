const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/* ----------------- helpers ----------------- */
function isVip(tableId) {
  const letter = String(tableId || "").trim().charAt(0).toUpperCase();
  return ["A", "B", "C", "D", "E"].includes(letter);
}
function rand(n = 7) {
  return Math.random().toString(36).slice(2, 2 + n).toUpperCase();
}

/* =========================================================================
   LIST ORDERS
   ========================================================================= */
router.get("/orders", async (_req, res) => {
  const conn = await pool.getConnection();
  try {
    const [orderCols] = await conn.query("SHOW COLUMNS FROM orders");
    const has = (name) => orderCols.some((c) => c.Field === name);

    const idStrCol =
      (has("order_ref") && "o.order_ref") ||
      (has("order_id") && "o.order_id") ||
      "NULL";

    const amountCol =
      (has("amount") && "o.amount") ||
      (has("net_amount") && "o.net_amount") ||
      (has("gross_amount") && "o.gross_amount") ||
      "0";

    const currencyCol = has("currency") ? "o.currency" : "'LKR'";
    const statusCol = has("status") ? "o.status" : "'created'";
    const descCol = has("description") ? "o.description" : "''";
    const createdAtCol = has("created_at") ? "o.created_at" : "NOW()";
    const checkedAtCol = has("checked_in_at") ? "o.checked_in_at" : "NULL";

    // expose both columns if they exist
    const exposeOrderRef = has("order_ref") ? "o.order_ref" : "NULL";
    const exposeOrderId  = has("order_id")  ? "o.order_id"  : "NULL";

    const custSelect =
      "TRIM(CONCAT(IFNULL(o.customer_first_name,''),' ',IFNULL(o.customer_last_name,''))) AS customer_name, " +
      (has("customer_email") ? "o.customer_email" : "NULL") + " AS customer_email, " +
      (has("customer_phone") ? "o.customer_phone" : "NULL") + " AS customer_phone";

    const sqlOrders = `
      SELECT
        o.id,
        ${exposeOrderRef} AS order_ref,
        ${exposeOrderId}  AS order_id,
        ${idStrCol}       AS id_for_view,
        ${amountCol}      AS amount,
        ${currencyCol}    AS currency,
        ${statusCol}      AS status,
        ${descCol}        AS description,
        ${createdAtCol}   AS ts,
        ${checkedAtCol}   AS checked_in_at,
        ${has("checked_in") ? "o.checked_in" : "NULL"} AS checked_in_raw,
        ${custSelect}
      FROM orders o
      ORDER BY o.id DESC
    `;

    const [orders] = await conn.query(sqlOrders);

    // Items are optional
    const [[hasItemsTable]] = await conn.query("SHOW TABLES LIKE 'order_items'");
    let items = [];
    if (hasItemsTable) {
      const [itemCols] = await conn.query("SHOW COLUMNS FROM order_items");
      const ih = (n) => itemCols.some((c) => c.Field === n);

      const priceExpr = ih("price_cents")
        ? "oi.price_cents/100"
        : ih("price")
        ? "oi.price"
        : "0";
      const tableExpr = ih("table_id") ? "oi.table_id" : "NULL";
      const seatExpr = ih("seat_no")
        ? "oi.seat_no"
        : ih("seat")
        ? "oi.seat"
        : "NULL";
      const catExpr = ih("category")
        ? "oi.category"
        : ih("table_id")
        ? "CASE WHEN UPPER(LEFT(oi.table_id,1)) IN ('A','B','C','D','E') THEN 'vip' ELSE 'general' END"
        : "'general'";

      const [rows] = await conn.query(
        `SELECT oi.order_id,
                ${tableExpr} AS table_id,
                ${seatExpr}  AS seat_no,
                ${catExpr}   AS category,
                ${priceExpr} AS price
         FROM order_items oi`
      );
      items = rows;
    }

    // Build response
    const byOrderPk = new Map();
    for (const o of orders) {
      // derive "Checked-in" for UI:
      // - ENUM/TINYINT checked_in
      // - OR presence of checked_in_at
      const checkedFlag =
        (typeof o.checked_in_raw === "string" && o.checked_in_raw.toLowerCase() === "done") ||
        (typeof o.checked_in_raw === "number" && o.checked_in_raw === 1) ||
        !!o.checked_in_at;

      byOrderPk.set(o.id, {
        order_ref: o.order_ref || null,
        orderId: o.order_id || null,
        amount: Number(o.amount || 0),
        currency: o.currency || "LKR",
        description: o.description || "",
        ts: o.ts,
        checkedInAt: o.checked_in_at || null,
        status: checkedFlag ? "Checked-in" : "pending",
        items: [],
      });
    }

    for (const it of items) {
      const row = byOrderPk.get(it.order_id);
      if (row) {
        row.items.push({
          id: `${it.table_id}-${it.seat_no}`,
          tableId: it.table_id,
          seatNo: it.seat_no,
          category: it.category,
          price: Number(it.price || 0),
        });
      }
    }

    res.json({ ok: true, orders: Array.from(byOrderPk.values()) });
  } catch (e) {
    console.error("[ADMIN][orders] Error:", e);
    res.status(500).json({
      ok: false,
      error: "ORDERS_FETCH_FAILED",
      sqlMessage: e?.sqlMessage,
    });
  } finally {
    conn.release();
  }
});

/* =========================================================================
   CHECK-IN
   ========================================================================= */
router.post("/checkin", async (req, res) => {
  // Accept either field name from the frontend
  const { order_ref, orderId } = req.body || {};
  const idValue = String(order_ref || orderId || "").trim();
  if (!idValue) return res.status(400).json({ ok: false, error: "NO_ORDER_ID" });

  const conn = await pool.getConnection();
  try {
    const [orderCols] = await conn.query("SHOW COLUMNS FROM orders");
    const has = (n) => orderCols.some((c) => c.Field === n);

    // Which identifier do we have in DB?
    const idCol = has("order_ref") ? "order_ref" : (has("order_id") ? "order_id" : null);
    if (!idCol) {
      return res.status(400).json({ ok: false, error: "NO_ORDER_ID_COLUMN" });
    }

    // What can we update?
    const setParts = [];
    const params = [];

    // Prefer the dedicated check-in flag if present
    if (has("checked_in")) {
      // figure out column type (ENUM vs TINYINT)
      const col = orderCols.find(c => c.Field === "checked_in");
      if (col && /^enum/i.test(col.Type)) {
        // ENUM('pending','done',...)
        setParts.push(`checked_in = 'done'`);
      } else {
        // TINYINT(1)
        setParts.push(`checked_in = 1`);
      }
    }

    if (has("checked_in_at")) {
      setParts.push(`checked_in_at = NOW()`);
    }

    // If there's no explicit check-in column, we *optionally* fall back to status
    if (setParts.length === 0 && has("status")) {
      // Only set if 'checked_in' is allowed in ENUM
      const col = orderCols.find(c => c.Field === "status");
      const enumValues = (col?.Type || "").match(/\((.*)\)/)?.[1] || "";
      const clean = enumValues.replace(/'/g, "");
      if (clean.split(",").map(s => s.trim().toLowerCase()).includes("checked_in")) {
        setParts.push(`status = 'checked_in'`);
      }
    }

    if (has("updated_at")) {
      setParts.push(`updated_at = NOW()`);
    }

    if (setParts.length === 0) {
      // nothing safe to set
      return res.status(400).json({ ok: false, error: "NO_CHECKIN_COLUMNS" });
    }

    const sql = `UPDATE orders SET ${setParts.join(", ")} WHERE ${idCol} = ?`;
    params.push(idValue);

    const [r] = await conn.query(sql, params);
    res.json({ ok: true, updated: r.affectedRows });
  } catch (e) {
    console.error("[ADMIN][checkin] Error:", e);
    res.status(500).json({
      ok: false,
      error: "CHECKIN_FAILED",
      sqlMessage: e?.sqlMessage,
    });
  } finally {
    conn.release();
  }
});

/* =========================================================================
   CREATE Ticket-Book / PickMe orders (unchanged except for robustness)
   ========================================================================= */
router.post("/ticket-book", async (req, res) => {
  const { tableId, seats, orderId: customOrderId, source = "ticket_book" } = req.body || {};

  const tId = String(tableId || "").trim();
  const seatList = Array.isArray(seats)
    ? seats.map(Number).filter((n) => n >= 1 && n <= 10)
    : [];
  if (!tId || seatList.length === 0) {
    return res.status(400).json({ ok: false, error: "BAD_ITEM" });
  }

  const category = isVip(tId) ? "vip" : "general";
  const unit = category === "vip" ? 7500 : 5000;
  const items = seatList.map((n) => ({
    tableId: tId,
    seatNo: n,
    category,
    price: unit,
  }));
  const amount = items.reduce((s, it) => s + (it.price || 0), 0);

  const src = String(source).toLowerCase() === "pickme" ? "pickme" : "ticketbook";
  const statusLabel = src; // lowercase token you accept in your status enum
  const descLabel = src === "pickme" ? "PickMe" : "Ticket Book";
  const payMethod = src === "pickme" ? "PICKME" : "TICKET_BOOK";
  const idPrefix = src === "pickme" ? "PME" : "TBK";

  const outOrderId = customOrderId || `${idPrefix}-${tId}-${rand(4)}`;
  const orderKey = `OK_${rand(12)}`;

  const conn2 = await pool.getConnection();
  try {
    await conn2.beginTransaction();

    const [orderCols] = await conn2.query("SHOW COLUMNS FROM orders");
    const has = (n) => orderCols.some((c) => c.Field === n);

    const cols = [];
    const vals = [];
    const qms  = [];

    if (has("order_ref")) { cols.push("order_ref"); vals.push(outOrderId); qms.push("?"); }
    else if (has("order_id")) { cols.push("order_id"); vals.push(outOrderId); qms.push("?"); }

    if (has("order_key"))  { cols.push("order_key"); vals.push(orderKey); qms.push("?"); }
    if (has("currency"))   { cols.push("currency"); vals.push("LKR"); qms.push("?"); }
    if (has("amount"))     { cols.push("amount"); vals.push(amount); qms.push("?"); }
    if (has("pay_method")) { cols.push("pay_method"); vals.push(payMethod); qms.push("?"); }
    if (has("status"))     { cols.push("status"); vals.push(statusLabel); qms.push("?"); }
    if (has("description")){ cols.push("description"); vals.push(descLabel); qms.push("?"); }

    if (cols.length === 0) {
      return res.status(400).json({ ok: false, error: "ORDERS_TABLE_MISSING_WRITABLE_COLUMNS" });
    }

    const [ins] = await conn2.query(
      `INSERT INTO orders (${cols.join(",")}) VALUES (${qms.join(",")})`,
      vals
    );
    const newOrderPk = ins.insertId;

    const [[hasItemsTable]] = await conn2.query("SHOW TABLES LIKE 'order_items'");
    if (hasItemsTable) {
      const [itemCols] = await conn2.query("SHOW COLUMNS FROM order_items");
      const ih = (n) => itemCols.some((c) => c.Field === n);
      const useCents = ih("price_cents");

      for (const it of items) {
        if (useCents) {
          await conn2.query(
            `INSERT INTO order_items (order_id, table_id, seat_no, category, price_cents)
             VALUES (?, ?, ?, ?, ?)`,
            [newOrderPk, it.tableId, it.seatNo, it.category, Math.round(it.price * 100)]
          );
        } else {
          if (ih("category")) {
            await conn2.query(
              `INSERT INTO order_items (order_id, table_id, seat_no, category, price)
               VALUES (?, ?, ?, ?, ?)`,
              [newOrderPk, it.tableId, it.seatNo, it.category, it.price]
            );
          } else {
            await conn2.query(
              `INSERT INTO order_items (order_id, table_id, seat_no, price)
               VALUES (?, ?, ?, ?)`,
              [newOrderPk, it.tableId, it.seatNo, it.price]
            );
          }
        }
      }
    }

    await conn2.commit();
    res.json({ ok: true, order_ref: outOrderId, id: newOrderPk });
  } catch (e) {
    await conn2.rollback();
    console.error("[ADMIN][ticket-book] Error:", e);
    res.status(500).json({
      ok: false,
      error: "TICKET_BOOK_SAVE_FAILED",
      sqlMessage: e?.sqlMessage,
    });
  } finally {
    conn2.release();
  }
});

module.exports = router;
