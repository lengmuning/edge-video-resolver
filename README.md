# 视频下载 · X / TikTok

一个跑在 Cloudflare Worker 上的视频解析服务。粘贴链接即可解析，支持手机与电脑浏览器，并提供 iPhone 快捷指令接口。

## 核心设计：视频字节不走 Cloudflare

这个项目最重要的设计决策是：**Worker 只解析，不中转视频**。

```
浏览器 / 快捷指令 ──GET /api/resolve──> Worker（返回 ~3KB JSON）
        │
        └──直连平台 CDN 下载视频（字节完全不经过 Cloudflare）
```

这样做有两个好处：

1. **合规**。Cloudflare 的 CDN 专项条款限制「用 CDN 提供视频」，自助协议 §2.2.1(j) 禁止「提供 VPN 或类似代理服务」，§2.7 禁止传输侵权内容。中转视频会同时踩中这三条；纯解析则一条都不触发。
2. **零带宽成本**。免费额度 100k 请求/天，只传 JSON 完全够用。

## 支持情况

| 平台 | 解析 | 浏览器下载 | 快捷指令 | 说明 |
|---|:---:|:---:|:---:|---|
| **X** | ✅ | ✅ | ✅ | 直链免 header，CORS 回显任意 Origin |
| **Instagram** | ✅ | ✅ | ✅ | 直链免 header，CORS 为 `*` |
| **TikTok** | ✅ | ❌ | ✅ | CDN 有反爬，仅快捷指令可用（见下） |

### 为什么 TikTok 只有快捷指令能下

TikTok 的视频 CDN 有两道限制：

- **CORS 锁死为 `tiktok.com`**（不是通配符），浏览器跨域取不到
- 直链需要 `Referer: https://www.tiktok.com/`，而 `Referer` 是浏览器禁止脚本设置的请求头

快捷指令恰好绕开这两点：它跑在你手机的原生网络栈上，不受 CORS 约束，也能自由设置请求头。因此 TikTok 的下载交由快捷指令完成，`/api/resolve` 会把需要哪些头一并返回。

---

## 部署

```bash
npm install
npx wrangler login     # 首次需要
npx wrangler deploy
```

部署完会得到一个 `https://download-x.<你的子域>.workers.dev` 地址。

### 运行时版本锁定

`wrangler.jsonc` 里的 `compatibility_date` **就是** Workers 的运行时锁定机制 —— 它固定住该日期及之前的所有运行时行为，官方保证「永久支持旧的兼容性日期」，锁定后不会漂移。

两个注意点：

- 日期**不能是未来**（报错 `code 10021`），且按 **UTC** 校验。若部署报此错，回退一天即可。
- **不需要加 `nodejs_compat`**。官方 changelog 明确：自 compatibility_date `2026-08-04` 起 `nodejs_compat` 与 `nodejs_compat_v2` 默认开启；且「Wrangler、Miniflare、Vite 插件、Vitest Pool 在启动运行时会忽略这些冗余标志」。也就是说写上去不报错，只是被忽略 —— 加上它只会让人误以为它是必需的。

  来源：[Cloudflare Changelog · nodejs_compat 默认开启](https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/)

### 本地开发

```bash
npm run dev      # http://localhost:8787
npm run check    # 类型检查
```

---

## API

| 端点 | 说明 |
|---|---|
| `GET /api/resolve?url=<链接>` | 返回媒体信息与各档视频直链 |
| `GET /api/direct?url=<链接>&i=0` | 302 跳转到第 i 档直链（**仅 X / Instagram**） |
| `GET /api/health` | 健康检查 |

`/api/resolve` 返回中与本项目相关的关键字段：

```jsonc
{
  "ok": true,
  "platform": "twitter",
  "author": { "name": "NFL", "handle": "NFL" },
  "durationMs": 15015,
  "videos": [
    {
      "url": "https://video.twimg.com/...",
      "label": "1080x1350 · 10.4 Mbps",
      // 下载该地址需要附加的请求头。X / Instagram 为空，TikTok 为 Referer。
      "downloadHeaders": {},
      // 浏览器能否直接跨域下载
      "browserDownloadable": true
    }
  ],
  "notice": "..."   // 平台限制提示，如有
}
```

调用方应读取 `downloadHeaders` 并据此配置请求，而不是硬编码。

---

## iPhone 快捷指令

### X 版

X 的直链免 header，用 `/api/direct` 一步到位：

| 步骤 | 动作 | 配置 |
|---|---|---|
| 1 | **接收** | 关闭「如果无输入则询问」；输入类型勾选 URL |
| 2 | **URL 编码** | 输入：快捷指令输入 |
| 3 | **获取 URL 内容** | `https://<你的域名>/api/direct?url=` 后面接上一步结果 |
| 4 | **存储到相册** | 输入：上一步结果 |

建议在快捷指令设置里打开「在共享表单中显示」，之后就能从 X 的分享菜单直接调用。

### TikTok 版

TikTok 需要显式设置 `Referer`，所以要多两步：

| 步骤 | 动作 | 配置 |
|---|---|---|
| 1 | **接收** | 输入类型勾选 URL |
| 2 | **URL 编码** | 输入：快捷指令输入 |
| 3 | **获取 URL 内容** | `https://<你的域名>/api/resolve?url=` + 上一步结果 |
| 4 | **从输入获取词典值** | 键：`videos` → 再取第 1 项 → 键 `url` |
| 5 | **获取 URL 内容** | 输入：上一步的 URL<br>**展开「显示更多」→ 头部 → 新增一项：键 `Referer`，值 `https://www.tiktok.com/`** |
| 6 | **存储到相册** | 输入：上一步结果 |

第 5 步的 `Referer` 头是关键，漏掉会返回 403。

### 合并版技巧

如果想用一个快捷指令同时支持三个平台，在第 3 步之后取 `platform` 字段做判断：

- `twitter` / `instagram` → 走 `/api/direct` 直接下载
- `tiktok` → 走带 `Referer` 头的路径

更省事的写法：直接判断 `videos.0.downloadHeaders` 是否为空 —— 空就走 `/api/direct`，非空就按里面的键值对逐个添加请求头。这样以后新增平台也不用改快捷指令。

---

## 维护须知

### X 的错误形态

syndication 端点对不存在的推文有两种响应，代码里都归一到 `tweet_unavailable`：

- ID 格式非法 → `400` + JSON `{"error":"Bad request."}`
- ID 合法但不存在 → `404` + HTML 错误页（`class="dog"`）

另外，**不存在的推文有时会返回合法的空 JSON**，所以判断媒体是否存在必须显式检查字段，不能依赖 HTTP 状态码。

### Instagram 的三种页面状态

`src/platforms/instagram.ts` 走公开 embed 端点，无需登录。它的响应有**三种状态，体积接近，必须靠 `contextJSON` 区分**：

| 体积 | `contextJSON` | 含义 |
|---|---|---|
| ~623 KB | 无 | 反爬伪装页（限流时出现，会自行恢复） |
| ~221 KB | `null` | 帖子不存在 / 已删除 / 不可公开访问 |
| 265–350 KB | 有值 | 真实数据，含 `video_url` |

⚠️ 把中间那一行误读成「平台关闭了未登录访问」是本项目踩过的坑 —— ②③ 体积接近，光看大小分不开。（本项目曾因此把 Instagram 下架过一次，复核后恢复。）

**UA 必须用非浏览器 UA（当前是 `curl/8.7.1`），不要改回浏览器 UA。** 原因有两层：

1. Instagram 会校验「UA 与 `Sec-Fetch-*` 头是否自洽」——浏览器 UA 却不带 `Sec-Fetch-Mode: navigate` 会直接被判定为伪装请求，返回 623KB 假页面（HTTP 200，不报错，静默失败）。
2. 实测非浏览器 UA **抗限流能力明显更强**：浏览器 UA 正被限流返回伪装页的同一时刻，curl UA 仍能稳定拿到真实数据。

另一个坑：`contextJSON` 是**双重转义**的 JSON 字符串，原始 HTML 里长这样：

```
\"video_url\":\"https:\\/\\/scontent...
```

任何正则都匹配不到，必须切出字符串字面量后连续 `JSON.parse` 两次。

---

## 已知限制

- **仅支持公开内容**。受保护账号、私密账号、已删除的帖子无法解析。
- **TikTok 网页端无法下载**，只能用快捷指令；且服务器端投递不稳定，可能时好时坏。
- **直链有时效性**（带签名参数），过期需重新解析。请勿收藏直链，也不要在下游长时间缓存。
- **X 卡片视频**（视频数据嵌在 `card.binding_values.unified_card` 里的广告类内容）暂不支持，会返回明确提示而非静默失败。
- 请仅用于个人备份与离线观看，尊重创作者版权，勿二次分发。
