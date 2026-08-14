const GITHUB_URLS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/urls.txt";
const GITHUB_WEBHOOKS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/webhooks.txt";

export default {
  async fetch(request, env, ctx) {
    if (!env.WOW_KV) return new Response("Error: WOW_KV Binding missing.", { status: 500 });
    const url = new URL(request.url);

    if (url.searchParams.get("sync") === "true") {
      const logs = await updateVideoFeed(env, true);
      return new Response(logs.join("\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    let feedXml = await env.WOW_KV.get("rss_feed_xml") || "<rss></rss>";
    return new Response(feedXml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateVideoFeed(env, false));
  }
};

async function fetchGitHubTextFile(fileUrl) {
  try {
    const res = await fetch(fileUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) return [];
    const text = await res.text();
    return text.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
  } catch (err) {
    return [];
  }
}

function getCurrentTimeFormatted() {
  const now = new Date();
  return now.toISOString().split('T')[1].substring(0, 8);
}

async function updateVideoFeed(env, isDiagnostic = false) {
  let logs = [];
  
  const logInfo = (msg) => logs.push(`[${getCurrentTimeFormatted()}] ${msg}`);
  const logSub = (msg) => logs.push(`    ↳ ${msg}`);

  logInfo("=== 🚀 ULTRA PRO MAX PIPELINE STARTED ===");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive"
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  const webhookUrls = await fetchGitHubTextFile(GITHUB_WEBHOOKS_RAW);

  let seenIds = (await env.WOW_KV.get("seen_ids", "json")) || [];
  let existingItems = (await env.WOW_KV.get("feed_items", "json")) || [];
  let newlyFetchedItems = [];

  let videosSentThisRun = 0;
  const TARGET_SEND_COUNT = 1; 
  const MAX_PAGES_TO_SCAN = 20; // දැන් පිටු 20ක් දක්වා පස්සට බලනවා (තත්පර 30 ඇතුළත)

  logInfo(`📊 Database: කලින් යැවූ වීඩියෝ ගණන (seen_ids): ${seenIds.length}`);

  for (const rawUrl of targetPages) {
    if (videosSentThisRun >= TARGET_SEND_COUNT) break; 

    // URL එක පිරිසිදු කර ගැනීම (ඔයා urls.txt එකේ කොහොම දුන්නත් මේක ඔටෝ හැදෙනවා)
    let baseUrl = rawUrl.replace(/\/index\/page-\d+\.html/i, "").replace(/\/$/, "");

    for (let pageNum = 1; pageNum <= MAX_PAGES_TO_SCAN; pageNum++) {
      if (videosSentThisRun >= TARGET_SEND_COUNT) break; 

      let currentPageUrl = `${baseUrl}/index/page-${pageNum}.html`;
      logInfo(`\n📑 [PAGE ${pageNum}] අලුත් වීඩියෝ සොයමින් පවතී: ${currentPageUrl}`);
      
      try {
        const res = await fetch(currentPageUrl, { headers });
        if (!res.ok) {
          logSub(`❌ Page Error: ${res.status} (පිටුව නොපවතී. ඊළඟ URL එකට යයි...)`);
          break; 
        }
        
        const html = await res.text();
        const allLinksMatch = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)];
        let videoUrls = [];
        
        for (const match of allLinksMatch) {
          let link = match[1];
          let idMatch = link.match(/\/video\/(\d+)/i) || link.match(/\/(\d{3,})/);
          if (!idMatch) continue;
          
          let videoId = idMatch[1];
          if(link.match(/\.(jpg|png|css|js|ico)$/i)) continue;
          if(link.match(/(new|popular|top|categories|login|signup|tags|page-|models|xxx|\/search\/)/i)) continue; 
          if(link === "/" || link === "#" || link.startsWith("javascript")) continue;

          try {
            const origin = new URL(currentPageUrl).origin;
            const fullUrl = link.startsWith("http") ? link : new URL(link, origin).href;
            if (!videoUrls.some(v => v.url === fullUrl)) {
              videoUrls.push({ id: videoId, url: fullUrl });
            }
          } catch(e) {}
        }

        if (videoUrls.length === 0) {
          logSub(`⚠️ මෙම පිටුවේ වීඩියෝ කිසිවක් හමු නොවීය. ස්කෑන් කිරීම නවත්වයි.`);
          break;
        }

        logSub(`🔍 Page ${pageNum} තුළින් වීඩියෝ ලින්ක් ${videoUrls.length} ක් සොයාගන්නා ලදී.`);

        for (const video of videoUrls) {
          if (videosSentThisRun >= TARGET_SEND_COUNT) break;

          // පරණ වීඩියෝ තත්පරයෙන් අයින් කරන තැන (Network Fetch වෙන්නේ නෑ!)
          if (seenIds.includes(video.id)) {
            continue; // Log එකක්වත් දාන්නේ නෑ වේගය වැඩි කරන්න. කෙලින්ම Skip කරනවා.
          }
          
          logInfo(`▶️ අලුත් Video එකක් හමුවුණා! Inspecting ID [${video.id}]`);
          
          try {
            logSub(`⏳ අලුත් URL එක Fetch කරයි...`);
            const vRes = await fetch(video.url, { headers });
            
            if (!vRes.ok) continue;

            const vHtml = await vRes.text();
            const vTitleMatch = vHtml.match(/<title[^>]*>(.*?)<\/title>/i) || vHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
            const vTitle = vTitleMatch ? vTitleMatch[1].replace(/<[^>]+>/g, '').trim() : `Video ${video.id}`;

            let thumbMatch = vHtml.match(/<meta\s+(?:property|name)=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i) ||
                             vHtml.match(/poster=["']([^"']+)["']/i) || 
                             vHtml.match(/<img[^>]+(?:class|id)=["'][^"']*(?:thumb|poster)[^"']*["'][^>]+src=["']([^"']+)["']/i);
                             
            let thumbnailUrl = thumbMatch ? thumbMatch[1] : null;

            if (thumbnailUrl) {
              thumbnailUrl = thumbnailUrl.replace(/&amp;/g, '&');
              if (!thumbnailUrl.startsWith("http")) {
                 const pageOrigin = new URL(video.url).origin;
                 thumbnailUrl = thumbnailUrl.startsWith("/") ? pageOrigin + thumbnailUrl : pageOrigin + "/" + thumbnailUrl;
              }
            }

            let finalMp4 = null;
            let cleanMp4Match = vHtml.match(/(\.\/common\/loadvideo\/[0-9]+\.mp4\?[^"'\s,]+)/i);

            if (cleanMp4Match && cleanMp4Match[1]) {
               let matchedRawUrl = cleanMp4Match[1].replace(/&amp;/g, '&');
               let pageOrigin = new URL(video.url).origin;
               let cleanPath = matchedRawUrl.replace(/^\.\//, '/');
               let loadVideoUrl = pageOrigin + cleanPath;

               try {
                 const headRes = await fetch(loadVideoUrl, {
                   method: "GET",
                   headers: { ...headers, "Range": "bytes=0-0" },
                   redirect: "follow"
                 });
                 if (headRes.url && headRes.url.includes(".mp4")) {
                   finalMp4 = headRes.url;
                 } else {
                   finalMp4 = loadVideoUrl;
                 }
               } catch (err) {
                 finalMp4 = loadVideoUrl; 
               }

               let messageContent = `🔔 **<@&1418013942730457158>**\n`;
               if (thumbnailUrl) {
                 messageContent += `${thumbnailUrl}\n`;
               }
               messageContent += `🔗 ${finalMp4}`;

               const discordPayload = { content: messageContent };
               let isSuccessfullySent = false;

               for (const wUrl of webhookUrls) {
                 if (wUrl.trim()) {
                   try {
                     const discordRes = await fetch(wUrl.trim(), {
                       method: "POST",
                       headers: { "Content-Type": "application/json" },
                       body: JSON.stringify(discordPayload)
                     });
                     if (discordRes.ok) {
                       logSub(`✅ [DISCORD] සාර්ථකයි!`);
                       isSuccessfullySent = true;
                     }
                   } catch (err) {}
                 }
               }

               if (isSuccessfullySent) {
                 const newItem = {
                   id: video.id,
                   title: vTitle,
                   pageUrl: video.url,
                   directUrl: finalMp4,
                   pubDate: new Date().toUTCString()
                 };

                 newlyFetchedItems.push(newItem);
                 seenIds.push(video.id);
                 videosSentThisRun++; 
                 logInfo(`🌟 Database Update කර ක්‍රියාවලිය නවත්වයි.`);
                 break; 
               }
            }
          } catch (e) {}
        } 

        if (videosSentThisRun === 0) {
            logInfo(`🔄 Page ${pageNum} හි ඇති සියලුම වීඩියෝ යවා අවසන්. ඊළඟ පිටුවට යයි...`);
        }

      } catch (err) {}
    } 
  } 

  if (newlyFetchedItems.length > 0) {
    existingItems = [...newlyFetchedItems, ...existingItems].slice(0, 50); 
    
    // 🔥 මෙතන තමයි වැදගත්ම වෙනස! දැන් අන්තිම වීඩියෝ 5000ක්ම මතක තියාගන්නවා (කලින් තිබ්බේ 1000යි)
    if (seenIds.length > 5000) seenIds = seenIds.slice(seenIds.length - 5000); 

    await env.WOW_KV.put("seen_ids", JSON.stringify(seenIds));
    await env.WOW_KV.put("feed_items", JSON.stringify(existingItems));
  }

  const rssXml = generateRssXml(existingItems);
  await env.WOW_KV.put("rss_feed_xml", rssXml);

  logInfo(`=== 🏁 PIPELINE FINISHED ===`);
  return logs;
}

function generateRssXml(items) {
  const rssItems = items.map(item => {
    return `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.pageUrl}</link>
      <guid isPermaLink="false">${item.id}</guid>
      <pubDate>${item.pubDate}</pubDate>
      <enclosure url="${item.directUrl.replace(/&/g, '&amp;')}" type="video/mp4" />
      <description><![CDATA[Direct Video Link: <a href="${item.directUrl}">${item.directUrl}</a>]]></description>
    </item>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Direct Video RSS Feed</title>
    <link>https://github.com</link>
    <description>Auto-updated RSS feed</description>
    <language>en</language>
    ${rssItems}
  </channel>
</rss>`;
            }
