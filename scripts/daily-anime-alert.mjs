const topic = process.env.NTFY_TOPIC;
if (!topic) throw new Error("NTFY_TOPIC is not configured");
if (!/^[A-Za-z0-9_-]{16,64}$/.test(topic)) {
  throw new Error("NTFY_TOPIC must be an unguessable 16-64 character topic name");
}

const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date());
const weekdayKorean = {
  Sun: "일요일", Mon: "월요일", Tue: "화요일", Wed: "수요일",
  Thu: "목요일", Fri: "금요일", Sat: "토요일",
}[weekday];
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).formatToParts(new Date());
const datePart = (type) => dateParts.find((part) => part.type === type)?.value || "00";
const todayKst = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
const laftelHeaders = { Accept: "application/json", laftel: "TeJava" };
const anissiaWeekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];

let source = "Laftel";
let shows;
let laftelError;
try {
  const response = await fetch("https://laftel.net/api/search/v2/daily", { headers: laftelHeaders });
  if (!response.ok) throw new Error(`Laftel returned HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.results || payload.data || [];
  if (!Array.isArray(rows)) throw new Error("Unexpected Laftel daily schedule response");
  shows = [...new Map(
    rows
      .filter((item) => item?.name && item.distributed_air_time === weekdayKorean && item.is_expired !== true)
      .map((item) => [item.id, { source: "Laftel", id: item.id, name: item.name, time: item.latest_published_datetime?.split("T")[1]?.slice(0, 5) }]),
  ).values()];
} catch (error) {
  laftelError = error;
  console.warn("Laftel schedule unavailable; falling back to Anissia:", error.message);
  const response = await fetch(`https://api.anissia.net/anime/schedule/${anissiaWeekday}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Laftel failed (${error.message}); Anissia returned HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Unexpected Anissia schedule response");
  source = "Anissia";
  shows = [...new Map(
    rows.filter((item) => item?.subject && item.status === "ON")
      .map((item) => [item.animeNo, { source, id: item.animeNo, name: item.subject, time: item.time }]),
  ).values()];
}
shows.sort((a, b) => a.name.localeCompare(b.name, "ko"));

async function episodesForToday(show) {
  if (show.source === "Anissia") {
    const response = await fetch(`https://api.anissia.net/anime/caption/animeNo/${encodeURIComponent(show.id)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Anissia caption response HTTP ${response.status}`);
    const captions = await response.json();
    if (!Array.isArray(captions)) throw new Error("Unexpected Anissia caption response");
    return captions.filter((caption) => caption?.updDt?.slice(0, 10) === todayKst)
      .sort((a, b) => (a.updDt || "").localeCompare(b.updDt || ""))
      .map((caption) => ({ episode_num: caption.episode, published_datetime: caption.updDt?.replace(" ", "T") }));
  }
  let next = `https://laftel.net/api/episodes/v2/list?item_id=${encodeURIComponent(show.id)}`;
  const episodes = [];
  for (let page = 0; next && page < 10; page += 1) {
    const pageUrl = new URL(next, "https://laftel.net");
    if (pageUrl.hostname !== "laftel.net") throw new Error("Unexpected Laftel pagination host");
    const pageResponse = await fetch(pageUrl, { headers: laftelHeaders });
    if (!pageResponse.ok) throw new Error(`Laftel episode response HTTP ${pageResponse.status}`);
    const pageData = await pageResponse.json();
    const pageRows = Array.isArray(pageData) ? pageData : pageData.results || pageData.data || [];
    if (!Array.isArray(pageRows)) throw new Error("Unexpected Laftel episode response");
    episodes.push(...pageRows.filter((episode) => episode?.published_datetime?.slice(0, 10) === todayKst));
    next = pageData.next || null;
  }
  return episodes.sort((a, b) => (a.episode_order || 0) - (b.episode_order || 0));
}

const showLines = [];
for (let index = 0; index < shows.length; index += 4) {
  const batch = await Promise.all(shows.slice(index, index + 4).map(async (show) => {
    try {
      const episodes = await episodesForToday(show);
      if (episodes.length) {
        return episodes.map((episode) => {
          const rawNumber = String(episode.episode_num || "").trim();
          const episodeLabel = /^\d+(?:\.\d+)?$/.test(rawNumber) ? `${rawNumber}화` : (rawNumber === "0" ? "단편" : rawNumber);
          const time = show.source === "Anissia" ? show.time : episode.published_datetime?.split("T")[1]?.slice(0, 5);
          const captionNote = show.source === "Anissia" ? " (자막 등록 기준)" : "";
          return `${time ? `${time} · ` : ""}${show.name}${episodeLabel ? ` ${episodeLabel}` : ""}${captionNote}`;
        });
      }
      if (show.source === "Anissia") return [`${show.time || "시간 미정"} · ${show.name} · 회차 미정`];
    } catch (error) {
      console.warn(`${show.source} episode lookup failed (${show.id}):`, error.message);
    }
    return [`${show.time ? `${show.time} · ` : ""}${show.name} · 회차/시각 미정`];
  }));
  showLines.push(...batch.flat());
}

const message = shows.length
  ? `오늘 ${source} ${weekdayKorean} 편성 ${shows.length}개${laftelError ? " (라프텔 연결 대체 조회)" : ""}\n\n${showLines.join("\n")}`
  : `오늘(${weekdayKorean}) ${source} 편성 정보가 없습니다.`;

const encodedTitle = `=?UTF-8?B?${Buffer.from("애니데이 · 라프텔 오늘 편성", "utf8").toString("base64")}?=`;
const result = await fetch(`https://ntfy.sh/${topic}`, {
  method: "POST",
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Title": encodedTitle,
    "X-Tags": "tv,calendar",
    "X-Priority": "3",
    "X-Click": "https://laftel.net/daily",
  },
  body: message,
});
if (!result.ok) throw new Error(`ntfy returned HTTP ${result.status}`);
console.log(`Sent Laftel ${weekdayKorean} lineup (${shows.length} shows).`);

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
if (telegramToken && telegramChatId) {
  const telegramResponse = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: telegramChatId, text: message }),
  });
  const telegramResult = await telegramResponse.json();
  if (!telegramResponse.ok || telegramResult.ok !== true) {
    throw new Error(`Telegram returned HTTP ${telegramResponse.status}: ${telegramResult.description || "unknown error"}`);
  }
  console.log("Sent Laftel lineup to Telegram.");
} else {
  console.warn("Telegram secrets are not configured; skipped Telegram delivery.");
}
