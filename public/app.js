/**
 * 前端逻辑。
 *
 * 安全约定：所有来自接口的数据（推文文案、作者名等）都用 textContent 写入，
 * 绝不拼进 innerHTML —— 这些内容来自第三方平台，属于不可信输入。
 */
(() => {
  'use strict';

  const form = document.getElementById('form');
  const input = document.getElementById('url-input');
  const pasteBtn = document.getElementById('paste-btn');
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');

  const API_BASE = location.origin;

  /**
   * iOS / iPadOS 检测。
   *
   * iPadOS 13+ 默认以桌面版 Safari 的 UA 访问（含 Macintosh），
   * 只能靠多点触控把它和真正的 Mac 区分开。
   */
  const IS_IOS =
    /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

  // ── DOM 构造小工具 ───────────────────────────────────────────────

  /** 建元素。children 里的字符串一律按文本处理，天然免疫 XSS。 */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === '') continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    node.replaceChildren();
  }

  // ── 格式化 ───────────────────────────────────────────────────────

  function formatDuration(ms) {
    if (!ms || ms < 0) return '';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s} 秒`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  function formatBytes(n) {
    if (!n) return '';
    const mb = n / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  function platformLabel(platform) {
    return { twitter: 'X', tiktok: 'TikTok', instagram: 'Instagram' }[platform] || platform;
  }

  // 链接后面常紧跟中文标点或括号，它们不属于 URL
  const URL_TAIL = `[^\\s<>"'，。！？、；：）】」》]+`;
  const FULL_URL = new RegExp(`https?://${URL_TAIL}`, 'i');
  const BARE_URL = new RegExp(
    `(?:^|\\s)((?:[\\w-]+\\.)*(?:x|twitter|tiktok|instagram)\\.com/${URL_TAIL})`,
    'i',
  );

  /**
   * 从任意文本里抠出第一个链接。
   *
   * App 的「分享」给出的常是「文案 + 链接」一整段（TikTok 尤其如此），
   * 用户原样粘贴进来时不该报「链接格式不正确」。没写协议的裸域名
   * （如 x.com/user/status/123）也补上 https://。都不是则原样返回。
   */
  function extractUrl(text) {
    const s = text.trim();
    const full = s.match(FULL_URL);
    if (full) return full[0];
    const bare = s.match(BARE_URL);
    return bare ? `https://${bare[1]}` : s;
  }

  // ── 状态显示 ─────────────────────────────────────────────────────

  function setStatus(message, kind) {
    statusEl.className = kind ? `status status--${kind}` : 'status';
    statusEl.textContent = message || '';
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? '解析中…' : '解析';
  }

  /** 操作成功后短暂提示。 */
  function flash(message) {
    setStatus(message, 'ok');
    window.setTimeout(() => {
      if (statusEl.textContent === message) setStatus('', '');
    }, 2500);
  }

  // ── 下载动作 ─────────────────────────────────────────────────────

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      flash('直链已复制');
    } catch {
      // 剪贴板 API 在非 HTTPS 或旧浏览器下不可用，降级到选中提示
      window.prompt('复制下面的直链：', text);
    }
  }

  /**
   * 已下载好的视频文件，按直链缓存。
   *
   * iOS 上分享面板可能被用户关掉，或因点击「过期」而弹不出来（见 shareFile），
   * 缓存下来之后再点一次即可立刻弹出，不必重新下载。换链接解析时清空。
   */
  const fileCache = new Map();

  /**
   * 拉取视频为 Blob，并回报进度。
   *
   * 跨域场景下 <a download> 会被浏览器忽略，所以只能走 fetch → blob，
   * 这也要求 CDN 允许跨域（X、Instagram 可以，TikTok 不行）。
   *
   * 进度用 TransformStream 旁路统计，字节交给 Response.blob() 汇总 ——
   * 比手动收集 chunk 再 new Blob() 少一份完整拷贝，大视频在手机上更不容易爆内存。
   */
  async function fetchVideo(url, onProgress) {
    // ⚠️ 必须不带 Referer。video.twimg.com 有防盗链：Referer 不是 X 自家域名
    //    就返回 403（实测本站域名、localhost 均 403；不带 Referer 或 Origin 任意
    //    均 200）。浏览器默认会带上本站 origin 作 Referer，所以这里要显式关掉。
    //    用 curl 验证 CORS 时发现不了这个问题 —— curl 默认不发 Referer。
    const res = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || 0;
    const type = res.headers.get('content-type') || 'video/mp4';
    if (!res.body || typeof TransformStream === 'undefined') return res.blob();

    let loaded = 0;
    const counted = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          onProgress(loaded, total);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, { headers: { 'content-type': type } }).blob();
  }

  function describeDownloadError(err) {
    if (/^HTTP (403|404|410)$/.test(err.message)) {
      return '视频直链已过期或失效，请重新解析后再试。';
    }
    // fetch 的网络层失败一律是 TypeError（Safari: "Load failed"，Chrome: "Failed to fetch"）
    if (err instanceof TypeError) {
      return '网络中断，或该视频地址不允许浏览器直接下载。';
    }
    return err.message;
  }

  /** 用 <a download> 把文件存到本地。桌面与 Android 走这条路。 */
  function saveWithAnchor(file) {
    const objectUrl = URL.createObjectURL(file);
    const a = el('a', { href: objectUrl, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    // 交给浏览器发起下载后再释放
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  /**
   * iOS 上用系统分享面板保存 —— 面板里的「存储视频」会直接存进相册。
   *
   * 为什么 iOS 不用 <a download>：即便 Safari 支持该属性，文件也只会进
   * 「文件」App 的下载目录，还得再手动转存到相册；在微信等 App 的内置
   * 浏览器里，它往往干脆没反应。
   *
   * 返回 'shared' | 'cancelled' | 'needs-tap' | 'unsupported'。
   */
  async function shareFile(file) {
    if (!navigator.canShare?.({ files: [file] })) return 'unsupported';
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      // navigator.share 必须由用户点击触发。下载耗时一长，Safari 会认为这次
      // 点击已经「过期」而拒绝弹出 —— 此时文件已在缓存里，让用户再点一次即可。
      if (err.name === 'NotAllowedError') return 'needs-tap';
      if (err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }

  /**
   * 把下载好的文件交给用户。
   * 返回 'pending' 表示 iOS 上还需要用户再点一次按钮。
   */
  async function deliver(file) {
    if (IS_IOS) {
      try {
        const outcome = await shareFile(file);
        if (outcome === 'shared') {
          flash('完成');
          return 'done';
        }
        if (outcome === 'cancelled') return 'pending';
        if (outcome === 'needs-tap') {
          setStatus('下载完成。请再点一次按钮，在菜单中选择「存储视频」。', 'ok');
          return 'pending';
        }
      } catch {
        // 分享面板本身出错时，退回普通下载
      }
    }

    saveWithAnchor(file);
    flash(IS_IOS ? '已开始下载，可在「文件」App 的「下载」中找到' : '已开始下载');
    return 'done';
  }

  /**
   * 创建下载按钮。
   *
   * 状态流转：待下载 →「下载中 42%」（按钮底部有进度条）→ 保存。
   * 按钮在下载期间不设 disabled —— 那会让它变灰，进度看不清；
   * 改由 is-busy 拦截重复点击。
   */
  function downloadButton({ url, filename, label, className }) {
    const button = el('button', { class: className, type: 'button', text: label });
    let lastPct = -1;

    function setBusy(busy) {
      lastPct = -1;
      button.classList.toggle('is-busy', busy);
      button.classList.remove('is-indeterminate');
      button.style.removeProperty('--progress');
      if (busy) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    }

    function onProgress(loaded, total) {
      if (!total) {
        // 拿不到总大小时只显示已下载量，进度条改为往复动画
        button.classList.add('is-indeterminate');
        button.textContent = `下载中 ${formatBytes(loaded)}`;
        return;
      }
      const pct = Math.min(100, Math.floor((loaded / total) * 100));
      if (pct === lastPct) return;
      lastPct = pct;
      button.style.setProperty('--progress', `${pct}%`);
      button.textContent = `下载中 ${pct}%`;
    }

    button.addEventListener('click', async () => {
      if (button.classList.contains('is-busy')) return;

      let file = fileCache.get(url);
      if (!file) {
        setBusy(true);
        button.textContent = '连接中…';
        try {
          const blob = await fetchVideo(url, onProgress);
          file = new File([blob], filename, { type: blob.type || 'video/mp4' });
          fileCache.set(url, file);
        } catch (err) {
          button.textContent = label;
          setStatus(
            `下载失败：${describeDownloadError(err)}\n` +
              '可展开下方「全部画质与直链」，改用「打开」或「复制直链」。',
            'error',
          );
          return;
        } finally {
          setBusy(false);
        }
      }

      const outcome = await deliver(file);
      button.textContent = outcome === 'pending' ? '已下载 · 点此存入相册' : label;
    });

    return button;
  }

  // ── 渲染结果 ─────────────────────────────────────────────────────

  function fileName(data, index) {
    return `${data.platform}-${data.id}-${index}.mp4`;
  }

  /** 每个档位一行：清晰度 + 下载 / 打开 / 复制直链。 */
  function renderVariants(data) {
    const container = el('div', { class: 'variants' });

    data.videos.forEach((variant, index) => {
      const actions = el('div', { class: 'actions' });

      if (variant.browserDownloadable) {
        actions.append(
          downloadButton({
            url: variant.url,
            filename: fileName(data, index),
            label: IS_IOS ? '保存' : '下载',
            className: 'btn btn--sm',
          }),
        );
      }

      // 需要附加请求头的直链（TikTok 要 Referer）在浏览器里直接打开只会 403，
      // 这种按钮不如不放。
      const needsHeaders = Object.keys(variant.downloadHeaders || {}).length > 0;
      if (!needsHeaders) {
        actions.append(
          el('a', {
            class: 'btn btn--sm btn--ghost',
            href: variant.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: '打开',
          }),
        );
      }

      actions.append(
        el('button', {
          class: 'btn btn--sm btn--ghost',
          type: 'button',
          text: '复制直链',
          onclick: () => copyText(variant.url),
        }),
      );

      container.append(
        el('div', { class: 'variant' }, [
          el('span', { class: 'variant__label', text: variant.label }),
          index === 0 && el('span', { class: 'variant__badge', text: '最高画质' }),
          actions,
        ]),
      );
    });

    return container;
  }

  /**
   * 下载区：一个醒目的主按钮（最高画质），其余档位收进折叠区。
   *
   * 原先每个档位都平铺三个按钮，X 常有 4 个档位 → 12 个按钮挤在手机屏上，
   * 而绝大多数人只要最高画质。
   */
  function renderDownloads(data) {
    const best = data.videos[0];
    const section = el('div', { class: 'downloads' });

    if (best.browserDownloadable) {
      section.append(
        downloadButton({
          url: best.url,
          filename: fileName(data, 0),
          label: IS_IOS ? '保存到相册' : '下载视频',
          className: 'btn btn--block',
        }),
        el('div', { class: 'downloads__meta', text: `最高画质 · ${best.label}` }),
      );
      if (IS_IOS) {
        section.append(
          el('p', {
            class: 'hint',
            text: '点击后会弹出分享菜单，选择「存储视频」即可存入相册。',
          }),
        );
      }
    }

    const more = el('details', { class: 'more' }, [
      el('summary', { text: `全部画质与直链（${data.videos.length}）` }),
      renderVariants(data),
    ]);
    // 浏览器下不了的平台，直链列表就是全部可用内容，默认展开
    if (!best.browserDownloadable) more.open = true;
    section.append(more);

    return section;
  }

  function renderAuthor(data) {
    const author = data.author || {};
    const children = [];

    if (author.avatar) {
      children.push(
        el('img', {
          class: 'author__avatar',
          src: author.avatar,
          alt: '',
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
        }),
      );
    }

    const nameLines = [];
    if (author.name) nameLines.push(el('div', { class: 'author__name', text: author.name }));
    if (author.handle) {
      const handleText = data.platform === 'twitter' ? `@${author.handle}` : author.handle;
      nameLines.push(
        author.url
          ? el('a', {
              class: 'author__handle',
              href: author.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: handleText,
            })
          : el('div', { class: 'author__handle', text: handleText }),
      );
    }

    if (nameLines.length) children.push(el('div', {}, nameLines));

    return children.length ? el('div', { class: 'author' }, children) : null;
  }

  function renderCard(data) {
    const body = el('div', { class: 'card__body' });

    const author = renderAuthor(data);
    if (author) body.append(author);

    if (data.text) body.append(el('p', { class: 'text', text: data.text }));

    const metaBits = [platformLabel(data.platform)];
    const duration = formatDuration(data.durationMs);
    if (duration) metaBits.push(`时长 ${duration}`);
    const date = formatDate(data.createdAt);
    if (date) metaBits.push(date);
    body.append(el('div', { class: 'meta', text: metaBits.join(' · ') }));

    // 提示放在下载按钮之前：「视频来自引用推文」「TikTok 需用快捷指令」
    // 这类信息应该在用户点下载之前看到。
    if (data.notice) {
      body.append(
        el('div', { class: 'notice' }, [
          el('span', { class: 'notice__icon', text: 'ℹ️' }),
          el('span', { text: data.notice }),
        ]),
      );
    }

    if (data.videos.length) {
      body.append(renderDownloads(data));
    }

    // 图片帖：没有视频时把图片也放出来
    if (!data.videos.length && data.images.length) {
      const gallery = el('div', { class: 'variants' });
      data.images.forEach((src, i) => {
        gallery.append(
          el('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, [
            el('img', {
              class: 'card__media',
              src,
              alt: `图片 ${i + 1}`,
              loading: 'lazy',
            }),
          ]),
        );
      });
      body.append(gallery);
    }

    const card = el('div', { class: 'card' });

    if (data.thumbnail && data.videos.length) {
      // 封面在首屏，不要懒加载 —— 那只会让它晚出现
      card.append(
        el('img', {
          class: 'card__media',
          src: data.thumbnail,
          alt: '',
          decoding: 'async',
          fetchpriority: 'high',
          referrerpolicy: 'no-referrer',
        }),
      );
    }

    card.append(body);
    return card;
  }

  // ── 主流程 ───────────────────────────────────────────────────────

  /** 当前进行中的解析请求。新请求发起时取消旧的，避免旧结果后到覆盖新结果。 */
  let inflight = null;

  async function resolve(rawUrl) {
    const url = extractUrl(rawUrl);
    if (!url) return;
    input.value = url;

    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    setLoading(true);
    setStatus('正在解析…', 'loading');
    clear(resultEl);
    fileCache.clear();

    try {
      const res = await fetch(`${API_BASE}/api/resolve?url=${encodeURIComponent(url)}`, {
        signal: controller.signal,
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        const error = data.error || {};
        setStatus(
          [error.message || '解析失败', error.hint].filter(Boolean).join('\n'),
          'error',
        );
        return;
      }

      setStatus('', '');
      resultEl.append(renderCard(data));
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(`网络错误：${err.message}`, 'error');
    } finally {
      if (inflight === controller) {
        inflight = null;
        setLoading(false);
      }
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    resolve(input.value);
  });

  // 往空输入框里粘贴链接时直接解析，省掉一次点击。
  // 输入框里已有内容（用户可能在编辑）时按正常粘贴处理。
  input.addEventListener('paste', (e) => {
    const allSelected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
    if (input.value && !allSelected) return;

    const url = extractUrl(e.clipboardData?.getData('text') ?? '');
    if (!/^https?:\/\//i.test(url)) return;

    e.preventDefault();
    resolve(url);
  });

  // 「粘贴」按钮：手机上长按输入框再点粘贴要两步，这里一步完成。
  // iOS 会弹出系统的「粘贴」确认气泡，这是系统行为。
  if (navigator.clipboard?.readText) {
    pasteBtn.hidden = false;
    form.classList.add('has-paste');
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) {
          setStatus('剪贴板是空的', 'error');
          return;
        }
        resolve(text);
      } catch {
        input.focus();
        setStatus('无法读取剪贴板，请长按输入框手动粘贴。', 'error');
      }
    });
  }

  // 支持 ?url=… 预填并自动解析 —— 方便分享链接和快捷指令调用
  const preset = new URLSearchParams(location.search).get('url');
  if (preset) resolve(preset);

  // 让页脚提示显示真实域名，便于直接照抄到快捷指令里
  document.getElementById('api-hint').textContent = `${API_BASE}/api/resolve?url=…`;
})();
