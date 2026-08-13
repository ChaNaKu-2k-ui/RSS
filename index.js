const GITHUB_URLS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/urls.txt";
const GITHUB_WEBHOOKS_RAW = "https://raw.githubusercontent.com/ChaNaKu-2k-ui/RSS/main/webhooks.txt";

export default {
  async fetch(request, env, ctx) {
    if (!env.WOW_KV) {
      return new Response("Error: WOW_KV Binding එක සෙට් වී නැත.", { status: 500 });
    }

    const url = new URL(request.url);

    // ?sync=true
    if (url.searchParams.get("sync") === "true") {
      const { newVideosFound, processedCount } = await updateVideoFeed(env);
      if (newVideosFound) {
        return new Response(`Manual Sync Completed! New videos processed: ${processedCount}`);
      } else {
        return new Response("No new videos found.");
      }
    }

    let feedXml = await env.WOW_KV.get("rss_feed_xml");
    if (!feedXml) {
      const result = await updateVideoFeed(env);
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
    ctx.waitUntil(updateVideoFeed(env));
  }
};

async function fetchGitHubTextFile(fileUrl) {
  try {
    const res = await fetch(fileUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) return [];
    const text = await res.text();
    return text.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
  } catch (err) {
    console.error(`Error fetching file from ${fileUrl}:`, err);
    return [];
  }
}

async function updateVideoFeed(env) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const targetPages = await fetchGitHubTextFile(GITHUB_URLS_RAW);
  const webhookUrls = await fetchGitHubTextFile(GITHUB_WEBHOOKS_RAW);

  let seenIds = (await env.WOW_KV.get("seen_ids", "json")) || [];
  let existingItems = (await env.WOW_KV.get("feed_items", "json")) || [];

  let newVideosFound = false;
  let newlyFetchedItems = [];

  for (const latestPageUrl of targetPages) {
    try {
      const res = await fetch(latestPageUrl, { headers });
      const html = await res.text();

      const linkRegex = /href=["'](\/(?:video|watch|embed)\/([0-9a-zA-Z_-]+)[^"']*)["']/gi;
      let matches = [...html.matchAll(linkRegex)];

      let newVideosToProcess = [];

      for (const match of matches) {
        const fullPath = match[1];
        const videoId = match[2] || fullPath;

        if (!seenIds.includes(videoId)) {
          const origin = new URL(latestPageUrl).origin;
          const fullUrl = fullPath.startsWith("http") ? fullPath : `${origin}${fullPath}`;
          newVideosToProcess.push({ id: videoId, url: fullUrl });
        }
      }

      newVideosToProcess = newVideosToProcess.slice(0, 3);

      for (const video of newVideosToProcess) {
        try {
          const pageRes = await fetch(video.url, { headers });
          const pageHtml = await pageRes.text();

          const titleMatch = pageHtml.match(/<title>(.*?)<\/title>/i) || pageHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
          let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/ - WOW\.xxx/i, '').trim() : `Video ${video.id}`;

          let videoDirectUrl = null;
          const sourceMatch = pageHtml.match(/<(?:source|video)[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
          const jsMatch = pageHtml.match(/(?:video_url|file|videoUrl)\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                          pageHtml.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/i);

          if (sourceMatch) videoDirectUrl = sourceMatch[1];
          else if (jsMatch) videoDirectUrl = jsMatch[1];

          if (videoDirectUrl) {
            if (videoDirectUrl.startsWith("//")) videoDirectUrl = "https:" + videoDirectUrl;

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
          }
        } catch (err) {
          console.error(`Error processing video ${video.url}:`, err);
        }
      }
    } catch (err) {
      console.error(`Error processing page ${latestPageUrl}:`, err);
    }
  }

  if (newlyFetchedItems.length > 0) {
    newVideosFound = true;
    existingItems = [...newlyFetchedItems, ...existingItems].slice(0, 50);

    if (seenIds.length > 500) {
      seenIds = seenIds.slice(seenIds.length - 500);
    }

    await env.WOW_KV.put("seen_ids", JSON.stringify(seenIds));
    await env.WOW_KV.put("feed_items", JSON.stringify(existingItems));
  }

  const rssXml = generateRssXml(existingItems);
  await env.WOW_KV.put("rss_feed_xml", rssXml);

  return { rssXml, newVideosFound, processedCount: newlyFetchedItems.length };
}

async function sendNotifications(webhookUrls, item) {
  if (!webhookUrls || webhookUrls.length === 0) return;

  const discordPayload = {
    embeds: [{
      title: item.title,
      url: item.pageUrl,
      color: 5814783,
      fields: [{ name: "🎬 Direct Link", value: `\`\`\`${item.directUrl}\`\`\`` }],
      footer: { text: "Auto Video Bot" },
      timestamp: new Date().toISOString()
    }]
  };

  for (const url of webhookUrls) {
    if (url.trim()) {
      fetch(url.trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload)
      }).catch(err => console.error("Discord Error:", err));
    }
  }
}

function generateRssXml(items) {
  const rssItems = items.map(item => {
    const isMp4 = item.directUrl.includes(".mp4");
    const mimeType = isMp4 ? "video/mp4" : "application/x-mpegURL";

    return `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.pageUrl}</link>
      <guid isPermaLink="false">${item.id}</guid>
      <pubDate>${item.pubDate}</pubDate>
      <enclosure url="${item.directUrl.replace(/&/g, '&amp;')}" type="${mimeType}" />
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
