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

    const exposeOrderRef = has("order_ref") ? "o.order_ref" : "NULL";
    const exposeOrderId = has("order_id") ? "o.order_id" : "NULL";

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

    // Items
    const [[hasItemsTable]] = await conn.query("SHOW TABLES LIKE 'order_items'");
    let items = [];
    if (hasItemsTable) {
      const [itemCols] = await conn.query("SHOW COLUMNS FROM order_items");
      const ih = (n) => itemCols.some((c) => c.Field === n);

      const priceExpr = ih("unit_price")
        ? "oi.unit_price"
        : ih("price_cents")
        ? "oi.price_cents / 100"
        : ih("price")
        ? "oi.price"
        : "0";
      const tableExpr = ih("table_id") ? "oi.table_id" : "NULL";
      const seatExpr = ih("seat_no") ? "oi.seat_no" : "NULL";
      const typeExpr = ih("item_type")
        ? "oi.item_type"
        : ih("category")
        ? "oi.category"
        : "'general'";

      const [rows] = await conn.query(
        `SELECT oi.order_id,
                ${tableExpr} AS table_id,
                ${seatExpr}  AS seat_no,
                ${typeExpr}  AS category,
                ${priceExpr} AS price
         FROM order_items oi`
      );
      items = rows;
    }

    // Build response
    const byOrderPk = new Map();
    for (const o of orders) {
      const checkedFlag =
        (typeof o.checked_in_raw === "string" && o.checked_in_raw.toLowerCase() === "done") ||
        (typeof o.checked_in_raw === "number" && o.checked_in_raw === 1) ||
        !!o.checked_in_at;

      byOrderPk.set(o.id, {
        id: o.id,
        order_ref: o.order_ref || null,
        orderId: o.order_id || null,
        amount: Number(o.amount || 0),
        currency: o.currency || "LKR",
        description: o.description || "",
        ts: o.ts,
        checkedInAt: o.checked_in_at || null,
        status: checkedFlag ? "Checked-in" : o.status || "pending",
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
   CREATE TICKET-BOOK / PICKME ORDERS
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

  // Check if any seat in the specified table is already booked
  const seatAvailabilityCheck = `
    SELECT seat_no FROM order_items WHERE table_id = ? AND seat_no IN (?)`;
  const [bookedSeats] = await pool.query(seatAvailabilityCheck, [tId, seatList]);

  if (bookedSeats.length > 0) {
    return res.status(400).json({ ok: false, error: "SEAT_ALREADY_BOOKED" });
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
  const statusLabel = src;
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
    const qms = [];

    if (has("order_ref")) { cols.push("order_ref"); vals.push(outOrderId); qms.push("?"); }
    else if (has("order_id")) { cols.push("order_id"); vals.push(outOrderId); qms.push("?"); }

    if (has("order_key"))  { cols.push("order_key"); vals.push(orderKey); qms.push("?"); }
    if (has("currency"))   { cols.push("currency"); vals.push("LKR"); qms.push("?"); }
    if (has("amount"))     { cols.push("amount"); vals.push(amount); qms.push("?"); }
    if (has("pay_method")) { cols.push("pay_method"); vals.push(payMethod); qms.push("?"); }
    if (has("status"))     { cols.push("status"); vals.push(statusLabel); qms.push("?"); }
    if (has("description")){ cols.push("description"); vals.push(descLabel); qms.push("?"); }

    const [ins] = await conn2.query(
      `INSERT INTO orders (${cols.join(",")}) VALUES (${qms.join(",")})`,
      vals
    );
    const newOrderPk = ins.insertId;

    const [[hasItemsTable]] = await conn2.query("SHOW TABLES LIKE 'order_items'");
    if (hasItemsTable) {
      const [itemCols] = await conn2.query("SHOW COLUMNS FROM order_items");
      const ih = (n) => itemCols.some((c) => c.Field === n);

      for (const it of items) {
        const cols = ["order_id", "table_id", "seat_no"];
        const qms = ["?", "?", "?"];
        const vals = [newOrderPk, it.tableId, it.seatNo];

        if (ih("item_type")) {
          cols.push("item_type");
          qms.push("?"); vals.push(it.category === "vip" ? "vipTable" : "seat");
        }

        if (ih("qty")) {
          cols.push("qty");
          qms.push("?"); vals.push(1);
        }

        if (ih("unit_price")) {
          cols.push("unit_price");
          qms.push("?"); vals.push(it.price || 0);
        }

        if (ih("amount")) {
          cols.push("amount");
          qms.push("?"); vals.push(it.price || 0);
        }

        const sql = `INSERT INTO order_items (${cols.join(",")}) VALUES (${qms.join(",")})`;
        await conn2.query(sql, vals);
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
