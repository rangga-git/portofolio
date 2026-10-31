// File ini adalah "penerima pesan" untuk bot Telegram-mu.
// Alurnya: Telegram -> file ini -> Gemini -> balasan kembali ke Telegram.
//
// Kunci rahasia TIDAK ditulis di sini. Semuanya diambil dari
// "Environment Variables" di Vercel:
//   TELEGRAM_BOT_TOKEN       = token dari BotFather
//   GEMINI_API_KEY           = kunci dari Google AI Studio
//   TELEGRAM_WEBHOOK_SECRET  = kata sandi kedua (kamu karang sendiri)
//   ALLOWED_USER_ID          = nomor ID Telegram milikmu
//   GEMINI_MODEL             = model utama (contoh: gemini-3.8-flash)
//   GEMINI_FALLBACK_MODEL    = model cadangan (boleh tidak diisi)

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALLOWED = process.env.ALLOWED_USER_ID;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || "gemini-3-flash-preview";

// Catatan pesan yang sudah diproses, supaya kiriman ulang dari Telegram diabaikan
const sudahDiproses = new Set();

const PETUNJUK_BIASA =
  "Kamu adalah asisten pribadi yang ramah. Jawab dalam bahasa Indonesia yang jelas dan singkat.";
const PETUNJUK_RISET =
  "Kamu adalah asisten riset. Cari informasi terbaru di internet, lalu rangkum dalam bahasa Indonesia yang jelas dengan poin-poin singkat. Jangan mengarang. Kalau informasinya tidak ditemukan atau tidak pasti, katakan terus terang.";

async function kirimPesan(chatId, teks) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: teks.slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
}

// Menampilkan tulisan "sedang mengetik..." di Telegram
async function kirimMengetik(chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch (e) {
    // tidak penting, abaikan
  }
}

// Bertanya ke satu model Gemini. Kalau riset = true, Gemini boleh mencari di Google.
async function tanyaSatuModel(model, pertanyaan, riset, batasWaktu) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const isi = {
    systemInstruction: {
      parts: [{ text: riset ? PETUNJUK_RISET : PETUNJUK_BIASA }],
    },
    contents: [{ role: "user", parts: [{ text: pertanyaan }] }],
  };
  if (riset) {
    isi.tools = [{ google_search: {} }];
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY,
    },
    body: JSON.stringify(isi),
    signal: AbortSignal.timeout(batasWaktu),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Mengambil daftar sumber dari hasil pencarian Google (maksimal 5)
function ambilSumber(data) {
  const potongan = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const daftar = [];
  const sudahAda = new Set();
  for (const p of potongan) {
    const alamat = p.web?.uri;
    if (alamat && !sudahAda.has(alamat)) {
      sudahAda.add(alamat);
      daftar.push(`${daftar.length + 1}. ${p.web.title || "Sumber"}\n${alamat}`);
    }
    if (daftar.length >= 5) break;
  }
  return daftar;
}

// Mencoba model utama dulu, kalau sibuk atau lambat pindah ke model cadangan
async function tanyaGemini(pertanyaan, riset) {
  // Riset butuh waktu lebih lama, jadi hanya satu percobaan dengan batas 25 detik
  const daftarModel = [MODEL];
  if (!riset && FALLBACK && FALLBACK !== MODEL) daftarModel.push(FALLBACK);
  const batasWaktu = riset ? 25000 : 12000;

  let pesanTerakhir = "tidak diketahui";
  for (const model of daftarModel) {
    try {
      const hasil = await tanyaSatuModel(model, pertanyaan, riset, batasWaktu);
      if (hasil.ok) {
        let teks = hasil.data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
        teks = teks || "(Tidak ada jawaban)";
        if (riset) {
          const sumber = ambilSumber(hasil.data);
          if (sumber.length > 0) {
            teks = teks.slice(0, 3000) + "\n\nSumber:\n" + sumber.join("\n");
          }
        }
        return teks;
      }
      pesanTerakhir = hasil.data.error?.message || String(hasil.status);
      if (![429, 500, 503, 504].includes(hasil.status)) break;
    } catch (e) {
      pesanTerakhir = "Gemini terlalu lama menjawab";
    }
  }
  return "Maaf, otak AI sedang sibuk atau bermasalah. Coba lagi sebentar lagi. (" + pesanTerakhir + ")";
}

module.exports = async (req, res) => {
  try {
    // Satpam 1: pastikan pesan benar-benar dari Telegram
    if (req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
      return res.status(401).send("Tidak diizinkan");
    }

    // Abaikan pesan yang sudah pernah diproses (kiriman ulang dari Telegram)
    const updateId = req.body && req.body.update_id;
    if (updateId !== undefined) {
      if (sudahDiproses.has(updateId)) {
        return res.status(200).send("ok");
      }
      sudahDiproses.add(updateId);
      if (sudahDiproses.size > 200) {
        sudahDiproses.delete(sudahDiproses.values().next().value);
      }
    }

    const pesan = req.body && req.body.message;
    if (!pesan || !pesan.text) {
      return res.status(200).send("ok");
    }

    const chatId = pesan.chat.id;
    const userId = String(pesan.from.id);
    const teks = pesan.text.trim();

    // Perintah /id: menampilkan nomor ID-mu (aman, boleh siapa saja)
    if (teks === "/id") {
      await kirimPesan(chatId, "ID Telegram kamu: " + userId);
      return res.status(200).send("ok");
    }

    // Satpam 2: hanya pemilik yang boleh memberi perintah
    if (!ALLOWED || userId !== ALLOWED) {
      await kirimPesan(chatId, "Maaf, bot ini hanya untuk pemiliknya.");
      return res.status(200).send("ok");
    }

    if (teks === "/start") {
      await kirimPesan(
        chatId,
        "Halo Grow! Bot sudah aktif.\n\nKirim pertanyaan biasa untuk dijawab langsung.\nKetik /riset diikuti topik untuk mencari di internet.\nContoh: /riset perkembangan teknologi baterai terbaru"
      );
      return res.status(200).send("ok");
    }

    // Perintah /riset: mencari di internet lalu merangkum
    const awalRiset = teks.match(/^\/riset(@\w+)?(\s+([\s\S]*))?$/i);
    if (awalRiset) {
      const topik = (awalRiset[3] || "").trim();
      if (!topik) {
        await kirimPesan(chatId, "Tulis topiknya setelah /riset.\nContoh: /riset perkembangan teknologi baterai terbaru");
        return res.status(200).send("ok");
      }
      await kirimMengetik(chatId);
      const hasilRiset = await tanyaGemini(topik, true);
      await kirimPesan(chatId, hasilRiset);
      return res.status(200).send("ok");
    }

    await kirimMengetik(chatId);
    const jawaban = await tanyaGemini(teks, false);
    await kirimPesan(chatId, jawaban);
    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    return res.status(200).send("ok");
  }
};
