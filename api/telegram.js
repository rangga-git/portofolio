// File ini adalah "penerima pesan" untuk bot Telegram-mu.
// Alurnya: Telegram -> file ini -> Gemini -> balasan kembali ke Telegram.
//
// Kunci rahasia TIDAK ditulis di sini. Semuanya diambil dari
// "Environment Variables" di Vercel (kita isi di tahap berikutnya):
//   TELEGRAM_BOT_TOKEN       = token dari BotFather
//   GEMINI_API_KEY           = kunci dari Google AI Studio
//   TELEGRAM_WEBHOOK_SECRET  = kata sandi kedua (kamu karang sendiri)
//   ALLOWED_USER_ID          = nomor ID Telegram milikmu

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALLOWED = process.env.ALLOWED_USER_ID;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Fungsi: kirim pesan ke Telegram
async function kirimPesan(chatId, teks) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: teks.slice(0, 4000) }),
  });
}

// Fungsi: bertanya ke otak Gemini
async function tanyaGemini(pertanyaan) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: "Kamu adalah asisten pribadi yang ramah. Jawab dalam bahasa Indonesia yang jelas dan singkat." }],
      },
      contents: [{ role: "user", parts: [{ text: pertanyaan }] }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    return "Maaf, otak AI sedang bermasalah: " + (data.error?.message || res.status);
  }
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "(Tidak ada jawaban)";
}

// Bagian utama: dijalankan setiap ada pesan masuk dari Telegram
module.exports = async (req, res) => {
  try {
    // Satpam 1: pastikan pesan benar-benar dari Telegram
    if (req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
      return res.status(401).send("Tidak diizinkan");
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
      await kirimPesan(chatId, "Halo Grow! Bot sudah aktif. Kirim pertanyaan apa saja.");
      return res.status(200).send("ok");
    }

    const jawaban = await tanyaGemini(teks);
    await kirimPesan(chatId, jawaban);
    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    return res.status(200).send("ok");
  }
};
