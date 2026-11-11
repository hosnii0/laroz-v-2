const API_VERSION_DEFAULT = "v25.0";
const recentTestRequests = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, max);
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && getAllowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function validateOrder(body) {
  const orderId = cleanText(body?.orderId, 48);
  const customerName = cleanText(body?.customerName, 80);
  const customerPhone = digits(body?.customerPhone);
  const orderType = body?.orderType === "Delivery"
    ? "Delivery"
    : body?.orderType === "Pickup" ? "Pickup" : "";
  const deliveryAddress = orderType === "Delivery"
    ? cleanText(body?.deliveryAddress, 300)
    : "-";
  const notes = cleanText(body?.notes, 300);
  const items = Array.isArray(body?.items) ? body.items : [];

  if (
    !/^LZ-[A-Z0-9-]{5,45}$/.test(orderId) ||
    !customerName ||
    customerPhone.length < 10 || customerPhone.length > 15 ||
    !orderType ||
    (orderType === "Delivery" && !deliveryAddress) ||
    items.length < 1 || items.length > 40
  ) {
    return { error: "راجع الاسم ورقم الموبايل وطريقة الاستلام وبيانات الطلب." };
  }

  let computedTotal = 0;
  const normalizedItems = [];

  for (const item of items) {
    const name = cleanText(item?.name, 80);
    const quantity = Number(item?.quantity);
    const unitPrice = Number(item?.unitPrice);

    if (
      !name ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 50 ||
      !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000
    ) {
      return { error: "فيه صنف أو كمية غير صحيحة في الطلب." };
    }

    computedTotal += quantity * unitPrice;
    normalizedItems.push({ name, quantity, unitPrice });
  }

  const suppliedTotal = Number(body?.total);
  if (
    !Number.isFinite(suppliedTotal) ||
    Math.abs(suppliedTotal - computedTotal) > 0.01
  ) {
    return { error: "إجمالي الطلب غير متطابق. حدّث السلة وحاول تاني." };
  }

  return {
    order: {
      orderId,
      customerName,
      customerPhone,
      orderType,
      deliveryAddress,
      notes,
      items: normalizedItems,
      total: computedTotal
    }
  };
}

function checkTemporaryRateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const cooldown = Math.max(10000, Number(env.TEST_ORDER_COOLDOWN_MS || 20000));

  for (const [key, timestamp] of recentTestRequests) {
    if (now - timestamp > cooldown * 3) recentTestRequests.delete(key);
  }

  const last = recentTestRequests.get(ip) || 0;
  const remaining = cooldown - (now - last);
  if (remaining > 0) return Math.ceil(remaining / 1000);

  // Best-effort temporary throttle per Worker isolate; not a substitute for
  // Turnstile or a persistent rate limiter before opening real orders publicly.
  recentTestRequests.set(ip, now);
  return 0;
}

async function sendTemplate(env, { recipient, name, language, components }) {
  const token = env.WHATSAPP_TOKEN;
  const phoneNumberId = env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !recipient) {
    throw new Error("WhatsApp environment variables are incomplete.");
  }

  const version = env.META_API_VERSION || API_VERSION_DEFAULT;
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(components ? { components } : {})
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.messages?.[0]?.id) {
    const safeMessage = cleanText(
      data?.error?.error_user_msg || data?.error?.message,
      240
    );
    throw new Error(safeMessage || `Meta API returned HTTP ${response.status}`);
  }
  return data.messages[0].id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = corsHeaders(request, env);
    const allowedOrigins = getAllowedOrigins(env);

    if (origin && !allowedOrigins.includes(origin)) {
      return json({ success: false, message: "المصدر ده غير مسموح له بالاتصال بالسيرفر." }, 403, headers);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({ service: "laroz-order-api", status: "online", runtime: "cloudflare-workers" }, 200, headers);
    }

    // Health check never calls Meta and never sends a WhatsApp message.
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "laroz-order-api", runtime: "cloudflare-workers" }, 200, headers);
    }

    // Temporary checkout test: receive the customer's checkout fields, then
    // send the fixed hello_world template to the configured verified test recipient.
    // The hello_world template has no variables, so order details are NOT included
    // in the WhatsApp message and are NOT stored (this project has no database).
    if (request.method === "POST" && url.pathname === "/api/orders-test") {
      if (!origin || !allowedOrigins.includes(origin)) {
        return json({ success: false, message: "افتح الموقع من رابط Laroz الرسمي لإرسال الطلب." }, 403, headers);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, message: "بيانات الطلب غير صالحة." }, 400, headers);
      }

      const validation = validateOrder(body);
      if (validation.error) {
        return json({ success: false, message: validation.error }, 400, headers);
      }

      const remainingSeconds = checkTemporaryRateLimit(request, env);
      if (remainingSeconds > 0) {
        return json({
          success: false,
          code: "RATE_LIMITED",
          retryAfterSeconds: remainingSeconds,
          message: `استنى ${remainingSeconds} ثانية قبل إرسال طلب تجريبي آخر.`
        }, 429, headers);
      }

      const recipient = digits(env.WHATSAPP_TO);
      if (!recipient || !env.WHATSAPP_TOKEN || !env.PHONE_NUMBER_ID) {
        return json({ success: false, message: "إعدادات WhatsApp غير مكتملة في Cloudflare." }, 503, headers);
      }

      try {
        const messageId = await sendTemplate(env, {
          recipient,
          name: "hello_world",
          language: "en_US"
        });

        return json({
          success: true,
          orderId: validation.order.orderId,
          template: "hello_world",
          messageId,
          detailsIncludedInWhatsApp: false,
          message: "Meta قبلت إرسال إشعار الاختبار إلى رقم WhatsApp المسجل كمستلم اختبار."
        }, 200, headers);
      } catch (error) {
        console.error("WhatsApp test-order send failed:", cleanText(error.message, 200));
        return json({
          success: false,
          message: "Meta لم تقبل إرسال رسالة الاختبار. راجع Token ورقم الاختبار وحالة WhatsApp في Meta."
        }, 502, headers);
      }
    }

    // Real order details are sent only after Meta approves the custom order template.
    if (request.method === "POST" && url.pathname === "/api/orders") {
      if (env.ENABLE_ORDER_SENDING !== "true") {
        return json({
          success: false,
          code: "ORDER_SENDING_DISABLED",
          message: "إرسال تفاصيل الأوردر متوقف مؤقتًا لحين موافقة Meta على قالب laroz_new_order."
        }, 503, headers);
      }

      return json({
        success: false,
        code: "REAL_ORDER_TEMPLATE_CONFIGURATION_REQUIRED",
        message: "فعّل إرسال الأوردرات بعد التأكد من اعتماد قالب laroz_new_order ومطابقة متغيراته."
      }, 503, headers);
    }

    return json({ success: false, message: "Not found" }, 404, headers);
  }
};
