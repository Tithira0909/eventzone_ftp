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
   LIST ORDERS (Including 'ticket_book' and 'paid' status)
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

    // Fetch orders with 'ticket_book' or 'paid' status
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
      WHERE o.status IN ('ticket_book', 'paid')  -- Include orders with 'ticket_book' or 'paid' status
      ORDER BY o.id DESC
    `;

    const [orders] = await conn.query(sqlOrders);

    // Fetch items for each order
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
   CHECK-IN ORDER VIA QR CODE SCAN (Including 'paid' status and 'ticket_book')
   ========================================================================= */
router.post("/check-in", async (req, res) => {
  const { orderRef } = req.body; // Assume QR scan sends the order reference

  if (!orderRef) {
    return res.status(400).json({ ok: false, error: "NO_ORDER_REF" });
  }

  const conn = await pool.getConnection();
  try {
    // Start transaction to ensure atomicity
    await conn.beginTransaction();

    // Check if order exists and is either 'ticket_book' or 'paid'
    const [order] = await conn.query("SELECT * FROM orders WHERE order_ref = ?", [orderRef]);
    if (!order || !["ticket_book", "paid"].includes(order.status)) {
      return res.status(400).json({ ok: false, error: "INVALID_ORDER" });
    }

    // Check if the order is already checked in
    if (order.checked_in) {
      return res.status(400).json({ ok: false, error: "ALREADY_CHECKED_IN" });
    }

    // Update checked_in column to 1 and set checked_at to current timestamp
    const updateSql = `
      UPDATE orders
      SET checked_in = 1, checked_at = NOW()
      WHERE order_ref = ?
    `;
    await conn.query(updateSql, [orderRef]);

    // Commit the transaction
    await conn.commit();

    res.json({ ok: true, message: "Order checked-in successfully", orderRef });
  } catch (e) {
    // Rollback transaction on error
    await conn.rollback();
    console.error("[ADMIN][check-in] Error:", e);
    res.status(500).json({
      ok: false,
      error: "CHECK_IN_FAILED",
      sqlMessage: e?.sqlMessage,
    });
  } finally {
    conn.release();
  }
});

module.exports = router;
