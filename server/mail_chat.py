# mail_chat.py
# Imported by resume_server.py — do not run standalone.
# Handles: mail generate, tone+subject check, send with attachment, chat bot.
# All persistence is via db.py (MongoDB + Redis). No local JSON files.

import json, re, smtplib, base64, os
from datetime  import datetime, timezone
from groq      import Groq, RateLimitError

from email.mime.multipart import MIMEMultipart
from email.mime.text      import MIMEText
from email.mime.base      import MIMEBase
from email                import encoders

from fastapi  import HTTPException
from pydantic import BaseModel

import db
from key_vault import decrypt_client_groq_key
import logging

logger = logging.getLogger(__name__)


# ── Pydantic models ───────────────────────────────────────────────────────────

class MailGenRequest(BaseModel):
    sentinel_x:      str
    hr_name:         str
    hr_email:        str
    job_title:       str
    company:         str
    job_id:         str = ""
    job_description: str = ""

class JobDescriptionRequest(BaseModel):
    sentinel_x:          str
    raw_job_description: str

class ToneCheckRequest(BaseModel):
    sentinel_x: str
    subject:    str
    body:       str
    hr_name:    str
    job_title:  str
    company:    str

class MailRequest(BaseModel):
    sentinel_x:              str
    gmail_address:           str
    encrypted_app_password:  str          # AES-GCM-CBC-XOR encrypted blob from client crypto.js
    app_password:            str = ""     # kept for schema compat, always empty from new clients
    hr_email:                str
    hr_name:                 str
    subject:                 str
    body:                    str
    job_title:               str
    company:                 str
    custom_file_b64:         str = ""
    custom_file_name:        str = ""

class ChatRequest(BaseModel):
    sentinel_x:  str
    message:     str
    job_queue:   list = []
    hr_contacts: list = []

class SentinelRequest(BaseModel):
    sentinel_x: str

# ── Groq LLM helpers ──────────────────────────────────────────────────────────

SERVER_GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

def groq_client(key: str = None):
    """
    Return a Groq client.
    Uses *key* (from a validated client JWT) when provided;
    falls back to the server's GROQ_API_KEY environment variable.
    """
    api_key = key or SERVER_GROQ_API_KEY
    if not api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not set.")
    try:
        return Groq(api_key=api_key)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to initialize Groq client: {e}")

import time

FAST_MODEL  = "llama-3.1-8b-instant"      # mail generate, tone check, mail details, chat
SMART_MODEL = "llama-3.3-70b-versatile"   # resume parse, job analyse only

def llm(system: str, user: str, max_tokens: int = 1000, groq_key: str = None, model: str = None) -> str:
    """
    Call the LLM with automatic retry on 429 (up to 3 attempts, exponential backoff).
    Pass *groq_key* to use the client's own Groq key; omit to use the server default.
    Pass *model* to override the default FAST_MODEL.
    """
    chosen_model = model or FAST_MODEL
    for attempt in range(3):
        try:
            client = groq_client(groq_key)
            res = client.chat.completions.create(
                model=chosen_model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user}
                ]
            )
            return res.choices[0].message.content.strip()

        except RateLimitError:
            if attempt == 2:
                raise HTTPException(status_code=429, detail="Groq rate limit reached. Wait a moment and try again.")
            wait = 2 ** attempt   # 1s, 2s
            time.sleep(wait)

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"An error occurred: {e}")


# ── JSON helpers ──────────────────────────────────────────────────────────────

def _fix_control_chars(s: str) -> str:
    """
    Walk a JSON string char-by-char and escape any bare control characters
    (\\n \\r \\t) that appear inside string values without being escaped.
    Preserves already-escaped sequences (e.g. \\\\n stays \\\\n).
    """
    out       = []
    in_string = False
    i         = 0
    while i < len(s):
        c = s[i]

        # Already-escaped sequence — copy both chars verbatim
        if c == '\\' and in_string:
            out.append(c)
            if i + 1 < len(s):
                out.append(s[i + 1])
                i += 2
            continue

        if c == '"':
            in_string = not in_string
            out.append(c)
        elif in_string and c == '\n':
            out.append('\\n')
        elif in_string and c == '\r':
            out.append('\\r')
        elif in_string and c == '\t':
            out.append('\\t')
        else:
            out.append(c)
        i += 1

    return ''.join(out)


def _repair_truncated_json(s: str) -> dict | None:
    """
    Close a truncated JSON object produced when the LLM ran out of max_tokens.

    Why this is needed:
      Groq cuts the stream exactly at max_tokens — sometimes mid-word, mid-string,
      or mid-object.  The result has no closing brace, so every regex-based
      approach (re.search(r'\\{[\\s\\S]*\\}')) finds no match and hard-fails.

    Strategy:
      Walk the string tracking in_string / escape / brace-depth state, stripping
      bare structural newlines (outside strings) as we go.  We do NOT re-escape
      already-escaped \\n sequences — that double-escaping was the subtle failure
      mode in earlier repair attempts.  Append the minimum closing tokens needed:
      a quote if mid-string, then closing braces equal to open depth.

    Returns the parsed dict on success, or None if repair is not possible.
    """
    s = s.rstrip()

    in_str   = False
    escape   = False
    depth    = 0
    rebuilt  = []

    for ch in s:
        if escape:
            escape = False
            rebuilt.append(ch)
            continue
        if ch == '\\' and in_str:
            escape = True
            rebuilt.append(ch)
            continue
        if ch == '"':
            in_str = not in_str
            rebuilt.append(ch)
            continue
        # Bare newline outside a string is structural whitespace — drop it
        # so json.loads does not choke on it during repair
        if not in_str and ch == '\n':
            continue
        rebuilt.append(ch)
        if not in_str:
            if   ch == '{': depth += 1
            elif ch == '}': depth -= 1

    repaired = ''.join(rebuilt)
    suffix   = '"' if in_str else ''
    suffix  += '}' * max(depth, 0)

    for candidate in (
        repaired + suffix,
        re.sub(r',\s*}', '}', repaired + suffix),   # also strip trailing commas
    ):
        try:
            result = json.loads(candidate)
            logger.info("safe_json | truncation repaired | appended=%r", suffix)
            return result
        except json.JSONDecodeError:
            pass

    return None


def safe_json(raw: str) -> dict:
    """
    Robustly extract and parse a JSON object from raw LLM output.

    Five strategies attempted in order — stops at the first success:

      1. Strip markdown fences → direct json.loads
         Fastest path; works for well-formed LLM output.

      2. Bracket-counting {…} extractor → direct json.loads
         Handles leading/trailing prose the model sometimes adds.
         Uses a char-by-char scan (not a greedy regex) so nested objects
         are handled correctly AND truncated output falls through to repair
         instead of being silently rejected.

         KEY DIFFERENCE from the previous version:
           Old code used  re.search(r'\\{[\\s\\S]*\\}', clean)
           This regex requires a closing } to match — truncated output has
           none, so it returned None and raised 500 immediately.
           The new bracket-counter falls through to Step 4 instead.

      3. _fix_control_chars + trailing-comma strip → json.loads
         Escapes bare \\n/\\r/\\t inside string values, then retries.
         Covers well-formed but poorly escaped LLM output.

      4. _repair_truncated_json  ← fixes the reported bug
         Model ran out of max_tokens mid-string.  Reconstructs the minimum
         valid JSON by appending the missing closing quote / braces.
         This is the exact failure behind:
           "safe_json | no JSON object found in output | clean='{ ... which I a'"

      5. Single-quote → double-quote swap (last resort for small models).
    """
    logger.debug(
        "safe_json called | raw length=%d | preview=%r",
        len(raw) if raw else 0,
        (raw or "")[:200],
    )

    # Guard: empty response
    if not raw or not raw.strip():
        logger.error("safe_json | LLM returned empty response")
        raise HTTPException(
            status_code=500,
            detail="AI returned an empty response. Please try again.",
        )

    # ── Step 0: strip markdown fences ────────────────────────────────────────
    clean = re.sub(r"```(?:json)?\s*", "", raw).replace("```", "").strip()
    logger.debug("safe_json | after fence strip | length=%d", len(clean))

    # ── Step 1: direct parse ──────────────────────────────────────────────────
    try:
        result = json.loads(clean)
        logger.info("safe_json | direct parse succeeded | keys=%s", list(result.keys()))
        return result
    except json.JSONDecodeError:
        pass

    # ── Step 2: bracket-counting {…} extractor ────────────────────────────────
    obj_start = clean.find('{')
    if obj_start != -1:
        depth, in_str, escape = 0, False, False
        for i, ch in enumerate(clean[obj_start:], start=obj_start):
            if escape:
                escape = False
                continue
            if ch == '\\' and in_str:
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if not in_str:
                if   ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        candidate = clean[obj_start: i + 1]
                        try:
                            result = json.loads(candidate)
                            logger.info(
                                "safe_json | extracted block parsed | keys=%s",
                                list(result.keys()),
                            )
                            return result
                        except json.JSONDecodeError as e:
                            logger.warning(
                                "safe_json | extracted block parse failed | error=%s | pos=%d",
                                e.msg, e.pos,
                            )
                        break   # complete block found but invalid — fall through

        # If we exit the loop with depth > 0, the block was never closed
        # (truncated). Fall through to repair — do NOT raise here.

    # ── Step 3: fix control characters + trailing commas then retry ───────────
    logger.debug("safe_json | attempting control character fix")
    fixed = _fix_control_chars(clean)
    fixed = re.sub(r',\s*([}\]])', r'\1', fixed)
    logger.debug("safe_json | control char + trailing-comma fix done | length=%d", len(fixed))

    try:
        result = json.loads(fixed)
        logger.info(
            "safe_json | parse succeeded after control-char fix | keys=%s",
            list(result.keys()),
        )
        return result
    except json.JSONDecodeError as e:
        logger.warning(
            "safe_json | control-char fix parse failed | error=%s | pos=%d | snippet=%r",
            e.msg, e.pos, fixed[max(0, e.pos - 40): e.pos + 40],
        )

    # ── Step 4: truncation repair ─────────────────────────────────────────────
    logger.debug("safe_json | attempting truncation repair")
    truncated_block = clean[clean.find('{'): ] if '{' in clean else clean
    repaired = _repair_truncated_json(truncated_block)
    if repaired is not None:
        return repaired

    logger.warning("safe_json | truncation repair failed, trying last resort")

    # ── Step 5: single-quote → double-quote (last resort) ────────────────────
    try:
        result = json.loads(re.sub(r"(?<!\\)'", '"', clean))
        logger.info("safe_json | single-quote fix succeeded | keys=%s", list(result.keys()))
        return result
    except json.JSONDecodeError:
        pass

    # ── All strategies exhausted ──────────────────────────────────────────────
    preview = clean[:300].replace('\n', '\\n')
    logger.error("safe_json | all strategies exhausted | clean=%r", preview)
    raise HTTPException(
        status_code=500,
        detail=(
            "The AI returned an incomplete response — likely because the email body was too long. "
            "Please try again; it usually succeeds on the next attempt."
        ),
    )


# ── Resume context builder ────────────────────────────────────────────────────

def _require_resume(sentinel_x: str) -> dict:
    """Fetch resume from DB or raise 400."""
    result = db.get_resume(sentinel_x)
    if not result["resume_present"]:
        raise HTTPException(status_code=400, detail="No resume found. Upload your resume first.")
    return result["resume"]

def build_candidate_context(resume: dict) -> dict:
    bi       = resume.get("basic_info", {})
    exp      = resume.get("experience", [])
    edu      = resume.get("education", [])
    skills   = resume.get("skills", {})
    certs    = resume.get("professional_certifications", [])
    projects = resume.get("projects", [])

    exp_lines = []
    for e in exp[:4]:
        dur  = f"{e.get('start_date','')} to {'Present' if e.get('current') else e.get('end_date','')}"
        resp = "; ".join(e.get("responsibilities", [])[:2])
        exp_lines.append(f"  - {e.get('title','')} at {e.get('company','')} ({dur}). {resp}")

    cert_lines = [
        f"  - {c.get('name','')} issued by {c.get('issuer','')} ({c.get('year','')})"
        for c in certs[:5]
    ]
    edu_lines = [
        f"  - {e.get('degree','')} in {e.get('field','')} from {e.get('institution','')} ({e.get('end_date','')})"
        for e in edu[:2]
    ]
    proj_lines = [
        f"  - {p.get('name','')}: {p.get('description','')[:100]}. Stack: {', '.join(p.get('tech_stack',[]))}"
        for p in projects[:3]
    ]

    return {
        "name":     bi.get("name", "Candidate"),
        "email":    bi.get("email", ""),
        "phone":    bi.get("phone", ""),
        "location": bi.get("location", ""),
        "linkedin": bi.get("linkedin", ""),
        "exp":      "\n".join(exp_lines)  or "  - Not specified",
        "tech":     ", ".join(skills.get("technical", [])),
        "soft":     ", ".join(skills.get("soft", [])),
        "tools":    ", ".join(skills.get("tools", [])),
        "langs":    ", ".join(skills.get("languages", [])),
        "certs":    "\n".join(cert_lines) or "  - None listed",
        "edu":      "\n".join(edu_lines)  or "  - Not specified",
        "projects": "\n".join(proj_lines) or "  - None listed",
    }

# ── /mail/generate ────────────────────────────────────────────────────────────

def handle_mail_generate(req: MailGenRequest, groq_key: str = None) -> dict:
    resume = _require_resume(req.sentinel_x)
    c      = build_candidate_context(resume)

    jd_block = ""
    if req.job_description.strip():
        jd_block = (
            "\nJOB DESCRIPTION — reference at least one specific requirement or goal "
            "from this in Part 1 and Part 3:\n"
            + req.job_description[:2500] + "\n"
        )

    exp_list   = resume.get("experience", [{}])
    cert_list  = resume.get("professional_certifications", [{}])
    proj_list  = resume.get("projects", [{}])
    skill_list = resume.get("skills", {}).get("technical", ["your primary skill"])

    ex_role      = exp_list[0].get("title",    "Engineer")           if exp_list  else "Engineer"
    ex_company   = exp_list[0].get("company",  "previous company")   if exp_list  else "previous company"
    ex_resp      = ((exp_list[0].get("responsibilities") or []) + ["delivered key projects"])[0] if exp_list else "delivered key projects"
    ex_cert      = cert_list[0].get("name",    "relevant certification") if cert_list else "relevant certification"
    ex_proj_name = proj_list[0].get("name",    "a key project")      if proj_list else "a key project"
    ex_proj_tech = ", ".join((proj_list[0].get("tech_stack") or ["relevant stack"])[:3]) if proj_list else "relevant stack"
    ex_skill     = skill_list[0] if skill_list else "your core skill"

    system = (
        f"You are writing a job application email on behalf of {c['name']}.\n\n"
        f"do not exceed 200 words. Be concise, specific, and direct. Avoid fluff, filler phrases, and generic statements.\n\n"
        f"This email will be sent directly to {req.hr_name} at {req.company} for the role of {req.job_title}.\n"
        f"Write it as if you are {c['name']} — first person, real, human, specific.\n\n"
        "WHAT MAKES A GOOD EMAIL:\n"
        "The reader is an HR professional who reads 100 emails a day.\n"
        "They will delete anything that sounds templated, desperate, or vague.\n"
        "The only emails they read fully are ones that immediately tell them something specific and relevant.\n\n"
        "DO NOT write any of these — they trigger instant deletion:\n"
        '- "I hope this email finds you well"\n'
        '- "I am writing to express my interest"\n'
        '- "I am passionate about"\n'
        '- "Please find attached"\n'
        '- "feel free to" / "kindly" / "as per"\n'
        '- "I wanted to reach out"\n'
        '- "strong experience in X" — say what you did with X instead\n'
        "- Any exclamation mark\n"
        "- Any bullet point or list\n\n"
        "WRITE EXACTLY THIS STRUCTURE — 4 parts, blank line between each:\n\n"
        f"Start with \"Dear {req.hr_name.split()[0].capitalize()},\" and capitalizing its first letter. If hr_name is not available, use a generic greeting such as \"Dear Hiring Manager,\" or \"Dear Hiring Team,\""
        "next line is blank, then the rest of the email\n\n"
        "Part 1 — Opening (2 sentences max):\n"
        "  Who you are + your current/last role + ONE specific reason this company or role caught your attention.\n"
        f"  The reason must come from the job description or something real about {req.company} — not generic praise.\n"
        f'  BAD:  "I have always been passionate about technology."\n'
        f'  GOOD: "I\'m currently working as a {ex_role} at {ex_company}, where I\'ve been building and working on systems similar to what this role requires, which is why this opportunity at {req.company} stood out to me."'
        "above one is example and you can rephrase it according to the candidate profile"
        f' — add 2 more lines if require showing interest'
        "Part 2 — Proof (3 sentences max):\n"
        "  Pick the 4- skills or certifications from the profile that best match this specific job.\n"
        "  For each one, name what you actually built, delivered, or earned — not how good you are at it.\n"
        f'  BAD:  "I have strong skills in {ex_skill} and related technologies."\n'
        f'  GOOD: "At {ex_company}, {ex_resp}. I hold {ex_cert}, which I applied directly to [relevant area'
        f' for {req.job_title}]. In {ex_proj_name}, I used {ex_proj_tech} to [specific outcome relevant to this role]."\n\n'
        "Part 3 — Close (2 sentences):\n"
        "  One sentence connecting your background to a specific challenge or goal mentioned in the JD.\n"
        "  One sentence saying you are available for a call and that your resume is attached.\n"
        f'  BAD:  "I look forward to hearing from you."\n'
        f'  GOOD: "I would welcome a conversation about how my work in {ex_skill} could support {req.company}\'s'
        f' [specific goal from JD]. My resume is attached and I am available for a call at your convenience."\n\n'
        "Sign-off — no blank lines between lines:\n"
        "explain my projects along with technologies used and mention those only which are required in JD not mention"
        
        "Regards,\n"
        f"{c['name']}\n"
        f"{c['email']}\n"
        f"{c['phone']}\n"

        "RULES:\n"
        "- Use only facts from the candidate profile below. Never invent a skill, project, or achievement.\n"
        "- If job description is provided, reference at least one specific requirement or goal from it.\n"
        "- Word count: 150-200 words for parts 1-3 only.\n"
        "- No markdown, no headers, no labels like 'Part 1:' in the final output.\n\n"
        "OUTPUT:\n"
        "Return only a raw JSON object with exactly two keys: \"subject\" and \"body\".\n"
        f"Subject format: Application for {req.job_title}"
        f"{f' (Job ID: {req.job_id})' if req.job_id else ''}"
        f" at {req.company} — {c['name']}\n"
        "body: use \\n\\n between paragraphs. Sign-off lines separated by \\n.\n"
        "No backticks. No markdown. No extra keys.\n\n"
        "CANDIDATE PROFILE:\n"
        f"Name:     {c['name']}\n"
        f"Email:    {c['email']}\n"
        f"Phone:    {c['phone']}\n"
        f"Location: {c['location']}\n"
        f"LinkedIn: {c['linkedin']}\n\n"
        f"Work Experience:\n{c['exp']}\n\n"
        f"Technical Skills:  {c['tech']}\n"
        f"Tools:             {c['tools']}\n"
        f"Soft Skills:       {c['soft']}\n"
        f"Languages:         {c['langs']}\n\n"
        f"Certifications:\n{c['certs']}\n\n"
        f"Education:\n{c['edu']}\n\n"
        f"Key Projects:\n{c['projects']}\n"
        + jd_block
    )

    user = (
        f"Write the email now.\n"
        f"HR Name:   {req.hr_name}\n"
        f"Job Title: {req.job_title}\n"
        f"Company:   {req.company}\n\n"
        f"Job Id:     {req.job_id}\n\n"
        "Use only facts from the candidate profile. Do not invent any experience, skill, or achievement not listed above."
    )

    raw    = llm(system, user, max_tokens=2000, groq_key=groq_key)
    result = safe_json(raw)

    body = result.get("body", "")
    body = body.replace("\\n\\n", "\n\n").replace("\\n", "\n")
    for sign in ["Regards,", "Sincerely,", "Warm regards,"]:
        if sign in body:
            idx    = body.index(sign)
            before = body[:idx].rstrip("\n")
            after  = body[idx:]
            body   = before + "\n\n" + after
            break
    while "\n\n\n" in body:
        body = body.replace("\n\n\n", "\n\n")
    result["body"] = body.strip()

    logger.info("handle_mail_generate | done | subject=%r", result.get("subject", ""))
    return result

# ── /mail/details ─────────────────────────────────────────────────────────────

def handle_mail_details(req: JobDescriptionRequest, groq_key: str = None) -> dict:
    system = """
You are a professional assistant that extracts key details from a job description for email generation.
Extract the following fields and return ONLY a valid JSON object with these exact keys (no markdown, no backticks):

{
    "job_description": string,
    "hr_name": string if mentioned, else "Hiring Manager",
    "email": string,
    "job_title": string,
    "job_id": string if mentioned, else "",
    "company": string
}

Instructions:
1. Include all technical skills, tools, certifications, years of experience, and role requirements in job_description.
2. Only fill hr_name and email if explicitly mentioned; otherwise use "Hiring Manager" / "".
3. Strict JSON only.
"""
    return safe_json(llm(system, req.raw_job_description, groq_key=groq_key))

# ── /mail/tone-check ──────────────────────────────────────────────────────────

def handle_tone_check(req: ToneCheckRequest, groq_key: str = None) -> dict:
    system = """You are a strict professional email reviewer for job applications.
Analyse the email and return ONLY a valid JSON object with these exact keys (no markdown, no backticks):
{
  "tone_ok": true or false,
  "subject_ok": true or false,
  "has_abuse": true or false,
  "has_harsh_words": true or false,
  "has_filler_phrases": true or false,
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestions": ["specific fix 1", "specific fix 2"],
  "overall": "approved | needs_revision | rejected"
}"""

    user = (
        f"HR Name: {req.hr_name}\n"
        f"Job Title: {req.job_title}\n"
        f"Company: {req.company}\n\n"
        f"SUBJECT: {req.subject}\n\n"
        f"BODY: {req.body}"
    )
    response = llm(system, user, max_tokens=600, groq_key=groq_key)
    return safe_json(response)

# ── /mail/send ────────────────────────────────────────────────────────────────

def handle_mail_send(req: MailRequest) -> dict:
    # ── Decrypt app_password server-side ─────────────────────────────────────
    # Client sends an AES-GCM/CBC/XOR encrypted blob produced by crypto.js.
    # The server's decrypt_field uses SERVER_SECRET + ENCRYPTION_PEPPER (env vars)
    # to derive the same key and recover the plaintext.
    # Plaintext app_password is only ever held in this local variable — never
    # logged, never stored, discarded immediately after SMTP login.
    try:
        app_password = decrypt_client_groq_key(
            req.encrypted_app_password,
            req.sentinel_x
        )
        if not app_password:
            raise ValueError("Decryption returned empty")
    except Exception as e:
        raise HTTPException(
            status_code=401,
            detail="Failed to decrypt app password. Re-enter your App Password and try again."
        )

    msg = MIMEMultipart("mixed")
    msg["From"]    = req.gmail_address
    msg["To"]      = req.hr_email
    msg["Subject"] = req.subject

    plain_body = req.body.replace("\\n\\n", "\n\n").replace("\\n", "\n")

    paragraphs = [p.strip() for p in plain_body.split("\n\n") if p.strip()]
    html_parts = []
    for p in paragraphs:
        lines = p.split("\n")
        if any(x in p for x in ["Regards,", "Sincerely,", "Warm regards,"]):
            html_parts.append(
                "<p style='margin:20px 0 0 0;line-height:1.8;font-family:Arial,sans-serif;font-size:14px;color:#222'>"
                + "<br>".join(lines) + "</p>"
            )
        else:
            html_parts.append(
                "<p style='margin:0 0 16px 0;line-height:1.7;font-family:Arial,sans-serif;font-size:14px;color:#222'>"
                + "<br>".join(lines) + "</p>"
            )

    html_body = (
        "<html><body style='max-width:600px;padding:24px;background:#fff'>"
        + "".join(html_parts)
        + "</body></html>"
    )

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(plain_body, "plain", "utf-8"))
    # alt.attach(MIMEText(html_body,  "html",  "utf-8"))
    msg.attach(alt)

    # ── Attach file (user provides locally — not stored server-side) ──────────
    if not (req.custom_file_b64 and req.custom_file_name):
        raise HTTPException(
            status_code=400,
            detail="No file provided. Attach your resume file directly when sending."
        )
    try:
        file_bytes = base64.b64decode(req.custom_file_b64)
        part = MIMEBase("application", "octet-stream")
        part.set_payload(file_bytes)
        encoders.encode_base64(part)
        part.add_header(
            "Content-Disposition",
            f'attachment; filename="{req.custom_file_name.replace(chr(34), "")}"'
        )
        msg.attach(part)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid file: {e}")

    # ── Send ──────────────────────────────────────────────────────────────────
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(req.gmail_address, app_password)
            server.sendmail(req.gmail_address, req.hr_email, msg.as_string())
        # Explicitly clear plaintext from memory
        app_password = None
    except smtplib.SMTPAuthenticationError:
        raise HTTPException(
            status_code=401,
            detail="Gmail authentication failed. Ensure 2-Step Verification is ON and you are using an App Password."
        )
    except smtplib.SMTPException as e:
        raise HTTPException(status_code=500, detail=f"SMTP error: {e}")

    # Log to MongoDB
    db.append_hr_log(req.sentinel_x, {
        "hr_name":   req.hr_name,
        "hr_email":  req.hr_email,
        "job_title": req.job_title,
        "company":   req.company,
        "subject":   req.subject,
        "sent_at":   datetime.now(timezone.utc).isoformat()
    })

    return {"status": "sent", "to": req.hr_email, "subject": req.subject}

# ── /mail/hr_log ──────────────────────────────────────────────────────────────

def handle_hr_log(sentinel_x: str) -> list:
    return db.get_hr_log(sentinel_x)

# ── /chat ─────────────────────────────────────────────────────────────────────

def handle_chat(req: ChatRequest, groq_key: str = None) -> dict:
    resume  = db.get_resume(req.sentinel_x).get("resume") or {}
    hr_log  = db.get_hr_log(req.sentinel_x)
    history = db.get_chat_history(req.sentinel_x)

    job_lines = [
        f"  - {j.get('jobData',{}).get('title','')} at {j.get('jobData',{}).get('company','')} "
        f"| Fit: {j.get('aiResult',{}).get('fit_score','?')}/10 | Status: {j.get('status','')}"
        for j in req.job_queue[:10]
    ]
    hr_lines = [
        f"  - {h.get('hr_name','')} <{h.get('hr_email','')}> at {h.get('company','')} "
        f"for '{h.get('job_title','')}' on {h.get('sent_at','')[:10]}"
        for h in hr_log[:10]
    ]

    c = build_candidate_context(resume) if resume else {}

    system = (
    f"You are a smart, practical job search assistant inside a browser extension. "
    f"You help the candidate with ANYTHING related to their job search — cover letters, interview prep, "
    f"salary negotiation, recruiter questions, LinkedIn messages, and more.\n\n"
    f"IMPORTANT RULES:\n"
    f"- Always respond in FIRST PERSON as the candidate (e.g. 'I have 5 years of experience...')\n"
    f"- If asked to write a cover letter or answer a recruiter question, DO IT — even if the role isn't in the scanned jobs list\n"
    f"- For recruiter/HR questions (e.g. 'What's your expected salary?'), answer naturally as the candidate would\n"
    f"- Be concise and direct. Use bullet points when listing. Keep answers under 150 words unless more is needed.\n\n"
    f"CANDIDATE PROFILE:\n"
    f"Name: {c.get('name', 'N/A')}\n"
    f"Skills: {c.get('tech', 'N/A')}\n"
    f"Certifications: {', '.join([x.get('name', '') for x in resume.get('professional_certifications', [])[:3]]) or 'None'}\n\n"
    f"SCANNED JOBS (for reference):\n{chr(10).join(job_lines) or '  None yet'}\n\n"
    f"HR EMAILS SENT (for reference):\n{chr(10).join(hr_lines) or '  None yet'}"
)

    history.append({"role": "user", "content": req.message})
    messages = [{"role": "system", "content": system}] + history[-20:]

    for attempt in range(3):
        try:
            client = groq_client(groq_key)
            res = client.chat.completions.create(
                model=FAST_MODEL,
                max_tokens=400,
                messages=messages
            )
            break
        except RateLimitError:
            if attempt == 2:
                raise HTTPException(status_code=429, detail="Rate limit reached. Wait a moment and try again.")
            time.sleep(2 ** attempt)
    reply = res.choices[0].message.content.strip()
    history.append({"role": "assistant", "content": reply})

    db.save_chat_history(req.sentinel_x, history)

    return {"reply": reply, "history_length": len(history)}

# ── /chat/history ─────────────────────────────────────────────────────────────

def handle_chat_history(sentinel_x: str) -> dict:
    history = db.get_chat_history(sentinel_x)
    return {"history": history}

# ── /chat/clear ───────────────────────────────────────────────────────────────

def handle_chat_clear(sentinel_x: str) -> dict:
    db.clear_chat_history(sentinel_x)
    return {"status": "cleared"}