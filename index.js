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

async function updateVideoFeed(env, isDiagnostic = false) {
  let logs = [];
  logs.push("=== 🕵️ FULL PIPELINE & DISCORD LOG TEST ===");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9"
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  const webhookUrls = await fetchGitHubTextFile(GITHUB_WEBHOOKS_RAW);

  logs.push(`1. GitHub Target URLs: ${targetPages.length}`);
  logs.push(`2. GitHub Webhooks: ${webhookUrls.length}`);

  let seenIds = (await env.WOW_KV.get("seen_ids", "json")) || [];
  let existingItems = (await env.WOW_KV.get("feed_items", "json")) || [];
  let newlyFetchedItems = [];

  for (const latestPageUrl of targetPages) {
    try {
      const res = await fetch(latestPageUrl, { headers });
      const html = await res.text();
      
      const allLinksMatch = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)];
      let videoUrls = [];
      
      for (const match of allLinksMatch) {
        let link = match[1];
        
        if(link.match(/\.(jpg|png|css|js|ico)$/i)) continue;
        if(link.match(/(new|popular|top|categories|login|signup|tags|page-|models|xxx|\/search\/|watch-later|watch-history|\/my\/)/i)) continue; 
        if(link === "/" || link === "#" || link.startsWith("javascript")) continue;

        let idMatch = link.match(/\/video\/(\d+)/i) || link.match(/-(xh[a-zA-Z0-9]+)(?:\/)?$/i) || link.match(/\/(\d{3,})/);
        if (!idMatch) continue;
        
        let videoId = idMatch[1] || idMatch[2];
        if (!videoId) continue;

        try {
          const origin = new URL(latestPageUrl).origin;
          const fullUrl = link.startsWith("http") ? link : new URL(link, origin).href;
          
          if (!videoUrls.some(v => v.url === fullUrl)) {
            videoUrls.push({ id: videoId, url: fullUrl });
          }
        } catch(e){}
      }

      logs.push(`   🔍 Video පිටු ${videoUrls.length} ක් හොයාගත්තා.`);

      let testUrls = videoUrls.slice(0, 3);

      for (const video of testUrls) {
        logs.push(`\n   ▶️ Video ID [${video.id}] Check කරනවා: ${video.url}`);

        if (seenIds.includes(video.id)) {
          logs.push(`      ⏩ මේ වීඩියෝ එක මීට පෙර යවා ඇත (Skipped).`);
          continue;
        }
        
        try {
          const vRes = await fetch(video.url, { headers });
          const vHtml = await vRes.text();
          
          // පිටුව සාර්ථකව ආවද, නැත්නම් බ්ලොක් වුණාද කියලා බලාගන්න Status එක ලොග් කරමු
          logs.push(`      📄 HTTP Status: ${vRes.status}`);
          
          const vTitleMatch = vHtml.match(/<title[^>]*>(.*?)<\/title>/i) || vHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
          const vTitle = vTitleMatch ? vTitleMatch[1].replace(/<[^>]+>/g, '').trim() : `Video ${video.id}`;
          
          logs.push(`      🏷️ Title: ${vTitle}`);

          let finalMp4 = null;
          
          // JSON escaping අයින් කිරීම (උදා: \/ -> /)
          let decodedHtml = vHtml.replace(/\\\//g, '/');
          
          // 1. අලුත් සයිට් එකෙන් .m3u8 Link එක හොයන Regex එක
          let m3u8Match = decodedHtml.match(/(https:\/\/[^"'\s<>]+\.m3u8)/i);
          
          // 2. m3u8 නැත්නම් mp4 එකක් තියෙනවද බලන Fallback එක
          let fallbackMp4Match = decodedHtml.match(/(https:\/\/[^"'\s<>]+\.mp4)/i);

          // 3. පරණ සයිට් එකෙන් loadvideo mp4 Link එක හොයන Regex එක
          let cleanMp4Match = decodedHtml.match(/(\.\/common\/loadvideo\/[0-9]+\.mp4\?[^"'\s,]+)/i);

          if (m3u8Match && m3u8Match[1]) {
             let m3u8Link = m3u8Match[1];
             finalMp4 = m3u8Link.replace(/\.m3u8.*$/i, '');
             logs.push(`      🎯 Final Direct CDN Link (m3u8 stripped): ${finalMp4}`);
             
          } else if (cleanMp4Match && cleanMp4Match[1]) {
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

             logs.push(`      🎯 Final Direct CDN Link: ${finalMp4}`);

          } else if (fallbackMp4Match && fallbackMp4Match[1]) {
             // xHamster CDN (xhcdn) ලින්ක් එකක් නම් විතරක් ගන්නවා
             if (fallbackMp4Match[1].includes('xhcdn')) {
                 finalMp4 = fallbackMp4Match[1];
                 logs.push(`      🎯 Final Direct CDN Link (mp4 fallback): ${finalMp4}`);
             }
          }

          if (finalMp4) {
             const newItem = {
               id: video.id,
               title: vTitle,
               pageUrl: video.url,
               directUrl: finalMp4,
               pubDate: new Date().toUTCString()
             };

             newlyFetchedItems.push(newItem);
             seenIds.push(video.id);

             logs.push(`      📤 [DISCORD] Webhooks වෙත යැවීමට සූදානම්...`);
             
             const discordPayload = {
               content: `🎬 **<@&885869329730637866>**\n🔗 ${finalMp4}`
             };

             for (const wUrl of webhookUrls) {
               if (wUrl.trim()) {
                 try {
                   const discordRes = await fetch(wUrl.trim(), {
                     method: "POST",
                     headers: { "Content-Type": "application/json" },
                     body: JSON.stringify(discordPayload)
                   });
                   if (discordRes.ok) {
                     logs.push(`      ✅ [DISCORD] සාර්ථකව Discord වෙත යවන ලදී!`);
                   } else {
                     logs.push(`      ❌ [DISCORD] යැවීම අසාර්ථකයි (Status: ${discordRes.status})`);
                   }
                 } catch (err) {
                   logs.push(`      ❌ [DISCORD Error]: ${err.message}`);
                 }
               }
             }

          } else {
             logs.push(`      ❌ Direct MP4 හෝ m3u8 හොයාගන්න බැරි වුණා.`);
          }

        } catch (e) {
          logs.push(`      ❌ Video පිටුවට යන්න බැරි වුණා: ${e.message}`);
        }
      }
    } catch (err) {
      logs.push(`❌ Main Page Fetch Error: ${err.message}`);
    }
  }

  if (newlyFetchedItems.length > 0) {
    existingItems = [...newlyFetchedItems, ...existingItems].slice(0, 50);
    if (seenIds.length > 500) seenIds = seenIds.slice(seenIds.length - 500);

    await env.WOW_KV.put("seen_ids", JSON.stringify(seenIds));
    await env.WOW_KV.put("feed_items", JSON.stringify(existingItems));
  }

  const rssXml = generateRssXml(existingItems);
  await env.WOW_KV.put("rss_feed_xml", rssXml);

  logs.push(`\n=== 🏁 PIPELINE COMPLETED. New Videos Processed: ${newlyFetchedItems.length} ===`);
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
