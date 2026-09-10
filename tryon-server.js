/* ============================================================
   Зеркало — сервер примерки
   Node 18+, Express. Ключ Google живёт только здесь.
   npm i express cors
   GEMINI_API_KEY=... node tryon-server.js
   ============================================================ */

import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: process.env.APP_ORIGIN || "*" }));
app.use(express.json({ limit: "12mb" }));

const KEY = process.env.GEMINI_API_KEY;

/* Три уровня качества. Выбор влияет на цену и скорость.
   preview  — быстрый черновик, пока она листает варианты
   standard — основной рендер
   pro      — «сохранить в высоком качестве», премиум-действие */
const MODELS = {
  preview: "gemini-3.1-flash-lite-image",
  standard: "gemini-3.1-flash-image",
  pro: "gemini-3-pro-image",
};

/* ------------------------------------------------------------
   Промпт. Это половина успеха: без явного запрета на ретушь
   модель отдаёт глянцевую куклу вместо живого лица.
   ------------------------------------------------------------ */
function buildPrompt({ cut, haircolor, brows, lips, makeup }) {
  const changes = [];
  if (cut) changes.push(`причёска: ${cut}`);
  if (haircolor) changes.push(`цвет волос: ${haircolor}`);
  if (brows) changes.push(`форма бровей: ${brows}`);
  if (lips) changes.push(`помада: ${lips}`);
  if (makeup) changes.push(`макияж: ${makeup}`);

  return `Отредактируй эту фотографию. Измени только следующее: ${changes.join("; ")}.

Сохрани без изменений: черты лица, форму глаз, носа и подбородка, пропорции лица,
оттенок и текстуру кожи, родинки и веснушки, положение головы, фон, кадрирование,
направление и характер света. Человек на фото должен остаться безусловно узнаваемым.

Результат — фотография, а не иллюстрация. Сохрани естественную текстуру кожи с порами
и микрорельефом. Волосы с отдельными прядями и естественным блеском, без пластикового
глянца. Свет на новых волосах должен совпадать с освещением сцены.

Запрещено: сглаживание кожи, эффект бьюти-фильтра, изменение формы лица или его частей,
осветление кожи, 3D-рендер, мультипликация, иллюстрация, аэрография, изменение возраста.`;
}

/* ------------------------------------------------------------ */

app.post("/tryon", async (req, res) => {
  const { image, mime = "image/jpeg", changes = {}, tier = "standard" } = req.body || {};

  if (!KEY) return res.status(500).json({ error: "GEMINI_API_KEY не задан" });
  if (!image) return res.status(400).json({ error: "Нет изображения" });

  const model = MODELS[tier] || MODELS.standard;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mime, data: image } },
              { text: buildPrompt(changes) },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "3:4" },
        },
      }),
    });

    const data = await r.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message });
    }

    const cand = data.candidates?.[0];

    // модель может отказаться редактировать фото по своим правилам
    if (cand?.finishReason && !["STOP", "MAX_TOKENS"].includes(cand.finishReason)) {
      return res.status(422).json({ error: "Модель отклонила это фото: " + cand.finishReason });
    }

    const part = (cand?.content?.parts || []).find((p) => p.inline_data || p.inlineData);
    const blob = part?.inline_data || part?.inlineData;

    if (!blob?.data) {
      return res.status(502).json({ error: "Модель вернула ответ без изображения" });
    }

    res.json({
      image: `data:${blob.mime_type || blob.mimeType || "image/png"};base64,${blob.data}`,
    });
  } catch (e) {
    res.status(500).json({ error: "Сбой запроса: " + e.message });
  }
});

/* ------------------------------------------------------------
   Картинки-примеры. Цепочка из трёх источников:
   1. кэш          — бесплатно и мгновенно
   2. Pexels/Unsplash — настоящий поиск по ключевым словам,
                     лицензия разрешает коммерческое использование
   3. генерация    — если в стоках ничего не нашлось

   Pinterest в цепочке нет намеренно. Открытого поиска у них
   не существует, ссылки на pinimg.com защищены от вставки,
   а сами фотографии принадлежат авторам, а не вам.
   ------------------------------------------------------------ */

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

// в продакшене замените на Redis или таблицу в базе
const cache = new Map();

const REF_QUERY = {
  haircut: (d) => `${d} hairstyle woman portrait`,
  brows: (d) => `${d} eyebrows woman face closeup`,
  lips: (d) => `${d} lips makeup closeup`,
};

async function searchPexels(q) {
  if (!PEXELS_KEY) return null;
  const u = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5&orientation=portrait`;
  const r = await fetch(u, { headers: { Authorization: PEXELS_KEY } });
  if (!r.ok) return null;
  const d = await r.json();
  const p = d.photos?.[0];
  return p ? { url: p.src.large, credit: `Pexels, ${p.photographer}`, link: p.url } : null;
}

async function searchUnsplash(q) {
  if (!UNSPLASH_KEY) return null;
  const u = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=5&orientation=portrait`;
  const r = await fetch(u, { headers: { Authorization: "Client-ID " + UNSPLASH_KEY } });
  if (!r.ok) return null;
  const d = await r.json();
  const p = d.results?.[0];
  return p
    ? { url: p.urls.regular, credit: `Unsplash, ${p.user.name}`, link: p.links.html }
    : null;
}

async function generateRef(desc, kind) {
  if (!KEY) return null;
  const frame = {
    haircut: "studio beauty portrait, head and shoulders, plain light grey backdrop",
    brows: "close crop on the eye and brow area, soft even light",
    lips: "close crop on the lips, soft even light",
  }[kind] || "studio beauty portrait, plain light grey backdrop";

  const prompt = `Photorealistic reference photograph. ${frame}.
Subject: ${desc}.
Natural skin texture with visible pores, individual hair strands, realistic studio lighting.
Not an illustration, not 3D, not airbrushed, no beauty filter.
The person must be a generic model, not resembling any real or famous individual.`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.preview}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:5" } },
      }),
    }
  );
  const d = await r.json();
  if (d.error) return null;
  const part = (d.candidates?.[0]?.content?.parts || []).find((p) => p.inline_data || p.inlineData);
  const blob = part?.inline_data || part?.inlineData;
  if (!blob?.data) return null;
  return {
    url: `data:${blob.mime_type || blob.mimeType || "image/png"};base64,${blob.data}`,
    credit: "сгенерировано",
  };
}

app.post("/reference", async (req, res) => {
  const { desc, kind = "haircut" } = req.body || {};
  if (!desc) return res.status(400).json({ error: "Нет описания" });

  const key = kind + "|" + desc.toLowerCase().trim();
  if (cache.has(key)) return res.json(cache.get(key));

  const query = (REF_QUERY[kind] || REF_QUERY.haircut)(desc);

  try {
    let hit = null;
    for (const src of [searchPexels, searchUnsplash]) {
      try { hit = await src(query); } catch { hit = null; }
      if (hit) break;
    }
    if (!hit) hit = await generateRef(desc, kind);
    if (!hit) return res.status(404).json({ error: "Пример не найден" });

    const out = { image: hit.url, credit: hit.credit, link: hit.link || null };
    cache.set(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "Сбой запроса: " + e.message });
  }
});

app.listen(process.env.PORT || 8787, () => console.log("Примерка слушает порт 8787"));

/* ------------------------------------------------------------
   Что доделать до продакшена:

   1. Авторизация. Сейчас эндпоинт открыт. Проверяйте токен
      подписчицы, иначе счёт за чужие генерации оплатите вы.
   2. Лимит генераций на пользователя в месяц. Без него
      тяжёлые пользовательницы съедят маржу подписки.
   3. Кэш. Одна и та же пара «фото + набор изменений» должна
      отдаваться из хранилища, а не генерироваться заново.
   4. Удаление фото. Не храните исходники дольше, чем нужно
      для сессии. Это биометрия.
   ------------------------------------------------------------ */
