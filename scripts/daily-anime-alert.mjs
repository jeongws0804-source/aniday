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
    .map((item) => [item.name.trim(), item.name.trim()]),
).values()].sort((a, b) => a.localeCompare(b, "ko"));

const message = shows.length
  ? `오늘 라프텔 ${weekdayKorean} 편성 ${shows.length}개\n\n${shows.join("\n")}`
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

