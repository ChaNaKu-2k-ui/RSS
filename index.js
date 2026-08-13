const GITHUB_URLS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/urls.txt";
const GITHUB_WEBHOOKS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/webhooks.txt";

export default {
  async fetch(request, env, ctx) {
    if (!env.WOW_KV) {
      return new Response("Error: WOW_KV Binding එක සෙට් වී නැත.", { status: 500 });
    }

    const url = new URL(request.url);

    // ?sync=true ගැහුවාම Diagnostic Report එකක් පෙන්වයි
    if (url.searchParams.get("sync") === "true") {
      const logs = await updateVideoFeed(env, true);
      return new Response(logs.join("\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    let feedXml = await env.WOW_KV.get("rss_feed_xml");
    if (!feedXml) {
      const result = await updateVideoFeed(env, false);
      feedXml = result.rssXml;
    }

    return new Response(feedXml, {
      headers: { 
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
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
  if (isDiagnostic) logs.push("=== STARTING JILHUB / KVS RSS DIAGNOSTIC ===");

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  const webhookUrls = await fetchGitHubTextFile(GITHUB_WEBHOOKS_RAW);

  if (isDiagnostic) {
    logs.push(`1. GitHub Target URLs: ${targetPages.length}`);
    logs.push(`2. GitHub Webhooks: ${webhookUrls.length}`);
  }

  let seenIds = (await env.WOW_KV.get("seen_ids", "json")) || [];
  let existingItems = (await env.WOW_KV.get("feed_items", "json")) || [];

  const linkRegex = /href=["']((?:https?:\/\/[^"']*)?\/(?:videos?|watch|embed|view|play|v)\/([0-9a-zA-Z_-]+)[^"']*)["']/gi;

  let newlyFetchedItems = [];

  for (const latestPageUrl of targetPages) {
    if (isDiagnostic) logs.push(`\n--- Fetching Page: ${latestPageUrl} ---`);

    try {
      const res = await fetch(latestPageUrl, { headers });
      if (isDiagnostic) logs.push(`   Status Code: ${res.status}`);

      if (!res.ok) continue;

      const html = await res.text();
      let matches = [...html.matchAll(linkRegex)];

      if (isDiagnostic) logs.push(`   Found Video Page Links: ${matches.length}`);

      let newVideosToProcess = [];

      for (const match of matches) {
        const rawPath = match[1];
        const videoId = match[2] || rawPath;

        if (!seenIds.includes(videoId)) {
          const origin = new URL(latestPageUrl).origin;
          const fullUrl = rawPath.startsWith("http") ? rawPath : `${origin}${rawPath}`;
          
          if (!newVideosToProcess.some(v => v.url === fullUrl)) {
            newVideosToProcess.push({ id: videoId, url: fullUrl });
          }
        }
      }

      if (isDiagnostic) logs.push(`   New Unprocessed Videos: ${newVideosToProcess.length}`);

      newVideosToProcess = newVideosToProcess.slice(0, 3); // එකවර 3ක් process කරයි

      for (const video of newVideosToProcess) {
        if (isDiagnostic) logs.push(`   Processing Inner Video: ${video.url}`);

        try {
          const pageRes = await fetch(video.url, { headers });
          const pageHtml = await pageRes.text();

          const titleMatch = pageHtml.match(/<title>(.*?)<\/title>/i) || pageHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
          let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/ - JilHub/i, '').trim() : `Video ${video.id}`;

          let videoDirectUrl = null;

          // 1. Static HTML / JS ඇතුළේ තියෙන KVS /get_file/ Path එක අල්ලා ගැනීම
          const kvsFileMatch = pageHtml.match(/["']((?:https?:\/\/[^"'\s]+)?\/get_file\/[^\s"']+)["']/i);
          
          // 2. JS Variables (video_url, video_alt_url, file, etc.)
          const jsVarMatch = pageHtml.match(/(?:video_url|video_alt_url|file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/i);
          
          // 3. HTML Tag Matcher
          const tagMatch = pageHtml.match(/<(?:video|source)[^>]+src=["']([^"']+\.mp4[^"']*)["']/i);

          if (kvsFileMatch) {
            videoDirectUrl = kvsFileMatch[1];
          } else if (jsVarMatch) {
            videoDirectUrl = jsVarMatch[1];
          } else if (tagMatch) {
            videoDirectUrl = tagMatch[1];
          }

          if (videoDirectUrl) {
            const origin = new URL(video.url).origin;
            if (videoDirectUrl.startsWith("//")) {
              videoDirectUrl = "https:" + videoDirectUrl;
            } else if (videoDirectUrl.startsWith("/")) {
              videoDirectUrl = `${origin}${videoDirectUrl}`;
            }

            // Clean .mp4 URL (/?rnd=... වැනි අමතර කොටස් අයින් කරයි)
            videoDirectUrl = videoDirectUrl.replace(/(\.mp4)[\/?].*$/i, "$1");

            if (isDiagnostic) logs.push(`   ✅ Direct MP4 Link Found: ${videoDirectUrl}`);

            const newItem = {
              id: video.id,
              title: title,
              pageUrl: video.url,
              directUrl: videoDirectUrl,
              pubDate: new Date().toUTCString()
            };

            newlyFetchedItems.push(newItem);
            seenIds.push(video.id);

            await sendNotifications(webhookUrls, newItem);
          } else {
            if (isDiagnostic) logs.push(`   ❌ MP4 Link extraction failed for this page.`);
          }
        } catch (err) {
          if (isDiagnostic) logs.push(`   ❌ Inner Fetch Error: ${err.message}`);
        }
      }
    } catch (err) {
      if (isDiagnostic) logs.push(`   ❌ Page Fetch Error: ${err.message}`);
    }
  }

  if (newlyFetchedItems.length > 0) {
    existingItems = [...newlyFetchedItems, ...existingItems].slice(0, 50);

    if (seenIds.length > 500) {
      seenIds = seenIds.slice(seenIds.length - 500);
    }

    await env.WOW_KV.put("seen_ids", JSON.stringify(seenIds));
    await env.WOW_KV.put("feed_items", JSON.stringify(existingItems));
  }

  const rssXml = generateRssXml(existingItems);
  await env.WOW_KV.put("rss_feed_xml", rssXml);

  if (isDiagnostic) {
    logs.push(`\n=== COMPLETED. New Videos Saved: ${newlyFetchedItems.length} ===`);
    return logs;
  }

  return { rssXml };
}

async function sendNotifications(webhookUrls, item) {
  if (!webhookUrls || webhookUrls.length === 0) return;

  const discordPayload = {
    content: item.directUrl
  };

  for (const url of webhookUrls) {
    if (url.trim()) {
      fetch(url.trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload)
      }).catch(err => {});
    }
  }
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
