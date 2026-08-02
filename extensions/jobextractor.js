async function extractJobData(tabId) {
    console.log('[JobAgent] Extracting job data from page...');
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {

        // ── Constants ──────────────────────────────────────────────────────
        const JOB_KEYWORDS = [
          'responsibilities','requirements','qualifications','skills',
          "what you'll do","what we're looking for",'experience',
          'about the role','job description','duties',
        ];
        const SECTION_HEADERS = [
          'responsibilities',"what you'll do",'your role',
          'requirements','qualifications',"what we're looking for",
          'skills','about you','you have','you bring',
          'about the role','the position','overview',
        ];
        const NOISE_PATTERNS = [
          /^(apply now|save job|share|easy apply|report|back|sign in|log in)$/i,
          /^[\d,]+ applicants?$/i,
          /^posted \d+/i,
          /^(promoted|actively recruiting)$/i,
        ];
        const MAX_CHARS     = 3000;
        const MIN_BLOCK_LEN = 300;

        // ── Helpers ────────────────────────────────────────────────────────
        function stripHtml(html) {
          return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
            .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
            .trim();
        }

        function isVisible(el) {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' &&
                 s.visibility !== 'hidden' &&
                 s.opacity !== '0' &&
                 el.offsetHeight > 0;
        }

        function scoreBlock(el) {
          const text = (el.innerText || '').toLowerCase();
          const len  = text.length;
          if (len < MIN_BLOCK_LEN) return 0;
          const tag         = el.tagName.toLowerCase();
          const tagPenalty  = ['nav','header','footer','aside'].includes(tag) ? 0.2 : 1;
          const kwHits      = JOB_KEYWORDS.filter(k => text.includes(k)).length;
          const lengthBonus = Math.min(len, 8000) / 100;
          return (kwHits * 80 + lengthBonus) * tagPenalty;
        }

        function cleanText(raw) {
          return raw
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 2)
            .filter(l => !NOISE_PATTERNS.some(re => re.test(l)))
            .filter((l, i, arr) => l.length > 20 || (arr[i - 1] || '').length > 20)
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        function extractSections(text) {
          const lines    = text.split('\n');
          const chunks   = [];
          let capturing  = false;
          let buffer     = [];

          for (const line of lines) {
            const lower    = line.toLowerCase().trim();
            const isHeader = SECTION_HEADERS.some(
              h => lower.startsWith(h) && lower.length < h.length + 30
            );
            if (isHeader) {
              if (buffer.length) chunks.push(buffer.join('\n'));
              buffer    = [line];
              capturing = true;
              continue;
            }
            if (capturing) buffer.push(line);
          }
          if (buffer.length) chunks.push(buffer.join('\n'));

          const out = chunks.length ? chunks.join('\n\n') : text;
          return out.slice(0, MAX_CHARS).trim();
        }

        // ── Layer 1: JSON-LD ───────────────────────────────────────────────
        let ldTitle = '', ldCompany = '', ldLocation = '', ldDesc = '';
        document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          try {
            const d = JSON.parse(s.textContent);
            const j = [d].flat().find(
              x => x?.['@type'] === 'JobPosting' ||
                   (Array.isArray(x?.['@type']) && x['@type'].includes('JobPosting'))
            );
            if (j) {
              ldTitle    = j.title || '';
              ldCompany  = j.hiringOrganization?.name || '';
              ldLocation = j.jobLocation?.address?.addressLocality ||
                           j.jobLocation?.[0]?.address?.addressLocality || '';
              ldDesc     = stripHtml(j.description || '');
            }
          } catch {}
        });

        // ── Layer 2: Semantic DOM ──────────────────────────────────────────
        const h1 = document.querySelector('h1');
        const domTitle = (h1 && h1.innerText.trim().length < 120)
          ? h1.innerText.trim() : '';

        const domDesc = (() => {
          const scored = [...document.querySelectorAll('section,article,main,div')]
            .filter(isVisible)
            .map(el => ({ el, score: scoreBlock(el) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);
          return scored[0]?.el.innerText?.trim() || '';
        })();

        // ── Layer 3: Heuristic fallback ────────────────────────────────────
        const fallbackTitle = document.title.split(/[|\-–]/)[0].trim();
        const fallbackDesc  = (() => {
          if (ldDesc.length > 200 || domDesc.length > 200) return '';
          const blocks = [...document.querySelectorAll('div,section,article')]
            .filter(el => isVisible(el) && el !== document.body)
            .map(el => ({ el, len: (el.innerText || '').length }))
            .filter(({ len }) => len >= MIN_BLOCK_LEN)
            .sort((a, b) => b.len - a.len);
          return blocks[0]?.el.innerText?.trim() || document.body.innerText || '';
        })();

        // ── Merge ──────────────────────────────────────────────────────────
        const rawDesc = ldDesc.length >= domDesc.length
          ? ldDesc
          : (domDesc || fallbackDesc);

        // ── Post-process ───────────────────────────────────────────────────
        const finalDesc = extractSections(cleanText(rawDesc));

        return {
          title:       (ldTitle || domTitle || fallbackTitle || '').slice(0, 200).trim(),
          company:     (ldCompany || '').slice(0, 100).trim(),
          location:    (ldLocation || '').slice(0, 100).trim(),
          description: finalDesc,
        };
      }
    });
    const data = results?.[0]?.result ?? null;

    // Validate: no data at all
    if (!data) {
      return { error: 'Could not read page content. Make sure the job page is fully loaded and try again.' };
    }
    // Validate: description missing or too short to be useful
    if (!data.description || data.description.trim().length < 100) {
      return {
        error: 'Job description not found on this page. Please open a specific job posting (not a listings page) and try again.',
        partial: data,
      };
    }

    return data;
  } catch (e) {
    console.error('[JobAgent] extractJobData error:', e);
    return { error: 'Extraction failed: ' + e.message };
  }
}