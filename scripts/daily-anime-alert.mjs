const topic = process.env.NTFY_TOPIC;
if (!topic) throw new Error("NTFY_TOPIC is not configured");
if (!/^[A-Za-z0-9_-]{16,128}$/.test(topic)) {
  throw new Error("NTFY_TOPIC must be an unguessable 16-128 character topic name");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const now = Date.now();
const start = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
const end = start + DAY_MS;

const query = `
  query ($page: Int, $from: Int, $to: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        id airingAt episode
        media { title { english romaji native } synonyms siteUrl }
      }
    }
  }
`;

const schedules = [];
for (let page = 1; page <= 5; page += 1) {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { page, from: Math.floor(start / 1000), to: Math.floor(end / 1000) } }),
  });
  if (!response.ok) throw new Error(`AniList returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || "AniList query failed");
  const result = payload.data.Page;
  schedules.push(...result.airingSchedules);
  if (!result.pageInfo.hasNextPage) break;
}

const formatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
});
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date());
const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
const normalizeTitle = (value) => value?.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "") || "";
const koreanTitleByAlias = new Map();
try {
  const response = await fetch(`https://api.anissia.net/anime/schedule/${weekdayNumber}`);
  if (response.ok) {
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : payload.data;
    if (!Array.isArray(rows)) throw new Error("Unexpected Anissia response format");
    for (const row of rows) {
      if (!row.subject || !/[가-힣]/u.test(row.subject)) continue;
      for (const alias of [row.subject, row.originalSubject]) {
        const key = normalizeTitle(alias);
        if (key) koreanTitleByAlias.set(key, row.subject);
      }
    }
  }
} catch (error) {
  console.warn("Anissia Korean-title lookup unavailable:", error.message);
}

const lines = schedules.map((item) => {
  const aliases = [item.media.title.english, item.media.title.romaji, item.media.title.native, ...(item.media.synonyms || [])].filter(Boolean);
  const koreanAlias = aliases.find((alias) => /[가-힣]/u.test(alias));
  const mappedTitle = aliases.map((alias) => koreanTitleByAlias.get(normalizeTitle(alias))).find(Boolean);
  const title = mappedTitle || koreanAlias || item.media.title.english || item.media.title.romaji || item.media.title.native || "제목 미상";
  return `${formatter.format(new Date(item.airingAt * 1000))} · ${title} ${item.episode}화`;
});
const message = lines.length
  ? `오늘 공개 예정 애니 ${lines.length}개\n\n${lines.join("\n")}`
  : "오늘 공개 예정인 AniList 애니 편성이 없습니다.";

const encodedTitle = `=?UTF-8?B?${Buffer.from("애니데이 · 오늘의 공개 일정", "utf8").toString("base64")}?=`;
const result = await fetch(`https://ntfy.sh/${topic}`, {
  method: "POST",
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Title": encodedTitle,
    "X-Tags": "tv,calendar",
    "X-Priority": "3",
  },
  body: message,
});
if (!result.ok) throw new Error(`ntfy returned HTTP ${result.status}`);
console.log(`Sent today's schedule (${schedules.length} shows).`);

