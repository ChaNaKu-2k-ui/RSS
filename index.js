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
  logs.push("=== 🕵️ DEEP SOURCE SCANNER TEST ===");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9"
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  
  for (const latestPageUrl of targetPages) {
    try {
      const res = await fetch(latestPageUrl, { headers });
      const html = await res.text();
      
      const mainTitleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
      const mainTitle = mainTitleMatch ? mainTitleMatch[1].trim() : "Title එකක් නැත";
      
      logs.push(`\n👉 [STEP 1] Main URL එකට ගියා: ${latestPageUrl}`);
      logs.push(`   📌 Main Page Title: ${mainTitle}`);

      const allLinksMatch = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)];
      let videoUrls = [];
      
      for (const match of allLinksMatch) {
        let link = match[1];
        if (!link.match(/\/\d{3,}/) && !link.match(/video\/\d+/i)) continue;
        if(link.match(/\.(jpg|png|css|js|ico)$/i)) continue;
        if(link.match(/(new|popular|top|categories|login|signup|tags|page-|models|xxx|\/search\/)/i)) continue; 
        if(link === "/" || link === "#" || link.startsWith("javascript")) continue;

        try {
          const origin = new URL(latestPageUrl).origin;
          const fullUrl = link.startsWith("http") ? link : new URL(link, origin).href;
          if (!videoUrls.includes(fullUrl)) {
            videoUrls.push(fullUrl);
          }
        } catch(e){}
      }

      logs.push(`   🔍 Video පිටු කියලා හරියටම Filter කරගත් Links ${videoUrls.length} ක් හොයාගත්තා.`);

      let testUrls = videoUrls.slice(0, 3); // පළමු වීඩියෝ 3

      for (const vUrl of testUrls) {
        logs.push(`\n   ▶️ [STEP 2] Video පිටුව Check කරනවා...`);
        logs.push(`      🔗 Video Link: ${vUrl}`);
        
        try {
          const vRes = await fetch(vUrl, { headers });
          const vHtml = await vRes.text();
          
          const vTitleMatch = vHtml.match(/<title[^>]*>(.*?)<\/title>/i) || vHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
          const vTitle = vTitleMatch ? vTitleMatch[1].replace(/<[^>]+>/g, '').trim() : "Title එකක් නැත";
          
          logs.push(`      🏷️ Video Title: ${vTitle}`);

          // -------------------------------------------------------------
          // DEEP SCAN: Raw Code එකේ හැමතැනම mp4 / loadvideo හෙවීම
          // -------------------------------------------------------------
          let finalMp4 = null;
          let matchedRawUrl = null;

          // 1. loadvideo කෑල්ල තියෙන ඕනෑම ලින්ක් එකක් (JS ඇතුළේ තිබුණත් අල්ලයි)
          let loadVideoMatches = [...vHtml.matchAll(/(?:'|")([^'"]*loadvideo[^'"]*)(?:'|")/gi)];
          
          // 2. .mp4 කෑල්ල තියෙන ඕනෑම ලින්ක් එකක්
          let allMp4Matches = [...vHtml.matchAll(/(?:'|")([^'"]*\.mp4[^'"]*)(?:'|")/gi)];
          
          // 3. Iframe එකක් තියෙනවද බැලීම
          let iframeMatches = [...vHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];

          if (loadVideoMatches.length > 0) {
              matchedRawUrl = loadVideoMatches[0][1];
              logs.push(`      ✅ [STEP 3] 'loadvideo' Link එකක් Source එකෙන් හොයාගත්තා!`);
          } else if (allMp4Matches.length > 0) {
              matchedRawUrl = allMp4Matches[0][1];
              logs.push(`      ✅ [STEP 3] සාමාන්‍ය '.mp4' Link එකක් Source එකෙන් හොයාගත්තා!`);
          }
          
          if (matchedRawUrl) {
             matchedRawUrl = matchedRawUrl.replace(/&amp;/g, '&');
             
             // ලින්ක් එක සම්පූර්ණ කිරීම
             if (matchedRawUrl.startsWith("./")) {
               finalMp4 = `${new URL(vUrl).origin}/${matchedRawUrl.replace(/^\.\//, '')}`;
             } else if (!matchedRawUrl.startsWith("http")) {
               finalMp4 = new URL(matchedRawUrl, vUrl).href;
             } else {
               finalMp4 = matchedRawUrl;
             }
             
             logs.push(`         👉 Raw Extracted: ${matchedRawUrl}`);
             logs.push(`         🚀 Full Direct Link: ${finalMp4}`);
             
          } else if (iframeMatches.length > 0) {
             logs.push(`      ⚠️ [STEP 3] MP4 එකක් නෑ. හැබැයි Iframe එකක් තියෙනවා: ${iframeMatches[0][1]}`);
          } else {
             logs.push(`      ❌ [STEP 3] MP4 / loadvideo මුකුත්ම Raw Source එකේ නෑ. JS වලින් එනවා වෙන්න ඇති.`);
          }

        } catch (e) {
          logs.push(`      ❌ Video පිටුවට යන්න බැරි වුණා: ${e.message}`);
        }
      }
    } catch (err) {
      logs.push(`❌ Main Page එකට යන්න බැරි වුණා: ${err.message}`);
    }
  }

  logs.push(`\n=== 🏁 TEST COMPLETED ===`);
  return logs;
}
