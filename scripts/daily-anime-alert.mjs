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

const response = await fetch("https://laftel.net/api/search/v2/daily", {
  headers: { Accept: "application/json", laftel: "TeJava" },
});
if (!response.ok) throw new Error(`Laftel returned HTTP ${response.status}`);

const payload = await response.json();
const rows = Array.isArray(payload) ? payload : payload.results || payload.data || [];
if (!Array.isArray(rows)) throw new Error("Unexpected Laftel daily schedule response");

const shows = [...new Map(
  rows
    .filter((item) => item?.name && item.distributed_air_time === weekdayKorean && item.is_expired !== true)
    .map((item) => [item.id, item]),
).values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

async function episodesForToday(show) {
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
          const episodeLabel = /^\d+(?:\.\d+)?$/.test(rawNumber) ? `${rawNumber}화` : rawNumber;
          const time = episode.published_datetime?.split("T")[1]?.slice(0, 5);
          return `${time ? `${time} · ` : ""}${show.name}${episodeLabel ? ` ${episodeLabel}` : ""}`;
        });
      }
    } catch (error) {
      console.warn(`Laftel episode lookup failed (${show.id}):`, error.message);
    }
    return [`${show.name} · 회차/시각 미정`];
  }));
  showLines.push(...batch.flat());
}

const message = shows.length
  ? `오늘 라프텔 ${weekdayKorean} 편성 ${shows.length}개\n\n${showLines.join("\n")}`
  : `오늘(${weekdayKorean}) 라프텔 편성 정보가 없습니다.`;

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

