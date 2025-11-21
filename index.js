"use strict";

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const QRCode = require("qrcode");
const { MailerSend, EmailParams, Sender, Recipient, Attachment } = require("mailersend");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const axios = require("axios");

dotenv.config();

/* ───────── ENV ───────── */
const {
  PORT = 5055,
  FRONTEND_ORIGIN = "http://localhost:5173",

  MYSQL_HOST,
  MYSQL_PORT = "3306",
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DB,

  MAILERSEND_API_KEY,
  MAIL_FROM_EMAIL,
  MAIL_FROM_NAME,

  PUBLIC_ORDER_BASE = "https://eventz.lk/order",
  QR_SIGNING_SECRET = "",

  ATTACH_TICKET_JSON = "0",

  // --- ONEPAY KEYS ---
  ONEPAY_APP_ID,
  ONEPAY_HASH_SALT,
  ONEPAY_APP_TOKEN,
  ONEPAY_API_URL = "https://api.onepay.lk/v3/checkout/link/",
  ONEPAY_STATUS_API_URL = "https://api.onepay.lk/v3/transaction/status/",
  MY_WEBSITE_REDIRECT_URL = "http://localhost:5173/payment-complete", // CHECK THIS FILENAME!
} = process.env;

/* ───────── Admin Router Safety Load ───────── */
let adminRouter;
try {
  adminRouter = require("./routes/admin.js");
  console.log("[Admin Router] Loaded successfully.");
} catch (e) {
  console.warn(`[Admin Router] WARNING: Could not load routes/admin.js. Admin API disabled.`);
  console.warn(`[Admin Router] Error: ${e.message}`);
  adminRouter = express.Router();
}

/* ───────── App ───────── */
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use("/api/admin", adminRouter);

/* ───────── MySQL Pool ───────── */
if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DB) {
  console.error("[MySQL] env missing (MYSQL_HOST, MYSQL_USER, MYSQL_DB are required).");
  process.exit(1);
}
if (!ONEPAY_APP_ID || !ONEPAY_HASH_SALT || !ONEPAY_APP_TOKEN) {
  console.error("[OnePay] env missing (ONEPAY_APP_ID, ONEPAY_HASH_SALT, ONEPAY_APP_TOKEN are required).");
  process.exit(1);
}
const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DB,
  connectionLimit: 10,
  namedPlaceholders: true,
});
pool
  .query("SELECT 1")
  .then(() => console.log("[MySQL] connected"))
  .catch((e) => {
    console.error("[MySQL] connection failed:", e.message);
    process.exit(1);
  });

/* ───────── MailerSend ───────── */
const mailerSend = new MailerSend({ apiKey: MAILERSEND_API_KEY || "" });
const mailEnabled = Boolean(MAILERSEND_API_KEY && MAIL_FROM_EMAIL && MAIL_FROM_NAME);
console.log(
  mailEnabled
    ? "[MailerSend] API client is ready."
    : "[MailerSend] MAILERSEND_API_KEY, MAIL_FROM_EMAIL, or MAIL_FROM_NAME is missing. Emails will be skipped."
);

/* ───────── Helpers ───────── */
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

/**
 * Build the HTML body for the ticket email, now with seat summary section.
 * seatSummaryHtml is already formatted small HTML block:
 *
 * <b>Your Booked Seats</b><br>
 * 🎟️ Table A-1 – Seat 3<br>
 * ...
 * <br><b>VIP Tables</b><br>
 * 👑 Table B-4 (Full Table)
 */
function ticketEmailHtml({ firstName, orderId, orderRef, total, currency, seatSummaryHtml }) {
  return `
  <div style="font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;background:#0b1120;color:#e5fff9;padding:24px">
    <div style="max-width:640px;margin:0 auto;border:1px solid rgba(255,255,255,0.08);border-radius:16px;background:#0f172a;padding:24px">
      <h2 style="margin:0 0 12px 0;color:#5eead4">Your Ticket</h2>
      <p style="color:#c3f3ea">Hi ${firstName || "there"}, your payment was <b>successful</b>. Your QR ticket is <b>attached</b> to this email as an image.</p>

      <div style="margin:16px 0;padding:16px;border:1px solid rgba(255,255,255,0.06);border-radius:12px;background:rgba(2,6,23,0.35)">
        <div style="margin-bottom:10px">
          <div style="opacity:.7;font-size:12px">Order ID</div>
          <div style="font-weight:600">${orderId}</div>
        </div>
        <div style="margin-bottom:10px">
          <div style="opacity:.7;font-size:12px">Reference</div>
          <div style="font-weight:600">${orderRef}</div>
        </div>
        <div>
          <div style="opacity:.7;font-size:12px">Total</div>
          <div style="font-weight:700;color:#facc15">${total} ${currency}</div>
        </div>
      </div>

      ${
        seatSummaryHtml
          ? `
      <div style="margin-top:16px;padding:12px;border-radius:12px;background:rgba(15,23,42,0.9);border:1px solid rgba(94,234,212,0.35);color:#d1fae5;font-size:13px;line-height:1.5">
        ${seatSummaryHtml}
      </div>`
          : ""
      }

      <p style="margin-top:16px;color:#9bd7cd;font-size:13px">
        Please download or show the <b>attached QR image</b> at the gate. If you have questions, simply reply to this email.
      </p>
      <div style="margin-top:24px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;opacity:.7;font-size:12px">
        © ${new Date().getFullYear()} Eventz One. All rights reserved.
      </div>
    </div>
  </div>`;
}

/* ───────── QR helpers ───────── */
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function signFields(fields) {
  const secret = String(QR_SIGNING_SECRET || "");
  if (!secret) {
    console.warn("QR_SIGNING_SECRET is not set in .env! QR signature will be weak.");
  }
  const s = [fields.orderId, fields.orderRef, fields.txId || "", String(fields.iat || 0)].join("|");
  return b64url(crypto.createHmac("sha256", secret).update(s).digest());
}

function buildQrJson({ orderId, orderRef, txId, seats }) {
  const payload = {
    v: 1,
    typ: "eventz_ticket",
    orderId,
    orderRef,
    txId: txId || "",
    seats,
    iat: Math.floor(Date.now() / 1000),
  };
  payload.sig = signFields(payload);
  return JSON.stringify(payload);
}

function verifyQrJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (!data || data.typ !== "eventz_ticket" || data.v !== 1)
    return { ok: false, reason: "bad_type" };
  const expected = signFields(data);
  if (expected !== data.sig) return { ok: false, reason: "bad_sig" };
  return { ok: true, data };
}

/* ───────── Attachments sanity (kept) ───────── */
function toBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

/* ───────── PAYMENT HASH ───────── */
function generatePaymentHash(appId, currency, amountString, salt) {
  const message = appId + currency + amountString + salt;
  return crypto.createHash("sha256").update(message).digest("hex");
}

/* ───────── Health ───────── */
app.get("/api/health", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS c FROM seat_locks WHERE expires_at > NOW()"
    );
    const activeLocks = rows?.[0]?.c ?? 0;
    return res.status(200).json({ ok: true, db: true, mail: mailEnabled, activeLocks });
  } catch {
    return res.status(200).json({ ok: true, db: true, mail: mailEnabled });
  }
});

/* ==================================================================== */
/* 1) CREATE ORDER & CHECKOUT */
/* ==================================================================== */
app.post("/api/orders/create-checkout", async (req, res) => {
  const { orderReference, holdId = null, currency = "LKR", customer = {}, items = [] } =
    req.body || {};

  console.log(`\n--- [Checkout Start] Ref: ${orderReference} ---`);
  const conn = await pool.getConnection();

  try {
    // Validate
    if (!orderReference)
      return res.status(400).json({ ok: false, message: "orderReference required" });
    if (!customer?.email || !isEmail(customer.email)) {
      return res.status(400).json({ ok: false, message: "valid customer.email required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, message: "items array is required" });
    }

    // Idempotency (allow re-pending)
    const [existing] = await pool.execute(
      "SELECT id, status FROM orders WHERE order_ref=:ref LIMIT 1",
      { ref: orderReference }
    );
    if (existing.length && existing[0].status !== "pending") {
      return res.status(409).json({ ok: false, message: "Order already processed." });
    }

    // Totals
    const subtotal = (items || []).reduce(
      (sum, it) =>
        sum + Number(it?.qty ?? 1) * Number(it?.unitPrice ?? it?.price ?? 0),
      0
    );
    const fee = Math.round(subtotal * 0.01 * 100) / 100;
    const total = Math.round((subtotal + fee) * 100) / 100;

    await conn.beginTransaction();

    // Upsert order
    await conn.execute(
      `INSERT INTO orders
         (order_ref, hold_id, customer_first_name, customer_last_name, customer_email, customer_phone,
          currency, gross_amount, fee_amount, net_amount, status)
       VALUES (:orderRef, :holdId, :firstName, :lastName, :email, :phone,
               :currency, :gross, :fee, :net, 'pending')
       ON DUPLICATE KEY UPDATE
         hold_id = VALUES(hold_id),
         customer_first_name = VALUES(customer_first_name),
         customer_last_name = VALUES(customer_last_name),
         customer_email = VALUES(customer_email),
         customer_phone = VALUES(customer_phone),
         gross_amount = VALUES(gross_amount),
         fee_amount = VALUES(fee_amount),
         net_amount = VALUES(net_amount),
         status = 'pending'`,
      {
        orderRef: orderReference,
        holdId,
        firstName: String(customer.firstName || ""),
        lastName: String(customer.lastName || ""),
        email: String(customer.email || ""),
        phone: String(customer.phone || ""),
        currency,
        gross: total,
        fee,
        net: subtotal,
      }
    );

    const [[{ id: finalOrderId }]] = await conn.execute(
      "SELECT id FROM orders WHERE order_ref = :ref",
      { ref: orderReference }
    );

    // Reset items (in case of retry)
    await conn.execute("DELETE FROM order_items WHERE order_id = :orderId", {
      orderId: finalOrderId,
    });

    // Insert items — VIP Table uses seat_no = 0
    for (const it of items) {
      const isVipTable = it.type === "vipTable";
      await conn.execute(
        `INSERT INTO order_items (order_id, item_type, table_id, seat_no, qty, unit_price, amount)
         VALUES (:orderId, :type, :tableId, :seatNo, :qty, :unit, :amt)`,
        {
          orderId: finalOrderId,
          type: isVipTable ? "vipTable" : "seat",
          tableId: it.tableId ?? null,
          seatNo: isVipTable ? 0 : it.seatNo ?? null,
          qty: Number(it.qty ?? 1),
          unit: Number(it.unitPrice ?? it.price ?? 0),
          amt: Number(it.qty ?? 1) * Number(it.unitPrice ?? it.price ?? 0),
        }
      );
    }

    // OnePay link
    const hash = generatePaymentHash(
      ONEPAY_APP_ID,
      currency,
      total.toFixed(2),
      ONEPAY_HASH_SALT
    );
    const payload = {
      currency,
      app_id: ONEPAY_APP_ID,
      hash,
      amount: total,
      reference: orderReference,
      customer_first_name: String(customer.firstName || ""),
      customer_last_name: String(customer.lastName || ""),
      customer_phone_number: String(customer.phone || ""),
      customer_email: String(customer.email || ""),
      transaction_redirect_url: `${MY_WEBSITE_REDIRECT_URL}?orderReference=${orderReference}`,
      additionalData: `Order ${orderReference}`,
    };

    const onePayResponse = await axios.post(ONEPAY_API_URL, payload, {
      headers: { Authorization: ONEPAY_APP_TOKEN, "Content-Type": "application/json" },
    });

    const ipgTransactionId = onePayResponse.data?.data?.ipg_transaction_id;
    if (!ipgTransactionId) {
      console.error(
        "[Checkout] OnePay missing ipg_transaction_id:",
        JSON.stringify(onePayResponse.data, null, 2)
      );
      throw new Error("OnePay API call failed to return transaction ID.");
    }

    await conn.execute(
      "UPDATE orders SET ipg_tx_id = :ipgId WHERE id = :orderId",
      { ipgId: ipgTransactionId, orderId: finalOrderId }
    );

    await conn.commit();

    const redirectUrl = onePayResponse.data?.data?.gateway?.redirect_url;
    if (!redirectUrl) {
      throw new Error("OnePay API call failed to return redirect URL.");
    }

    return res.status(200).json({
      status: 200,
      message: "Successfully generate checkout link",
      data: {
        ipg_transaction_id: ipgTransactionId,
        redirect_url: redirectUrl,
      },
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error(`[Checkout Error] ${orderReference}:`, e?.message, e?.stack);
    if (axios.isAxiosError(e) && e.response) {
      console.error("Axios Status:", e.response.status);
      console.error("Axios Body:", JSON.stringify(e.response.data, null, 2));
    }
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ ok: false, message: "server_error", error: e.message || "Unknown" });
    }
  } finally {
    conn.release();
    console.log(`--- [Checkout End] Ref: ${orderReference} ---\n`);
  }
});

/* ==================================================================== */
/* 2) PAYMENT WEBHOOK */
/* ==================================================================== */
app.post("/api/payment/webhook", async (req, res) => {
  const webhookPayload = req.body;
  console.log("\n--- WEBHOOK RECEIVED ---");
  console.log(JSON.stringify(webhookPayload, null, 2));

  if (!webhookPayload || !webhookPayload.transaction_id || !webhookPayload.status) {
    console.warn("[Webhook] invalid payload");
    return res.status(400).json({ status: "invalid_format", received: webhookPayload });
  }

  // status=1 => success
  const status_code = String(webhookPayload.status);
  const onepay_transaction_id = webhookPayload.transaction_id;

  // Ack immediately
  res.status(200).json({ status: "received", processing: true });

  const conn = await pool.getConnection();
  const lookupKey = String(onepay_transaction_id);
  if (!lookupKey) {
    conn.release();
    return;
  }

  try {
    await conn.beginTransaction();

    const [orderRows] = await conn.execute(
      `SELECT * FROM orders WHERE ipg_tx_id = :lookupKey LIMIT 1 FOR UPDATE`,
      { lookupKey }
    );
    if (!orderRows.length) {
      console.warn(`[Webhook] No order for tx ${lookupKey}`);
      await conn.rollback();
      return;
    }

    const order = orderRows[0];
    if (order.status !== "pending") {
      console.warn(`[Webhook] Order already ${order.status}`);
      await conn.rollback();
      return;
    }

    const orderId = order.id;
    const originalOrderRef = order.order_ref;

    if (status_code !== "1") {
      await conn.execute("UPDATE orders SET status = 'failed' WHERE id = :orderId", {
        orderId,
      });
      if (order.hold_id) {
        await conn.execute("DELETE FROM seat_locks WHERE hold_id = :holdId", {
          holdId: order.hold_id,
        });
      }
      await conn.commit();
      return;
    }

    // Validate IPG id
    if (!order.ipg_tx_id || order.ipg_tx_id !== lookupKey) {
      await conn.execute("UPDATE orders SET status = 'review_needed' WHERE id = :orderId", {
        orderId,
      });
      await conn.commit();
      return;
    }

    // Mark paid
    await conn.execute("UPDATE orders SET status = 'paid' WHERE id = :orderId", {
      orderId,
    });

    // Record payment
    await conn.execute(
      `INSERT INTO payments (order_id, provider, tx_id, amount, currency, status, raw_payload)
       VALUES (:orderId, 'onepay', :txId, :amount, :currency, 'captured', :raw)
       ON DUPLICATE KEY UPDATE status='captured', raw_payload=:raw`,
      {
        orderId,
        txId: onepay_transaction_id,
        amount: Number(order.gross_amount),
        currency: order.currency,
        raw: JSON.stringify(webhookPayload),
      }
    );

    // Items → tickets + final locks
    const [items] = await conn.execute(
      "SELECT * FROM order_items WHERE order_id = :orderId",
      { orderId }
    );

    const seatPairs = [];
    const vipTables = [];

    // Regular seats
    for (const it of items) {
      if (it.item_type === "seat" && it.table_id && it.seat_no != null) {
        seatPairs.push([String(it.table_id), Number(it.seat_no)]);
        const ticketCode = `T-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
        await conn.execute(
          `INSERT INTO tickets (order_id, table_id, seat_no, qr_code, status)
           VALUES (:orderId, :tableId, :seatNo, :qr, 'valid')`,
          { orderId, tableId: it.table_id, seatNo: it.seat_no, qr: ticketCode }
        );
        await conn.execute(
          `INSERT INTO done_seatlocks (event_id, order_id, table_id, seat_no)
           VALUES ('default', :orderId, :tableId, :seatNo)
           ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`,
          { orderId, tableId: it.table_id, seatNo: it.seat_no }
        );
      } else if (it.item_type === "vipTable" && it.table_id) {
        vipTables.push(String(it.table_id));
      }
    }

    // VIP tables → one final lock with seat_no = 0
    for (const tableId of vipTables) {
      await conn.execute(
        `INSERT INTO done_seatlocks (event_id, order_id, table_id, seat_no)
         VALUES ('default', :orderId, :tableId, 0)
         ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`,
        { orderId, tableId }
      );
    }

    // Clear temp holds
    if (order.hold_id) {
      await conn.execute("DELETE FROM seat_locks WHERE hold_id = :holdId", {
        holdId: order.hold_id,
      });
    }

    await conn.commit();
    console.log(`[Webhook] Order ${originalOrderRef} confirmed. Sending email.`);

    // Build QR (only for seat-level items)
    const qrJson = buildQrJson({
      orderId,
      orderRef: originalOrderRef,
      txId: onepay_transaction_id,
      seats: seatPairs,
    });
    const qrPngBuffer = await QRCode.toBuffer(qrJson, {
      type: "png",
      margin: 1,
      width: 600,
    });

    // Build seat summary HTML (Format C)
    let seatSummaryHtml = "";
    const parts = [];

    if (seatPairs.length) {
      const seatLines = seatPairs.map(
        ([tableId, seatNo]) => `🎟️ Table ${tableId} – Seat ${seatNo}`
      );
      parts.push(`<b>Your Booked Seats</b><br>${seatLines.join("<br>")}`);
    }

    if (vipTables.length) {
      const vipLines = vipTables.map(
        (tableId) => `👑 Table ${tableId} (Full Table)`
      );
      parts.push(`<b>VIP Tables</b><br>${vipLines.join("<br>")}`);
    }

    if (parts.length) {
      seatSummaryHtml = parts.join("<br><br>");
    }

    if (mailEnabled) {
      const sentFrom = new Sender(MAIL_FROM_EMAIL, MAIL_FROM_NAME);
      const recipients = [
        new Recipient(
          String(order.customer_email),
          String(order.customer_first_name || "")
        ),
      ];
      const pngB64 = toBase64(qrPngBuffer);
      const attachments = [
        new Attachment(pngB64, `ticket-${orderId}.png`, "attachment"),
      ];

      const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(`Your Ticket • Order #${orderId}`)
        .setHtml(
          ticketEmailHtml({
            firstName: String(order.customer_first_name || ""),
            orderId,
            orderRef: originalOrderRef,
            total: Number(order.gross_amount).toFixed(2),
            currency: order.currency,
            seatSummaryHtml,
          })
        )
        .setAttachments(attachments);

      mailerSend.email
        .send(emailParams)
        .then((response) =>
          console.log(
            `[MailerSend] sent id=${response.headers["x-message-id"]}`
          )
        )
        .catch((error) =>
          console.error("[MailerSend] error:", error?.body || error)
        );
    }
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error(`[Webhook] CRITICAL FAILURE ${lookupKey}:`, e);
  } finally {
    conn.release();
  }
});

/* ==================================================================== */
/* 3) CHECK PAYMENT STATUS (front-end poll) */
/* ==================================================================== */
app.post("/api/payment/status", async (req, res) => {
  const { orderReference } = req.body;
  if (!orderReference)
    return res
      .status(400)
      .json({ ok: false, message: "orderReference is required" });

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT o.status, o.order_ref
       FROM orders o 
       WHERE o.ipg_tx_id = :order_ref 
       LIMIT 1`,
      { order_ref: orderReference }
    );

    const orderStatus = rows.length ? rows[0].status : "not_found";
    const orderRef = rows.length ? rows[0].order_ref : null;

    if (orderStatus === "paid" || orderStatus === "checked_in") {
      return res.status(200).json({
        status: 200,
        message: "Payment confirmed.",
        data: { status_code: "200", reference: orderRef },
      });
    } else if (orderStatus === "failed") {
      return res.status(200).json({
        status: 200,
        message: "Payment failed.",
        data: {
          status_code: "400",
          status_message: "Payment Failed/Declined",
        },
      });
    } else if (orderStatus === "review_needed") {
      return res.status(200).json({
        status: 200,
        message: "Payment validation error.",
        data: {
          status_code: "400",
          status_message: "Payment Failed/Declined",
        },
      });
    } else {
      return res.status(200).json({
        status: 200,
        message: "Status pending/unverified.",
        data: {
          status_code: "500",
          status_message: "Verification Pending",
        },
      });
    }
  } catch (error) {
    console.error("Error checking payment status via DB:", error.message);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to check payment status (DB error)." });
  } finally {
    conn.release();
  }
});

/* ==================================================================== */
/* 4) OTHER ENDPOINTS */
/* ==================================================================== */

/* GET order by ref (for Success page) */
app.get("/api/orders/:ref", async (req, res) => {
  const ref = String(req.params.ref || "");
  if (!ref) return res.status(400).json({ ok: false, message: "missing ref" });
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.execute(
      `SELECT id, order_ref, currency, net_amount, gross_amount, status,
              customer_first_name, customer_last_name, customer_email, customer_phone
         FROM orders WHERE order_ref = :ref LIMIT 1`,
      { ref }
    );
    if (!rows.length) {
      conn.release();
      return res.status(404).json({ ok: false, message: "not_found" });
    }
    const order = rows[0];
    const [items] = await conn.execute(
      `SELECT item_type, table_id, seat_no, qty, unit_price, amount
         FROM order_items WHERE order_id = :id`,
      { id: order.id }
    );

    const [[payment]] = await conn.execute(
      `SELECT tx_id FROM payments WHERE order_id = :id LIMIT 1`,
      { id: order.id }
    );
    const txId = payment ? payment.tx_id : "";

    conn.release();

    // Only include individual seats in QR payload
    const seatPairs = (items || [])
      .filter((r) => r.item_type === "seat" && r.table_id && r.seat_no != null)
      .map((r) => [String(r.table_id), Number(r.seat_no)]);

    const vipTables = (items || [])
      .filter((r) => r.item_type === "vipTable" && r.table_id)
      .map((r) => String(r.table_id));

    const qrJson = buildQrJson({
      orderId: order.id,
      orderRef: order.order_ref,
      txId,
      seats: seatPairs,
    });
    const qrDataUrl = await QRCode.toDataURL(qrJson, { margin: 1, width: 480 });

    return res.status(200).json({
      ok: true,
      order: {
        id: order.id,
        orderReference: order.order_ref,
        txId,
        total: Number(order.gross_amount).toFixed(2),
        currency: order.currency,
        status: String(order.status).toUpperCase(),
        customer: {
          firstName: order.customer_first_name,
          lastName: order.customer_last_name,
          email: order.customer_email,
          phone: order.customer_phone,
        },
        qrDataUrl,
        qrJson,
        // extra, in case you want to show seats on Success page later
        seatDetails: {
          seats: seatPairs.map(([tableId, seatNo]) => ({ tableId, seatNo })),
          vipTables: vipTables.map((tableId) => ({ tableId })),
        },
      },
    });
  } catch (e) {
    if (conn) conn.release();
    console.error("[orders/:ref] error:", e);
    return res.status(500).json({ ok: false, message: "server_error" });
  }
});

/* QR verification (for scanners) */
app.post("/api/qr/verify", express.text({ type: "*/*" }), async (req, res) => {
  const qrText = (typeof req.body === "string" ? req.body : "").trim();
  const v = verifyQrJson(qrText);
  if (!v.ok) return res.status(400).json({ ok: false, reason: v.reason });
  return res.status(200).json({ ok: true, data: v.data });
});

/* Seat locks API:
   - GET expands seat_no = 0 to 1..10 for UI
   - POST accepts seat_no = 0 (full table) or partial seat lists and coalesces full table to 0
*/
app.get("/api/locks", async (_req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    // cleanup expired
    await conn.execute("DELETE FROM seat_locks WHERE expires_at < NOW()");

    const [temp] = await conn.execute(
      `SELECT table_id AS tableId, seat_no AS seatNo
         FROM seat_locks
        WHERE event_id='default' AND expires_at > NOW()`
    );
    const [paid] = await conn.execute(
      `SELECT table_id AS tableId, seat_no AS seatNo
         FROM done_seatlocks
        WHERE event_id='default'`
    );
    conn.release();

    // Expand seat_no = 0 → 1..10 for UI consumption
    const expand = (rows) =>
      rows.flatMap((r) => {
        if (Number(r.seatNo) === 0) {
          return Array.from({ length: 10 }, (_, i) => ({
            tableId: r.tableId,
            seatNo: i + 1,
          }));
        }
        return [{ tableId: r.tableId, seatNo: Number(r.seatNo) }];
      });

    const locks = [...expand(temp), ...expand(paid)];
    return res.status(200).json({ ok: true, locks });
  } catch (e) {
    if (conn) conn.release();
    console.error("[locks] GET error:", e);
    return res.status(500).json({ ok: false, message: "locks_fetch_failed" });
  }
});

app.post("/api/locks/hold", async (req, res) => {
  const eventId = "default";
  const { seats = [], ttlSec = 600, holdId } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) {
    return res.status(422).json({ ok: false, message: "seats[] required" });
  }
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    return res.status(422).json({ ok: false, message: "ttlSec invalid" });
  }

  const newHoldId =
    holdId ||
    `H${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const expiresAt = new Date(Date.now() + ttlSec * 1000);

  // Group incoming by table
  const byTable = new Map();
  for (const s of seats) {
    const t = String(s.tableId);
    const n = Number(s.seatNo);
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(n);
  }

  // Normalize per table:
  // - if any 0 present OR seats are exactly 1..10 → treat as full-table (store seat_no=0)
  // - else partial set as-is
  function normalizeGroups() {
    const groups = [];
    for (const [tableId, arr] of byTable.entries()) {
      const nums = Array.from(new Set(arr)).sort((a, b) => a - b);
      const hasZero = nums.includes(0);
      const isFull =
        hasZero || (nums.length === 10 && nums.every((x, i) => x === i + 1));
      if (isFull) {
        groups.push({ tableId, mode: "full", seats: [0] });
      } else {
        groups.push({ tableId, mode: "partial", seats: nums.filter((n) => n > 0) });
      }
    }
    return groups;
  }

  const groups = normalizeGroups();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Conflict checks
    for (const g of groups) {
      if (g.mode === "full") {
        // Any paid (full or partial) on that table conflicts
        const [paidAny] = await conn.execute(
          `SELECT 1 FROM done_seatlocks
           WHERE event_id=? AND table_id=? LIMIT 1`,
          [eventId, g.tableId]
        );
        if (paidAny.length) {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            message: "Some seats already sold",
            conflicts: [{ tableId: g.tableId, seatNo: 0 }],
          });
        }

        // Any temp lock (full or partial) by other hold conflicts
        const [tmpAny] = await conn.execute(
          `SELECT seat_no, hold_id
             FROM seat_locks
            WHERE event_id=? AND table_id=? AND expires_at > NOW()`,
          [eventId, g.tableId]
        );
        const tmpConflict = (tmpAny || []).some((r) => r.hold_id !== holdId);
        if (tmpConflict) {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            message: "Some seats already held",
            conflicts: [{ tableId: g.tableId, seatNo: 0 }],
          });
        }
      } else {
        // Partial: conflict with paid full-table OR matching paid seats
        const pairsSql = g.seats.map(() => "(?, ?)").join(",");
        const pairsArgs = g.seats.flatMap((n) => [g.tableId, n]);

        const [paidRows] = await conn.execute(
          `SELECT table_id AS tableId, seat_no AS seatNo
             FROM done_seatlocks
            WHERE event_id=? AND (
                  (table_id = ? AND seat_no = 0) OR
                  (table_id, seat_no) IN (${pairsSql})
            )`,
          [eventId, g.tableId, ...pairsArgs]
        );
        if (paidRows.length) {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            message: "Some seats already sold",
            conflicts: paidRows,
          });
        }

        const [tmpRows] = await conn.execute(
          `SELECT table_id AS tableId, seat_no AS seatNo, hold_id AS holdId
             FROM seat_locks
            WHERE event_id=? AND expires_at > NOW() AND (
                  (table_id = ? AND seat_no = 0) OR
                  (table_id, seat_no) IN (${pairsSql})
            )`,
          [eventId, g.tableId, ...pairsArgs]
        );
        const conflicts = (tmpRows || []).filter(
          (r) => !holdId || r.holdId !== holdId
        );
        if (conflicts.length) {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            message: "Some seats already held",
            conflicts: conflicts.map((c) => ({
              tableId: c.tableId,
              seatNo: c.seatNo,
            })),
          });
        }
      }
    }

    // Write locks
    for (const g of groups) {
      if (g.mode === "full") {
        await conn.execute(
          `INSERT INTO seat_locks (event_id, table_id, seat_no, hold_id, expires_at, created_at)
           VALUES (?, ?, 0, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE hold_id=VALUES(hold_id), expires_at=VALUES(expires_at)`,
          [eventId, g.tableId, newHoldId, expiresAt]
        );
      } else {
        for (const n of g.seats) {
          await conn.execute(
            `INSERT INTO seat_locks (event_id, table_id, seat_no, hold_id, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE hold_id=VALUES(hold_id), expires_at=VALUES(expires_at)`,
            [eventId, g.tableId, n, newHoldId, expiresAt]
          );
        }
      }
    }

    await conn.commit();
    return res.status(200).json({
      ok: true,
      holdId: newHoldId,
      seats: groups.flatMap((g) =>
        g.mode === "full"
          ? [{ tableId: g.tableId, seatNo: 0 }]
          : g.seats.map((n) => ({ tableId: g.tableId, seatNo: n }))
      ),
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[locks] POST error:", e);
    return res.status(500).json({ ok: false, message: "hold_failed" });
  } finally {
    conn.release();
  }
});

/* Dev: test deliverability */
app.get("/api/dev/test-mail", async (req, res) => {
  if (!mailEnabled)
    return res
      .status(503)
      .json({ ok: false, message: "mail_disabled (check env)" });
  const to = String(req.query.to || "").trim();
  if (!to)
    return res
      .status(400)
      .json({ ok: false, message: "missing 'to' query param" });
  try {
    const sentFrom = new Sender(MAIL_FROM_EMAIL, MAIL_FROM_NAME);
    const recipients = [new Recipient(to)];
    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo(recipients)
      .setSubject("Eventz test mail (MailerSend)")
      .setText("If you can read this, MailerSend is working.");
    const response = await mailerSend.email.send(emailParams);
    return res.json({
      ok: true,
      messageId: response.headers["x-message-id"],
      response: response.body,
    });
  } catch (e) {
    console.error("[dev/test-mail] MailerSend error:", e?.body || e);
    return res.status(500).json({
      ok: false,
      message: e?.body?.message || "send_failed",
      details: e?.body?.errors,
    });
  }
});

/* ───────── START ───────── */
app.listen(Number(PORT), () => {
  console.log(
    `[API] listening on http://localhost:${PORT} (origin: ${FRONTEND_ORIGIN})`
  );
});
