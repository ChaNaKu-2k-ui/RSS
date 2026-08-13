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
  logs.push("=== 🕵️ DEEP SOURCE SCANNER & REDIRECT RESOLVER ===");

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

      let testUrls = videoUrls.slice(0, 3); // පළමු වීඩියෝ 3 පමණක් පරීක්ෂා කරමු

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
          // STEP 3: හරියටම Clean Path එක ලබා ගැනීම
          // -------------------------------------------------------------
          let finalMp4 = null;
          
          // අපට අවශ්‍ය අකුරු, හිස්තැන් සහ "or" කෑලි අයින් කර පිරිසිදු ලින්ක් එක පමණක් අල්ලන Regex එක
          let cleanMp4Match = vHtml.match(/(\.\/common\/loadvideo\/[0-9]+\.mp4\?[^"'\s,]+)/i);

          if (cleanMp4Match && cleanMp4Match[1]) {
             let matchedRawUrl = cleanMp4Match[1].replace(/&amp;/g, '&');
             logs.push(`      ✅ [STEP 3] Clean 'loadvideo' Link එක අල්ලගත්තා!`);
             
             // Base URL (Root Domain) එකට එකතු කිරීම
             let pageOrigin = new URL(vUrl).origin; // උදා: https://m.24xxxx.win
             let cleanPath = matchedRawUrl.replace(/^\.\//, '/'); // /common/loadvideo/49355.mp4?...
             
             let loadVideoUrl = pageOrigin + cleanPath;
             logs.push(`         👉 Clean Path Extracted: ${cleanPath}`);
             logs.push(`         🔗 Intermediate Link: ${loadVideoUrl}`);

             // -------------------------------------------------------------
             // REDIRECT RESOLVER: CDN Link එක සෘජුව ලබාගැනීම
             // -------------------------------------------------------------
             try {
               const headRes = await fetch(loadVideoUrl, {
                 method: "GET",
                 headers: { ...headers, "Range": "bytes=0-0" }, // සම්පූර්ණ File එක බාගන්නේ නැතිව ලින්ක් එක පමණක් ලබාගනී
                 redirect: "follow"
               });
               
               if (headRes.url && headRes.url.includes(".mp4")) {
                 finalMp4 = headRes.url;
                 logs.push(`         🎯 Final Direct CDN Link: ${finalMp4}`);
               } else {
                 finalMp4 = loadVideoUrl;
                 logs.push(`         ⚠️ CDN Redirect අල්ලගන්න බැරි වුණා. Intermediate Link එකම භාවිතා කරයි.`);
               }
             } catch (err) {
               finalMp4 = loadVideoUrl;
               logs.push(`         ⚠️ Redirect අල්ලගන්න බැරි වුණා: ${err.message}`);
             }

          } else {
             logs.push(`      ❌ [STEP 3] MP4 / loadvideo මුකුත්ම Raw Source එකේ නෑ.`);
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
