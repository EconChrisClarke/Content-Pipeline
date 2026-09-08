// ============================================================================
// Content Pipeline -> Substack publisher, for Tasker's "Run JavaScript"
// action inside a WebView Scene element loaded at https://econchrisclarke.substack.com
//
// SETUP (one-time, before first use):
//   1. Replace GITHUB_TOKEN below with your fine-grained GitHub token (the
//      same one the Content Pipeline app itself uses — Settings screen in
//      the app shows it, or generate a fresh one at
//      github.com/settings/personal-access-tokens, scoped to just the
//      Content-Pipeline repo, with Contents: Read and write).
//   2. Make sure the Tasker WebView's "Allow Phone Access" is checked (this
//      is what lets it run JavaScript at all).
//   3. The very first time you run this, if the WebView isn't already
//      logged into Substack, it'll fail — just log into Substack manually
//      inside that same WebView once (type your email/password/whatever
//      you normally use), then re-run. The login persists after that.
//
// WHAT IT DOES:
//   Looks in your Content-Pipeline GitHub repo for a card whose Substack
//   status is "queued_for_phone" (set when you tap "Publish live to
//   Substack" in the app and confirm), converts its script text into
//   Substack's post format, uploads any images, creates the draft, applies
//   the cover image and tags, publishes it live, and writes the result
//   (published + link, or publish_failed) back to the same repo so the app
//   picks it up next time you open it.
// ============================================================================

(async function () {
  var GITHUB_TOKEN = 'PASTE_YOUR_GITHUB_TOKEN_HERE';
  var GITHUB_OWNER = 'EconChrisClarke';
  var GITHUB_REPO = 'Content-Pipeline';
  var GITHUB_BRANCH = 'main';
  var PUBLICATION_URL = 'https://econchrisclarke.substack.com';
  var API = PUBLICATION_URL + '/api/v1';
  var GLOBAL_API = 'https://substack.com/api/v1';

  function report(msg) {
    // alert() is the simplest way to see the result on-screen inside the
    // Tasker WebView without needing to know Tasker's own variable-return
    // API in detail — this shows up as a normal browser alert dialog.
    try { alert(msg); } catch (e) { /* ignore if alert is blocked */ }
  }

  // ---- GitHub helpers (mirrors the app's own ghGetFile/ghPutFile) ----
  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json'
    };
  }
  function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64DecodeUnicode(str) {
    return decodeURIComponent(escape(atob(str)));
  }
  async function ghGetFile(path) {
    var res = await fetch(
      'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path + '?ref=' + GITHUB_BRANCH,
      { headers: ghHeaders() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GitHub read failed: ' + res.status + ' ' + (await res.text()));
    return res.json();
  }
  async function ghPutFile(path, contentStr, message, sha) {
    var body = { message: message, content: b64EncodeUnicode(contentStr), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    var res = await fetch(
      'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path,
      { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()), body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error('GitHub write failed: ' + res.status + ' ' + (await res.text()));
    return res.json();
  }

  // ---- inline markdown -> Substack marks (bold/italic/links), tested against
  // the real python-substack library's output for equivalence ----
  function parseInline(str, marks) {
    marks = marks || [];
    var out = [];
    var i = 0;
    while (i < str.length) {
      if (str.startsWith('**', i)) {
        var end = str.indexOf('**', i + 2);
        if (end !== -1) {
          out = out.concat(parseInline(str.slice(i + 2, end), marks.concat([{ type: 'strong' }])));
          i = end + 2;
          continue;
        }
      }
      if (str[i] === '*') {
        var end2 = str.indexOf('*', i + 1);
        if (end2 !== -1) {
          out = out.concat(parseInline(str.slice(i + 1, end2), marks.concat([{ type: 'em' }])));
          i = end2 + 1;
          continue;
        }
      }
      if (str[i] === '[') {
        var closeBracket = str.indexOf(']', i + 1);
        if (closeBracket !== -1 && str[closeBracket + 1] === '(') {
          var closeParen = str.indexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            var href = str.slice(closeBracket + 2, closeParen);
            var label = str.slice(i + 1, closeBracket);
            out = out.concat(parseInline(label, marks.concat([{ type: 'link', attrs: { href: href } }])));
            i = closeParen + 1;
            continue;
          }
        }
      }
      var j = i + 1;
      while (j < str.length && str[j] !== '*' && str[j] !== '[') j++;
      var node = { type: 'text', text: str.slice(i, j) };
      if (marks.length) node.marks = marks.slice();
      out.push(node);
      i = j;
    }
    return out;
  }

  function stripUnsupportedMarks(text) {
    // Underline (<u>...</u>) has no Substack equivalent; drop the tags,
    // keep the inner text (same rule as the GitHub Actions Python path).
    return (text || '').replace(/<\/?u>/g, '');
  }

  async function markdownToDoc(markdown, uploadImageFn) {
    var blocks = (markdown || '').split(/\n{2,}/);
    var HEADER_RE = /^(#{1,3})\s+([^\n]*)/;
    var out = [];
    for (var idx = 0; idx < blocks.length; idx++) {
      var trimmed = blocks[idx].trim();
      if (!trimmed) continue;

      if (trimmed.indexOf('![') === 0 && trimmed.charAt(trimmed.length - 1) === ')') {
        var cut = trimmed.lastIndexOf('](');
        if (cut !== -1) {
          var caption = trimmed.slice(2, cut);
          var path = trimmed.slice(cut + 2, -1);
          var url = await uploadImageFn(path);
          var content = [{
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
          out.push({ type: 'captionedImage', content: content });
          continue;
        }
      }

      var headerMatch = HEADER_RE.exec(trimmed);
      if (headerMatch) {
        out.push({ type: 'heading', attrs: { level: headerMatch[1].length }, content: parseInline(headerMatch[2]) });
        continue;
      }

      var paraText = trimmed.replace(/\n/g, ' ');
      out.push({ type: 'paragraph', content: parseInline(paraText) });
    }
    return out;
  }

  // ---- Substack API calls ----
  function blobToDataUri(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async function uploadImageToSubstack(repoPath) {
    var rawUrl = 'https://raw.githubusercontent.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/' + repoPath;
    var imgResp = await fetch(rawUrl);
    if (!imgResp.ok) throw new Error('Could not fetch image from GitHub: ' + repoPath);
    var blob = await imgResp.blob();
    var dataUri = await blobToDataUri(blob);
    var form = new URLSearchParams();
    form.set('image', dataUri);
    var res = await fetch(API + '/image', { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) throw new Error('Substack image upload failed: ' + res.status);
    var data = await res.json();
    return data.url;
  }

  async function addTagToPost(postId, tagName) {
    var existingRes = await fetch(API + '/publication/post-tag', { credentials: 'include' });
    var existing = existingRes.ok ? await existingRes.json() : [];
    var found = (existing || []).find(function (t) { return t.name === tagName; });
    var tagId;
    if (found) {
      tagId = found.id;
    } else {
      var createRes = await fetch(API + '/publication/post-tag', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tagName })
      });
      if (!createRes.ok) throw new Error('Tag create failed: ' + createRes.status);
      var created = await createRes.json();
      tagId = created.id;
    }
    await fetch(API + '/post/' + postId + '/tag/' + tagId, { method: 'POST', credentials: 'include' });
  }

  // ---- main ----
  var ghFile = await ghGetFile('data/cards.json');
  if (!ghFile) { report('Could not read cards.json from GitHub.'); return; }
  var data = JSON.parse(b64DecodeUnicode(ghFile.content));
  var cards = data.cards || [];
  var card = cards.find(function (c) {
    return c.platforms && c.platforms.substack && c.platforms.substack.status === 'queued_for_phone';
  });
  if (!card) { report('Nothing queued to publish to Substack right now.'); return; }

  var st = card.platforms.substack;

  try {
    // Sign in to the publication (mirrors python-substack's signin_for_pub).
    await fetch('https://substack.com/sign-in?redirect=%2F&for_pub=econchrisclarke', { credentials: 'include' });

    var profRes = await fetch(GLOBAL_API + '/user/profile/self', { credentials: 'include' });
    if (!profRes.ok) throw new Error('Could not fetch your Substack profile (' + profRes.status + ') — are you logged in inside this WebView?');
    var profile = await profRes.json();
    var userId = profile.id;

    var script = stripUnsupportedMarks(card.script || '');
    var bodyContent = await markdownToDoc(script, uploadImageToSubstack);

    var draftBody = {
      draft_title: card.title || 'Untitled',
      draft_subtitle: card.subtitle || '',
      draft_body: JSON.stringify({ type: 'doc', content: bodyContent }),
      draft_bylines: [{ id: userId, is_guest: false }],
      audience: 'everyone',
      draft_section_id: null,
      section_chosen: true,
      write_comment_permissions: 'everyone'
    };

    var draftRes = await fetch(API + '/drafts', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody)
    });
    if (!draftRes.ok) throw new Error('Draft creation failed: ' + draftRes.status + ' ' + (await draftRes.text()));
    var draft = await draftRes.json();
    var draftId = draft.id;

    if (card.coverImage && card.coverImage.path) {
      try {
        var coverUrl = await uploadImageToSubstack(card.coverImage.path);
        await fetch(API + '/drafts/' + draftId, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cover_image: coverUrl })
        });
      } catch (e) { /* cover image is best-effort; keep going without it */ }
    }

    var tags = card.tags || [];
    for (var t = 0; t < tags.length; t++) {
      try { await addTagToPost(draftId, tags[t]); } catch (e) { /* one bad tag shouldn't sink the publish */ }
    }

    await fetch(API + '/drafts/' + draftId + '/prepublish', { credentials: 'include' });
    var pubRes = await fetch(API + '/drafts/' + draftId + '/publish', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send: true, share_automatically: false })
    });
    if (!pubRes.ok) throw new Error('Publish failed: ' + pubRes.status + ' ' + (await pubRes.text()));
    var pubData = await pubRes.json();
    var publishedUrl = pubData.canonical_url || pubData.url || pubData.post_url || (PUBLICATION_URL + '/publish/post/' + draftId);

    st.status = 'published';
    st.link = publishedUrl;
    await ghPutFile('data/cards.json', JSON.stringify(data, null, 2) + '\n', 'Substack publish result (Tasker) for card ' + card.id, ghFile.sha);
    report('Published!\n\n' + card.title + '\n' + publishedUrl);

  } catch (err) {
    st.status = 'publish_failed';
    try {
      await ghPutFile('data/cards.json', JSON.stringify(data, null, 2) + '\n', 'Substack publish result (Tasker) for card ' + card.id, ghFile.sha);
    } catch (e2) { /* if even the write-back fails, the alert below is all we get */ }
    report('Substack publish FAILED for "' + card.title + '":\n\n' + err.message);
  }
})();
