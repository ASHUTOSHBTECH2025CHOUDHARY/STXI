<div align="center">

```
███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗     ██╗  ██╗
██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║     ╚██╗██╔╝
███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║      ╚███╔╝ 
╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║      ██╔██╗ 
███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗██╔╝ ██╗
╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚═╝  ╚═╝
```

### *Your AI-Powered Job Application Co-Pilot*

---

![Status](https://img.shields.io/badge/status-active-brightgreen?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0078D7?style=for-the-badge&logo=microsoftedge)
![Backend](https://img.shields.io/badge/backend-FastAPI-009688?style=for-the-badge&logo=fastapi)
![AI](https://img.shields.io/badge/AI-Groq%20%2B%20LLaMA-FF6B35?style=for-the-badge)
![Python](https://img.shields.io/badge/python-3.10%2B-3776AB?style=for-the-badge&logo=python)

</div>

---

## ◈ What is SentinelX?

> **SentinelX** is a browser extension + AI backend that sits alongside you while you job hunt.
> It reads the page you are on, understands the role, compares it against *your actual resume*,
> and produces match scores, cover letters, and recruiter emails — all grounded in your real experience.
> Nothing is hallucinated. Nothing is generic. Every output traces directly back to what you have actually done.

---

## ◈ What Does It Cache & Store?

SentinelX stores the following data **locally in your browser** (`chrome.storage.local`) and **on the backend (Redis + MongoDB)**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LOCAL STORAGE (Browser)                      │
├──────────────────────┬──────────────────────────────────────────────┤
│  Key                 │  What it holds                               │
├──────────────────────┼──────────────────────────────────────────────┤
│  __sentinelX__       │  Your unique user identity hash (SHA-256)    │
│  storedResume        │  Full parsed resume JSON + original file b64 │
│  queue               │  List of analysed job tabs + AI results      │
│  appLog              │  History of applications you filled/skipped  │
│  mailDraft           │  Auto-saved mail form draft (HR, subject…)   │
│  latestJobData       │  Job fields extracted from last context-menu │
│  gmailAddress        │  Your Gmail address (app password is NEVER   │
│                      │  stored — only encrypted for transit)        │
│  serverUrl           │  Backend URL (default: Vercel deployment)    │
│  groqKey             │  Optional user-provided Groq API key         │
│  minScore            │  Minimum fit score threshold (1–10)          │
└──────────────────────┴──────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    BACKEND STORAGE (Redis + MongoDB)                │
├──────────────────────┬──────────────────────────────────────────────┤
│  gk:{sentinelX}      │  Triple-AES-encrypted Groq key (Redis, 8h)  │
│  resume:{sentinelX}  │  Structured resume JSON (MongoDB)            │
│  chat:{sentinelX}    │  Conversation history for the chat agent     │
│  hr_log:{sentinelX}  │  Record of all sent recruiter emails         │
│  identity registry   │  sentinelX → registration timestamp          │
└──────────────────────┴──────────────────────────────────────────────┘
```

> 🔐 **Security note:** Your Gmail app password is **never stored anywhere**.  
> It is encrypted client-side (AES-256-GCM → AES-256-CBC → XOR) and decrypted  
> exclusively on the server at send-time, then immediately discarded.

---

## ◈ Feature Map

```
SentinelX
│
├── 📄  Resume Tab
│       ├── Upload PDF or JSON resume
│       ├── Parsed by LLaMA 70B into structured JSON
│       │     (basic_info · skills · experience · projects · education · certs)
│       └── Stored persistently — unlocks all other tabs
│
├── 🤖  Agent Tab
│       ├── Scans all open browser tabs for job pages
│       ├── Auto-detects job platforms (LinkedIn, Naukri, Greenhouse…)
│       ├── Extracts: title · company · location · description
│       ├── Sends to /job/analyse → returns:
│       │     • Fit Score  (1–10)
│       │     • Fit Reason
│       │     • Matched Skills
│       │     • Missing Skills
│       │     • Cover Letter (editable)
│       │     • Apply Recommendation
│       └── One-click form fill on the job application page
│
├── 📬  Mail Tab
│       ├── Fill HR name, email, job title, company, JD
│       ├── AI generates personalised recruiter email
│       ├── Tone checker flags issues / abuse / improvements
│       ├── Gmail send with resume attachment (SMTP + App Password)
│       └── HR contact log — all sent emails, searchable
│
├── 💬  Chat Tab
│       ├── Context-aware job search assistant
│       ├── Knows your resume, open tabs, applications, HR contacts
│       └── Persistent conversation history via Redis
│
├── 📋  Log Tab
│       └── Full timeline of applications — applied / skipped / pending
│
└── ⚙️  Settings Tab
        ├── Backend server URL
        ├── Custom Groq API key  (or use server default)
        ├── "Use Default Key" button — clears key, falls back to backend
        └── Minimum fit score filter
```

---

## ◈ How the AI Stack Works

```
Browser Extension  ──────────────►  FastAPI Backend  ──────────────►  Groq Cloud
                                                                            │
  Job Description ──► /job/analyse                                  LLaMA 3.3 70B
  Resume JSON     ──► /resume/upload                                (smart tasks)
  Mail request    ──► /mail/generate                                    │
  Chat message    ──► /chat                                       LLaMA 3.1 8B
                                                                  (fast tasks)
                      ▼
                   Redis (key cache, chat history)
                   MongoDB (resume, hr_log, identity)
```

---

## ◈ Supported Job Platforms

| Platform         | Auto-detected | Form Fill |
|-----------------|:-------------:|:---------:|
| LinkedIn Jobs   | ✅            | ✅        |
| Indeed          | ✅            | ✅        |
| Naukri          | ✅            | ✅        |
| Glassdoor       | ✅            | ✅        |
| Greenhouse      | ✅            | ✅        |
| Workday         | ✅            | ✅        |
| Lever           | ✅            | ✅        |
| Wellfound       | ✅            | ✅        |
| Internshala     | ✅            | ✅        |
| Any `/jobs/*`   | ✅            | ⚠️ varies |

---

## ◈ Quick Start

### 1 · Run the Backend

```bash
# Install dependencies
cd .\server\
python -m pip install -r requirements.txt

# Start the server
python -m uvicorn app:app --port 8000
```

> The server defaults to `http://127.0.0.1:8000` locally.  
> A hosted instance is available at `http://sentinel-x-delta.vercel.app`

---

### 2 · Load the Extension in Microsoft Edge

```
1.  Open Edge and navigate to:   edge://extensions

2.  Toggle ON  ──►  "Developer mode"  (bottom-left corner)

3.  Click  ──►  "Load unpacked"

4.  Select the  extensions/  folder  ──►  Confirm

5.  Pin SentinelX to your toolbar for quick access
```

> **Shortcut:** `Ctrl + Shift + E`  (Mac: `Cmd + Shift + E`) to open the popup from any tab.

---

### 3 · First-Time Setup

```
┌─────────────────────────────────────────────────────┐
│  STEP 1  ──  Open the extension popup               │
│  STEP 2  ──  Go to Settings → set your server URL   │
│              (leave default for hosted version)      │
│  STEP 3  ──  Go to Resume → upload your PDF/JSON    │
│  STEP 4  ──  All tabs unlock automatically ✓        │
│  STEP 5  ──  Open a job page → Agent → Analyse      │
└─────────────────────────────────────────────────────┘
```

## ◈ Security Model

```
sentinelX (SHA-256 hash)
    │
    ├──  Never sent as a query parameter
    ├──  Sent as:  Authorization: Bearer <sentinelX>
    │              X-Sentinel-Id: <sentinelX>
    │
    ├──  If localStorage is cleared → auto-regenerated + re-registered
    │
    └──  Groq API key flow:
              User key  ──►  X-GROQ-KEY header  ──►  validated server-side
                │                                         │
                └── stored encrypted in Redis (8h TTL)    │
                                                          ▼
                                              Falls back to GROQ_API_KEY env
                                              if no user key is present
```

---

## ◈ Project Structure

```
sentinelx/
│
├── extensions/                   ← Chrome / Edge extension
│   ├── manifest.json             ← MV3 manifest
│   ├── background.js             ← Service worker — all API calls
│   ├── popup.html                ← Extension UI (460px popup)
│   ├── popup.js                  ← UI controller & tab management
│   ├── content.js                ← Page overlay / loading indicator
│   ├── sentinelX.js              ← Identity lifecycle manager
│   ├── crypto.js                 ← AES-GCM + AES-CBC + XOR encryption
│   └── icons/
│
└── server/                       ← FastAPI backend
    ├── app.py                    ← Routes & resume upload
    ├── mail_chat.py              ← Mail generate/send, chat, tone check
    ├── key_vault.py              ← Token generation & Groq key encryption
    ├── db.py                     ← MongoDB + Redis helpers
    ├── auth.py                   ← Auth utilities
    ├── crypto_utils.py           ← Server-side AES decryption
    ├── crypto_store.py           ← Encrypted field storage helpers
    └── requirements.txt
```

---

<div align="center">

*Built to give every job seeker an unfair advantage.*

</div>
