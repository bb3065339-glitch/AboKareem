"use strict";
/**
 * Cloud Functions — مطعم أبو كريم الحاتي
 * المشروع: ak12-bd123  |  المنطقة: us-central1
 *
 *  1) grantSignupBonus   (Auth trigger)  — 5 نقاط هدية مرة واحدة لكل حساب جديد
 *  2) placeOrder         (callable)      — تنفيذ طلب مع خصم نقاط من المحفظة داخل Transaction
 *  3) adminAdjustPoints  (callable)      — إضافة/خصم نقاط من الإدارة مع تسجيل السبب
 *
 * كل تعديل على wallets / walletTx يتم هنا فقط عبر Admin SDK (قواعد Firestore تمنعه من المتصفح).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const REGION = "us-central1";
const MAIN_ADMIN = "bb3065339@gmail.com";
const SIGNUP_BONUS = 5;
const MAX_ADJUST = 100000;

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

/* ---------------------------------------------------------------
 * 1) هدية التسجيل — تعمل عند إنشاء حساب جديد في Firebase Auth فقط
 *    الحماية من التكرار: مستند معاملة ثابت الاسم signup_{uid} + علامة signupBonus في المحفظة
 * ------------------------------------------------------------- */
exports.grantSignupBonus = functionsV1
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    const uid = user.uid;
    const wRef = db.doc(`wallets/${uid}`);
    const tRef = db.doc(`walletTx/signup_${uid}`);
    await db.runTransaction(async (tx) => {
      const [w, t] = await Promise.all([tx.get(wRef), tx.get(tRef)]);
      if (t.exists || (w.exists && w.data().signupBonus === true)) return; // سبق منحها
      const d = w.exists ? w.data() : {};
      const bal = num(d.balance) + SIGNUP_BONUS;
      tx.set(
        wRef,
        {
          balance: bal,
          earned: num(d.earned) + SIGNUP_BONUS,
          spent: num(d.spent),
          signupBonus: true,
          createdAt: d.createdAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(tRef, {
        uid,
        type: "signup",
        amount: SIGNUP_BONUS,
        reason: "مكافأة التسجيل",
        balanceAfter: bal,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  });

/* ---------------------------------------------------------------
 * التحقق من المدير على الخادم (نفس منطق قواعد Firestore)
 * ------------------------------------------------------------- */
async function requireAdmin(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "سجّل الدخول أولاً.");
  const t = auth.token || {};
  const email = String(t.email || "");
  if (email === MAIN_ADMIN && t.email_verified === true) {
    return { uid: auth.uid, email, main: true };
  }
  const s = await db.doc(`admins/${auth.uid}`).get();
  if (s.exists) return { uid: auth.uid, email, main: false };
  throw new HttpsError("permission-denied", "هذه العملية للإدارة فقط.");
}

/* ---------------------------------------------------------------
 * 2) تنفيذ الطلب
 *    المدخلات من الموقع: { no, name, phone, type, address, notes, subtotal, fee, total, usePoints,
 *                          items:[{id?, n, v, p, q, x}] }
 *    الأسعار والتوصيل تُقرأ من Firestore — أرقام المتصفح تُستخدم للمطابقة فقط.
 * ------------------------------------------------------------- */
exports.placeOrder = onCall({ region: REGION, cors: true }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "سجّل الدخول لإتمام الطلب.");
  const uid = req.auth.uid;
  const d = req.data || {};

  const no = str(d.no, 40);
  const name = str(d.name, 80);
  const phone = str(d.phone, 20);
  const type = d.type === "d" ? "d" : "p";
  const address = str(d.address, 300);
  const notes = str(d.notes, 500);
  const usePoints = Math.floor(num(d.usePoints));

  if (!no) throw new HttpsError("invalid-argument", "رقم الطلب مفقود.");
  if (name.length < 2) throw new HttpsError("invalid-argument", "اكتب اسمك.");
  if (!/^\+?[0-9٠-٩\s-]{10,15}$/.test(phone)) throw new HttpsError("invalid-argument", "رقم الهاتف غير صحيح.");
  if (type === "d" && address.length < 8) throw new HttpsError("invalid-argument", "اكتب العنوان بالتفصيل.");
  if (usePoints < 0) throw new HttpsError("invalid-argument", "عدد النقاط غير صحيح.");
  if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > 50) {
    throw new HttpsError("invalid-argument", "السلة فارغة أو كبيرة جدًا.");
  }

  // حساب محظور؟
  const uDoc = await db.doc(`users/${uid}`).get();
  if (uDoc.exists && uDoc.data().blocked === true) {
    throw new HttpsError("permission-denied", "هذا الحساب موقوف. تواصل مع المطعم.");
  }

  // إعدادات الموقع (رسوم التوصيل)
  const cfg = await db.doc("site/config").get();
  if (!cfg.exists || cfg.data().menuSeeded !== true) {
    throw new HttpsError(
      "failed-precondition",
      "المنيو لم يُنشر على قاعدة البيانات بعد. على الإدارة الضغط على «نشر المنيو» من لوحة الإدارة."
    );
  }
  const fee = type === "d" ? num(cfg.data().fee) : 0;

  // التحقق من كل صنف وسعره من Firestore
  const lines = [];
  let subtotal = 0;
  for (const raw of d.items) {
    const q = Math.floor(num(raw && raw.q));
    if (!(q >= 1 && q <= 50)) throw new HttpsError("invalid-argument", "كمية غير صحيحة.");
    const id = str(raw && raw.id, 120);
    const n = str(raw && raw.n, 80);
    const v = str(raw && raw.v, 80);

    let item = null;
    if (id && !id.includes("/")) {
      const s = await db.doc(`items/${id}`).get();
      if (s.exists) item = { id: s.id, ...s.data() };
    }
    if (!item && n) {
      // سلال قديمة بلا معرّف: مطابقة بالاسم
      const qs = await db.collection("items").where("n", "==", n).limit(5).get();
      const hit = qs.docs.find((x) => x.data().h !== 1) || qs.docs[0];
      if (hit) item = { id: hit.id, ...hit.data() };
    }
    if (!item) throw new HttpsError("failed-precondition", `الصنف «${n || id}» لم يعد موجودًا. حدّث الصفحة.`);
    if (item.h || item.o) throw new HttpsError("failed-precondition", `الصنف «${item.n}» غير متاح حاليًا.`);

    const prices = Array.isArray(item.p) ? item.p : [];
    const labels = Array.isArray(item.l) ? item.l : [];
    let vi = 0;
    if (prices.length > 1) {
      vi = labels.indexOf(v);
      if (vi < 0) throw new HttpsError("failed-precondition", `الحجم المطلوب للصنف «${item.n}» غير متاح. حدّث الصفحة.`);
    }
    const price = num(prices[vi]);
    if (!(price > 0)) throw new HttpsError("failed-precondition", `سعر «${item.n}» غير مضبوط.`);

    subtotal += price * q;
    lines.push({ id: item.id, n: item.n, v: prices.length > 1 ? labels[vi] || "" : "", p: price, q, x: str(raw && raw.x, 200) });
  }

  const total = subtotal + fee;

  // مطابقة ما رآه العميل مع الأسعار الفعلية (حتى لا تختلف رسالة واتساب عن الطلب المسجل)
  if (num(d.subtotal) !== subtotal || num(d.fee) !== fee || num(d.total) !== total) {
    throw new HttpsError("failed-precondition", "تغيّرت الأسعار أو رسوم التوصيل. حدّث الصفحة وأعد المحاولة.");
  }
  if (usePoints > total) throw new HttpsError("invalid-argument", "النقاط المستخدمة أكبر من إجمالي الطلب.");

  const orderId = safeId(`${uid}_${no}`);
  const oRef = db.doc(`orders/${orderId}`);
  const wRef = db.doc(`wallets/${uid}`);
  const tRef = db.doc(`walletTx/purchase_${orderId}`);

  return db.runTransaction(async (tx) => {
    const [o, w] = await Promise.all([tx.get(oRef), tx.get(wRef)]);
    if (o.exists) return { ok: true, duplicate: true, orderId }; // إعادة محاولة — لا خصم مرة ثانية

    let balanceAfter = null;
    if (usePoints > 0) {
      const wd = w.exists ? w.data() : {};
      const bal = num(wd.balance);
      if (usePoints > bal) throw new HttpsError("failed-precondition", "رصيدك غير كافٍ لاستخدام هذا العدد من النقاط.");
      balanceAfter = bal - usePoints;
      tx.set(
        wRef,
        { balance: balanceAfter, spent: num(wd.spent) + usePoints, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      tx.set(tRef, {
        uid,
        type: "purchase",
        amount: -usePoints,
        reason: "شراء من المحفظة",
        orderNo: no,
        orderId,
        balanceAfter,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    tx.set(oRef, {
      no,
      uid,
      name,
      phone,
      type,
      address,
      items: lines,
      subtotal,
      fee,
      total,
      pointsUsed: usePoints,
      payable: total - usePoints,
      notes,
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
      source: "placeOrder",
    });
    return { ok: true, duplicate: false, orderId, balanceAfter };
  });
});

/* ---------------------------------------------------------------
 * 3) تعديل النقاط من الإدارة
 *    المدخلات: { uid, amount, op: 'add' | 'deduct', reason }
 * ------------------------------------------------------------- */
exports.adminAdjustPoints = onCall({ region: REGION, cors: true }, async (req) => {
  const adm = await requireAdmin(req.auth);
  const d = req.data || {};
  const target = str(d.uid, 128);
  const amount = Math.floor(num(d.amount));
  const op = d.op;
  const reason = str(d.reason, 200);

  if (!target || target.includes("/")) throw new HttpsError("invalid-argument", "معرّف العميل غير صحيح.");
  if (op !== "add" && op !== "deduct") throw new HttpsError("invalid-argument", "نوع العملية غير صحيح.");
  if (!(amount > 0) || amount > MAX_ADJUST) throw new HttpsError("invalid-argument", `المبلغ يجب أن يكون بين 1 و ${MAX_ADJUST}.`);
  if (reason.length < 3) throw new HttpsError("invalid-argument", "اكتب سبب العملية (3 أحرف على الأقل).");

  const uDoc = await db.doc(`users/${target}`).get();
  if (!uDoc.exists) throw new HttpsError("not-found", "العميل غير موجود.");
  const targetEmail = uDoc.data().email || target;

  const wRef = db.doc(`wallets/${target}`);
  const tRef = db.collection("walletTx").doc();
  const lRef = db.collection("adminLogs").doc();

  return db.runTransaction(async (tx) => {
    const w = await tx.get(wRef);
    const wd = w.exists ? w.data() : {};
    const bal = num(wd.balance);
    if (op === "deduct" && amount > bal) {
      throw new HttpsError("failed-precondition", `لا يمكن خصم أكثر من رصيد العميل (${bal}).`);
    }
    const balanceAfter = op === "add" ? bal + amount : bal - amount;
    tx.set(
      wRef,
      {
        balance: balanceAfter,
        earned: num(wd.earned) + (op === "add" ? amount : 0),
        spent: num(wd.spent) + (op === "deduct" ? amount : 0),
        createdAt: wd.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.set(tRef, {
      uid: target,
      type: op === "add" ? "admin_add" : "admin_deduct",
      amount: op === "add" ? amount : -amount,
      reason,
      balanceAfter,
      adminUid: adm.uid,
      adminEmail: adm.email,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(lRef, {
      by: adm.email,
      uid: adm.uid,
      act: `${op === "add" ? "إضافة" : "خصم"} ${amount} نقطة ${op === "add" ? "إلى" : "من"} ${targetEmail} — ${reason}`.slice(0, 200),
      at: FieldValue.serverTimestamp(),
    });
    return { ok: true, balanceAfter };
  });
});
