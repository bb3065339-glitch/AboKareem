const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL = defineString("OPENAI_MODEL", { default: "gpt-6.2-astra" });

function clean(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function extractText(response) {
  if (response && typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of (response.output || [])) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

exports.abuKarimSupportAI = onDocumentCreated(
  {
    document: "supportChats/{chatId}/messages/{messageId}",
    region: "us-central1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 90,
    memory: "256MiB",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const message = snap.data() || {};
    if (message.by !== "user" || !clean(message.text, 2000)) return;

    const db = getFirestore();
    const chatRef = db.collection("supportChats").doc(event.params.chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return;

    const chat = chatSnap.data() || {};
    // Only answer the customer who owns this support conversation.
    if (!chat.uid || message.uid !== chat.uid) return;
    if (chat.aiPaused === true || chat.status === "solved") return;

    // Avoid duplicate processing if the Firestore event is retried.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(chatRef);
      if (!fresh.exists) return false;
      const data = fresh.data() || {};
      if (data.aiPaused === true || data.status === "solved") return false;
      if (data.aiLastMessageId === snap.id) return false;
      tx.update(chatRef, {
        aiLastMessageId: snap.id,
        aiProcessingAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!claimed) return;

    try {
      const [messagesSnap, catsSnap, itemsSnap] = await Promise.all([
        chatRef.collection("messages").orderBy("createdAt", "desc").limit(14).get(),
        db.collection("cats").get(),
        db.collection("items").get(),
      ]);

      const cats = new Map();
      catsSnap.forEach((doc) => cats.set(doc.id, clean(doc.data().name, 80)));
      const menu = [];
      itemsSnap.forEach((doc) => {
        const item = doc.data() || {};
        const name = clean(item.n, 100);
        if (!name) return;
        const category = cats.get(item.cat) || "أصناف أخرى";
        const prices = Array.isArray(item.p) ? item.p : [];
        const sizes = Array.isArray(item.l) ? item.l : [];
        const priceText = prices.map((price, i) => {
          const size = clean(sizes[i], 40);
          return `${size ? size + ": " : ""}${String(price)} جنيه`;
        }).join(" / ");
        menu.push(`${category} — ${name}${priceText ? " — " + priceText : ""}${item.d ? " — " + clean(item.d, 160) : ""}`);
      });

      const history = messagesSnap.docs.reverse().map((doc) => {
        const m = doc.data() || {};
        const role = m.by === "user" ? "العميل" : m.by === "admin" ? "موظف الدعم" : m.by === "ai" ? "أبو كريم AI" : "النظام";
        return `${role}: ${clean(m.text, 1000)}`;
      }).filter(Boolean).join("\n");

      const instructions = [
        "أنت أبو كريم AI، مساعد خدمة عملاء مطعم أبو كريم الحاتي.",
        "تحدث باللهجة المصرية الطبيعية، باحترام وود، وباختصار واضح.",
        "أجب عن المنيو والأسعار اعتمادًا فقط على بيانات المنيو المرفقة. لا تخترع صنفًا أو سعرًا أو عرضًا أو وقت توصيل.",
        "لو السعر أو المعلومة غير موجودة، قل إنك هتطلب من فريق المطعم التأكيد.",
        "لا تؤكد تنفيذ طلب أو دفع أو استرداد أموال، ولا تدّعِ أنك تستطيع تعديل الطلبات أو الاطلاع على بيانات الطلبات.",
        "حوّل المحادثة لموظف الدعم (handoff=true) عند الشكاوى، مشاكل الدفع أو الاسترداد، الطلبات المتأخرة أو الملغاة، طلب التحدث مع موظف، أو أي موقف يحتاج تدخل بشري.",
        "عند التحويل، اكتب للعميل أنك حولت المحادثة لفريق الدعم وأنهم هيتابعوا معاه.",
        "لا تطلب كلمة مرور أو بيانات بطاقة بنكية أو رمز تحقق.",
        "أخرج JSON فقط بالشكل المحدد: {\"reply\":\"...\",\"handoff\":false}."
      ].join("\n");

      const input = [
        "بيانات المنيو الحالية:\n" + (menu.length ? menu.join("\n") : "لا توجد بيانات منيو متاحة حاليًا."),
        "بيانات المحادثة:\n" + history,
        "أجب عن آخر رسالة للعميل."
      ].join("\n\n");

      const apiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_MODEL.value(),
          instructions,
          input,
          max_output_tokens: 500,
          text: {
            format: {
              type: "json_schema",
              name: "support_reply",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  reply: { type: "string" },
                  handoff: { type: "boolean" },
                },
                required: ["reply", "handoff"],
                additionalProperties: false,
              },
            },
          },
        }),
      });

      if (!apiResponse.ok) {
        const detail = await apiResponse.text();
        console.error("OpenAI API error", apiResponse.status, detail.slice(0, 1000));
        throw new Error("AI_PROVIDER_ERROR");
      }

      const result = await apiResponse.json();
      const raw = extractText(result);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = { reply: raw, handoff: false };
      }

      const reply = clean(parsed.reply, 1800) ||
        "معلش، حصلت مشكلة بسيطة. هبلغ فريق الدعم يتابع معاك.";
      const handoff = parsed.handoff === true;

      await chatRef.collection("messages").add({
        by: "ai",
        uid: "abu-karim-ai",
        text: reply,
        createdAt: FieldValue.serverTimestamp(),
      });

      await chatRef.update({
        lastMsg: reply.slice(0, 80),
        lastBy: "ai",
        updatedAt: FieldValue.serverTimestamp(),
        unreadAdmin: handoff,
        unreadUser: false,
        ...(handoff ? { aiPaused: true, status: "review" } : {}),
        aiProcessingAt: FieldValue.delete(),
      });
    } catch (error) {
      console.error("Abu Karim AI failed", error);
      await chatRef.update({
        aiProcessingAt: FieldValue.delete(),
        unreadAdmin: true,
        status: "review",
        aiPaused: true,
        lastMsg: "تعذر على المساعد الرد — مطلوب تدخل فريق الدعم",
        lastBy: "ai",
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }
);
