const GITHUB_URLS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/urls.txt";
const GITHUB_WEBHOOKS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/webhooks.txt";

export default {
  async fetch(request, env, ctx) {
    if (!env.WOW_KV) return new Response("Error: WOW_KV Binding missing. Please configure KV namespace.", { status: 500 });
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

// GitHub වල ඇති Text ෆයිල් කියවීමේ විශේෂිත Function එක
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

// Logging සඳහා වෙලාව ලබාගන්නා Function එක
function getCurrentTimeFormatted() {
  const now = new Date();
  return now.toISOString().split('T')[1].substring(0, 8); // උදා: "10:25:30"
}

// ප්‍රධාන ක්‍රියාවලිය (Main Pipeline)
async function updateVideoFeed(env, isDiagnostic = false) {
  let logs = [];
  
  // Custom Logger එක
  const logInfo = (msg) => logs.push(`[${getCurrentTimeFormatted()}] ${msg}`);
  const logSub = (msg) => logs.push(`    ↳ ${msg}`);

  logInfo("=== 🚀 ULTRA PRO MAX PIPELINE STARTED ===");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive"
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  const webhookUrls = await fetchGitHubTextFile(GITHUB_WEBHOOKS_RAW);

  logInfo(`⚙️ System Check: Targeted URLs: ${targetPages.length} | Webhooks: ${webhookUrls.length}`);

  let seenIds = (await env.WOW_KV.get("seen_ids", "json")) || [];
  let existingItems = (await env.WOW_KV.get("feed_items", "json")) || [];
  let newlyFetchedItems = [];

  // මෙම Refresh එකේදී යැවූ වීඩියෝ ගණන (අපිට අවශ්‍ය 1ක් පමණි)
  let videosSentThisRun = 0;
  const TARGET_SEND_COUNT = 1; 

  logInfo(`📊 Database Check: කලින් යැවූ වීඩියෝ ගණන (seen_ids): ${seenIds.length}`);

  for (const latestPageUrl of targetPages) {
    if (videosSentThisRun >= TARGET_SEND_COUNT) break; // අවශ්‍ය ප්‍රමාණය යවා ඇත්නම් පිටු පිරික්සීම නවත්වයි

    logInfo(`🌐 Fetching Main Page: ${latestPageUrl}`);
    
    try {
      const res = await fetch(latestPageUrl, { headers });
      if (!res.ok) {
        logSub(`❌ Main Page HTTP Error: ${res.status} ${res.statusText}`);
        continue;
      }
      
      const html = await res.text();
      const allLinksMatch = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)];
      let videoUrls = [];
      
      // ලින්ක් එකතු කිරීම සහ ෆිල්ටර් කිරීම
      for (const match of allLinksMatch) {
        let link = match[1];
        
        let idMatch = link.match(/\/video\/(\d+)/i) || link.match(/\/(\d{3,})/);
        if (!idMatch) continue;
        
        let videoId = idMatch[1];

        if(link.match(/\.(jpg|png|css|js|ico)$/i)) continue;
        if(link.match(/(new|popular|top|categories|login|signup|tags|page-|models|xxx|\/search\/)/i)) continue; 
        if(link === "/" || link === "#" || link.startsWith("javascript")) continue;

        try {
          const origin = new URL(latestPageUrl).origin;
          const fullUrl = link.startsWith("http") ? link : new URL(link, origin).href;
          
          if (!videoUrls.some(v => v.url === fullUrl)) {
            videoUrls.push({ id: videoId, url: fullUrl });
          }
        } catch(e) {}
      }

      logInfo(`🔍 Analysis: පිටුව තුළින් අලුත් වීඩියෝ ලින්ක් ${videoUrls.length} ක් සොයාගන්නා ලදී.`);

      // --------------------------------------------------------------------------------
      // ULTRA PRO MAX: එකින් එක පරීක්ෂා කිරීමේ මෙහෙයුම (Loop through ALL videos until 1 is sent)
      // --------------------------------------------------------------------------------
      for (const video of videoUrls) {
        if (videosSentThisRun >= TARGET_SEND_COUNT) {
          logInfo(`🛑 SUCCESS: අවශ්‍ය වීඩියෝ ප්‍රමාණය (1) සාර්ථකව යවා ඇති බැවින් Search එක නවත්වයි.`);
          break; // වීඩියෝ 1ක් යැවූ පසු මුළු ක්‍රියාවලියම නවතී
        }

        logInfo(`▶️ Inspecting Video ID [${video.id}]`);

        // කලින් යවා ඇත්නම් Skip කරයි
        if (seenIds.includes(video.id)) {
          logSub(`⏩ Status: Alredy Sent (Skip කරන ලදී). ඊළඟ වීඩියෝවට යයි...`);
          continue;
        }
        
        try {
          logSub(`⏳ URL එක Fetch කරයි: ${video.url}`);
          const vRes = await fetch(video.url, { headers });
          
          if (!vRes.ok) {
            logSub(`❌ HTTP Error: Page load අසාර්ථකයි (Status: ${vRes.status})`);
            continue;
          }

          const vHtml = await vRes.text();
          
          const vTitleMatch = vHtml.match(/<title[^>]*>(.*?)<\/title>/i) || vHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
          const vTitle = vTitleMatch ? vTitleMatch[1].replace(/<[^>]+>/g, '').trim() : `Video ${video.id}`;
          logSub(`🏷️ Title: ${vTitle}`);

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
               finalMp4 = loadVideoUrl; // Fetch failed, fallback to raw loadUrl
             }

             logSub(`🎯 MP4 Extracted: ${finalMp4}`);

             // Discord Message යැවීම
             logInfo(`📤 [DISCORD] Payload සූදානම් කර Webhooks වෙත යවමින් පවතී...`);
             
             const discordPayload = {
               content: `🎬 **<@&1418013942730457158>**\n🔗 ${finalMp4}`
             };

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
                     logSub(`✅ [DISCORD] සාර්ථකයි! (Status: ${discordRes.status})`);
                     isSuccessfullySent = true;
                   } else {
                     logSub(`❌ [DISCORD] අසාර්ථකයි (Status: ${discordRes.status})`);
                   }
                 } catch (err) {
                   logSub(`❌ [DISCORD NETWORK ERROR]: ${err.message}`);
                 }
               }
             }

             // Discord යැවීම සාර්ථක නම් පමණක් Database එකට Add කිරීම
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
               videosSentThisRun++; // ගණන එකකින් වැඩි කරයි (ඊළඟ loop එකේදී නතර වීමට)
               logInfo(`🌟 වීඩියෝව සාර්ථකව Database එකට ඇතුලත් කර ප්‍රධාන ක්‍රියාවලියෙන් ඉවත් වෙයි.`);
             } else {
               logSub(`⚠️ Discord යැවීම අසාර්ථක බැවින් seen_ids වෙත එකතු නොකළේය. ඊළඟ වීඩියෝව පරීක්ෂා කරයි.`);
             }

          } else {
             logSub(`❌ MP4 Error: මෙම පිටුවේ Direct MP4 සොයාගැනීමට නොහැකි විය. ඊළඟ වීඩියෝවට යයි...`);
          }

        } catch (e) {
          logSub(`❌ Fetch Crash: පිටුව කියවීමේදී දෝෂයක් (${e.message})`);
        }
      } // End of inner video loop

    } catch (err) {
      logSub(`❌ Main Page Critical Error: ${err.message}`);
    }
  } // End of targetPages loop

  // Database Update කිරීම
  if (newlyFetchedItems.length > 0) {
    existingItems = [...newlyFetchedItems, ...existingItems].slice(0, 50); // RSS Feed එක අන්තිම 50ට සීමා කිරීම
    if (seenIds.length > 1000) seenIds = seenIds.slice(seenIds.length - 1000); // Storage පිරිමහන්න seen_ids 1000 කට සීමා කිරීම

    await env.WOW_KV.put("seen_ids", JSON.stringify(seenIds));
    await env.WOW_KV.put("feed_items", JSON.stringify(existingItems));
    logInfo(`💾 KV Database සාර්ථකව Update කරන ලදී. (Alredy seen count: ${seenIds.length})`);
  } else {
    logInfo(`📭 මෙම Refresh එකේදී අලුත් වීඩියෝ කිසිවක් සොයාගැනීමට නොහැකි විය (සියල්ල කලින් යවා ඇත හෝ Error).`);
  }

  const rssXml = generateRssXml(existingItems);
  await env.WOW_KV.put("rss_feed_xml", rssXml);

  logInfo(`=== 🏁 PIPELINE FINISHED. Total Sent This Run: ${videosSentThisRun} ===`);
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
