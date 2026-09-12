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
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');

  const API_BASE = location.origin;

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

  function platformLabel(platform) {
    return { twitter: 'X', tiktok: 'TikTok', instagram: 'Instagram' }[platform] || platform;
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

  /** 下载成功后短暂提示。用独立的 toast 避免覆盖结果区。 */
  function flash(message) {
    setStatus(message, 'loading');
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
   * 拉取视频并存到本地。
   *
   * 跨域场景下 <a download> 会被浏览器忽略，所以走 fetch → blob。
   * 仅在 CDN 允许跨域时可行（X 可以，TikTok 不行）。
   * 注意：大文件会完整驻留内存，因此作为次要入口。
   */
  async function downloadBlob(url, filename, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '下载中…';

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);

      const a = el('a', { href: objectUrl, download: filename });
      document.body.append(a);
      a.click();
      a.remove();

      // 交给浏览器发起下载后再释放
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      flash('已开始下载');
    } catch (err) {
      setStatus(`下载失败：${err.message}。可改用「打开视频」或「复制直链」。`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // ── 渲染结果 ─────────────────────────────────────────────────────

  function renderVariants(data) {
    const container = el('div', { class: 'variants' });

    data.videos.forEach((variant, index) => {
      const actions = el('div', { class: 'actions' });

      if (variant.browserDownloadable) {
        actions.append(
          el('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: '直接下载',
            onclick: (e) =>
              downloadBlob(
                variant.url,
                `${data.platform}-${data.id}-${index}.mp4`,
                e.currentTarget,
              ),
          }),
        );
      }

      // 打开直链：手机上长按即可存储，是 iOS 上最可靠的路径
      actions.append(
        el('a', {
          class: 'btn btn--sm btn--ghost',
          href: variant.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: '打开视频',
        }),
      );

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

    if (data.videos.length) {
      body.append(renderVariants(data));
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

    if (data.notice) {
      body.append(
        el('div', { class: 'notice' }, [
          el('span', { class: 'notice__icon', text: 'ℹ️' }),
          el('span', { text: data.notice }),
        ]),
      );
    }

    const card = el('div', { class: 'card' });

    if (data.thumbnail && data.videos.length) {
      card.append(
        el('img', {
          class: 'card__media',
          src: data.thumbnail,
          alt: '',
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
        }),
      );
    }

    card.append(body);
    return card;
  }

  // ── 主流程 ───────────────────────────────────────────────────────

  async function resolve(rawUrl) {
    const url = rawUrl.trim();
    if (!url) return;

    setLoading(true);
    setStatus('正在解析…', 'loading');
    clear(resultEl);

    try {
      const res = await fetch(`${API_BASE}/api/resolve?url=${encodeURIComponent(url)}`);
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
      setStatus(`网络错误：${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    resolve(input.value);
  });

  // 支持 ?url=… 预填并自动解析 —— 方便分享链接和快捷指令调用
  const preset = new URLSearchParams(location.search).get('url');
  if (preset) {
    input.value = preset;
    resolve(preset);
  }

  // 让页脚提示显示真实域名，便于直接照抄到快捷指令里
  document.getElementById('api-hint').textContent = `${API_BASE}/api/resolve?url=…`;
})();
