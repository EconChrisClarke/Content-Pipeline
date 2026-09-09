// ============================================================================
// Content Pipeline -> Substack bookmarklet payload.
// Loaded (not run directly) by a small bookmarklet saved in your browser —
// see the setup instructions for the bookmarklet text itself.
//
// WHAT IT DOES:
//   Run this while sitting on ANY Substack post-editor page (a brand new
//   draft, or one you've already started). It asks which Content Pipeline
//   card to use, then sets the title/subtitle/tags/cover image and builds
//   the full body — including every inline image, correctly captioned —
//   directly via Substack's own API. No copy/paste, no missing images.
//
// REQUIREMENTS:
//   The bookmarklet must set window.__CP_GH_TOKEN to your GitHub token
//   before loading this file (see setup instructions) — this file itself
//   lives in a public repo, so the token never goes in here.
// ============================================================================

(async function () {
  const GITHUB_TOKEN = window.__CP_GH_TOKEN;
  const GITHUB_OWNER = 'EconChrisClarke';
  const GITHUB_REPO = 'Content-Pipeline';
  const GITHUB_BRANCH = 'main';
  const API = 'https://econchrisclarke.substack.com/api/v1';

  if (!GITHUB_TOKEN) {
    alert('No GitHub token set — check the bookmarklet includes window.__CP_GH_TOKEN.');
    return;
  }

  // ---- figure out which draft we're on ----
  const match = location.pathname.match(/\/publish\/post\/(\d+)/);
  if (!match) {
    alert("Can't find a draft ID in this page's URL yet. If you just clicked \"New post,\" wait a second for Substack to finish creating the draft (its URL will change to include a number), then run this again.");
    return;
  }
  const draftId = match[1];

  // Everything past this point is wrapped in one try/catch — an early
  // failure (bad/expired token, cards.json unreachable, etc.) used to throw
  // uncaught and fail completely silently, which is indistinguishable from
  // the bookmarklet not running at all. Now it always surfaces an alert.
  try {

  // ---- GitHub helpers ----
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' };
  }
  function b64DecodeUnicode(str) { return decodeURIComponent(escape(atob(str))); }
  async function ghGetFile(path) {
    const res = await fetch('https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path + '?ref=' + GITHUB_BRANCH, { headers: ghHeaders() });
    if (!res.ok) throw new Error('GitHub read failed: ' + res.status);
    return res.json();
  }

  // ---- inline markdown -> Substack marks ----
  function parseInline(str, marks) {
    marks = marks || [];
    const out = [];
    let i = 0;
    while (i < str.length) {
      if (str.startsWith('**', i)) {
        const end = str.indexOf('**', i + 2);
        if (end !== -1) { out.push(...parseInline(str.slice(i + 2, end), marks.concat([{ type: 'strong' }]))); i = end + 2; continue; }
      }
      if (str[i] === '*') {
        const end2 = str.indexOf('*', i + 1);
        if (end2 !== -1) { out.push(...parseInline(str.slice(i + 1, end2), marks.concat([{ type: 'em' }]))); i = end2 + 1; continue; }
      }
      if (str[i] === '[') {
        const closeBracket = str.indexOf(']', i + 1);
        if (closeBracket !== -1 && str[closeBracket + 1] === '(') {
          const closeParen = str.indexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            const href = str.slice(closeBracket + 2, closeParen);
            const label = str.slice(i + 1, closeBracket);
            out.push(...parseInline(label, marks.concat([{ type: 'link', attrs: { href } }])));
            i = closeParen + 1; continue;
          }
        }
      }
      let j = i + 1;
      while (j < str.length && str[j] !== '*' && str[j] !== '[') j++;
      const node = { type: 'text', text: str.slice(i, j) };
      if (marks.length) node.marks = marks.slice();
      out.push(node);
      i = j;
    }
    return out;
  }
  function stripUnsupportedMarks(text) {
    return (text || '').replace(/<\/?u>/g, '');
  }

  // ---- image upload ----
  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async function uploadImageToSubstack(repoPath) {
    const rawUrl = 'https://raw.githubusercontent.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/' + repoPath;
    const imgResp = await fetch(rawUrl);
    if (!imgResp.ok) throw new Error('Could not fetch image from GitHub: ' + repoPath);
    const blob = await imgResp.blob();
    const dataUri = await blobToDataUri(blob);
    const form = new URLSearchParams();
    form.set('image', dataUri);
    const res = await fetch(API + '/image', { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) throw new Error('Substack image upload failed: ' + res.status);
    const data = await res.json();
    return data.url;
  }

  // ---- markdown -> doc, with captions correctly embedded on the image node
  // itself from the start (this is the fix for the "captions not styled"
  // issue found the first time this was done by hand) ----
  async function markdownToDoc(markdown, uploadImageFn, onProgress) {
    const blocks = (markdown || '').split(/\n{2,}/);
    const HEADER_RE = /^(#{1,3})\s+([^\n]*)/;
    const out = [];
    const imageBlocks = blocks.filter(b => {
      const t = b.trim();
      return t.startsWith('![') && t.endsWith(')');
    });
    let imgDone = 0;
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('![') && trimmed.endsWith(')')) {
        const cut = trimmed.lastIndexOf('](');
        if (cut !== -1) {
          const caption = trimmed.slice(2, cut);
          const path = trimmed.slice(cut + 2, -1);
          imgDone++;
          if (onProgress) onProgress(imgDone, imageBlocks.length);
          const url = await uploadImageFn(path);
          const content = [{
            type: 'image2',
            attrs: {
              src: url, srcNoWatermark: null, fullscreen: false, imageSize: 'normal',
              height: 819, width: 1456, resizeWidth: 728, bytes: null,
              alt: caption || null, title: null, type: null, href: null,
              belowTheFold: false, topImage: false, internalRedirect: null,
              isProcessing: false, align: null, offset: false
            }
          }];
          if (caption) content.push({ type: 'caption', content: parseInline(caption) });
          out.push({ type: 'captionedImage', content });
          continue;
        }
      }
      const headerMatch = HEADER_RE.exec(trimmed);
      if (headerMatch) {
        out.push({ type: 'heading', attrs: { level: headerMatch[1].length }, content: parseInline(headerMatch[2]) });
        continue;
      }
      const paraText = trimmed.replace(/\n/g, ' ');
      out.push({ type: 'paragraph', content: parseInline(paraText) });
    }
    return out;
  }

  async function addTagToPost(postId, tagName) {
    const existingRes = await fetch(API + '/publication/post-tag', { credentials: 'include' });
    const existing = existingRes.ok ? await existingRes.json() : [];
    const found = (existing || []).find(t => t.name === tagName);
    let tagId;
    if (found) {
      tagId = found.id;
    } else {
      const createRes = await fetch(API + '/publication/post-tag', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tagName })
      });
      if (!createRes.ok) throw new Error('Tag create failed: ' + createRes.status);
      tagId = (await createRes.json()).id;
    }
    await fetch(API + '/post/' + postId + '/tag/' + tagId, { method: 'POST', credentials: 'include' });
  }

  // ---- find the card ----
  const ghFile = await ghGetFile('data/cards.json');
  const data = JSON.parse(b64DecodeUnicode(ghFile.content));
  const cards = data.cards || [];

  const query = prompt('Which card? (type part of the title)');
  if (query === null) return; // cancelled
  const q = query.trim().toLowerCase();
  const matches = cards.filter(c => (c.title || '').toLowerCase().includes(q));

  let card;
  if (matches.length === 0) {
    alert('No card title matched "' + query + '".');
    return;
  } else if (matches.length === 1) {
    card = matches[0];
  } else {
    const list = matches.map((c, i) => (i + 1) + '. ' + c.title).join('\n');
    const choice = prompt('Multiple matches — enter the number:\n' + list);
    if (choice === null) return;
    const n = parseInt(choice, 10);
    if (!n || !matches[n - 1]) { alert('Not a valid choice.'); return; }
    card = matches[n - 1];
  }

  if (!confirm('Build this draft from "' + card.title + '"? This will overwrite the current title, subtitle, cover image, and body on this Substack draft (id ' + draftId + ').')) {
    return;
  }

  let coverImageUrl = null;
  if (card.coverImage && card.coverImage.path) {
    coverImageUrl = await uploadImageToSubstack(card.coverImage.path);
  }

    const script = stripUnsupportedMarks(card.script || '');
    const bodyContent = await markdownToDoc(script, uploadImageToSubstack, (done, total) => {
      document.title = 'Uploading images ' + done + '/' + total + '…';
    });
    document.title = 'Saving…';

    const putBody = {
      draft_title: card.title || 'Untitled',
      draft_subtitle: card.subtitle || '',
      draft_body: JSON.stringify({ type: 'doc', content: bodyContent })
    };
    if (coverImageUrl) putBody.cover_image = coverImageUrl;

    const res = await fetch(API + '/drafts/' + draftId, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody)
    });
    if (!res.ok) throw new Error('Draft update failed: ' + res.status + ' ' + (await res.text()));

    const tags = card.tags || [];
    for (const t of tags) {
      try { await addTagToPost(draftId, t); } catch (e) { /* one bad tag shouldn't sink the rest */ }
    }

    alert('Done! Reloading so you can review it.');
    location.reload();
  } catch (err) {
    alert('Something went wrong: ' + err.message);
  }
})();
