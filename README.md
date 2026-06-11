# School Management System — MCP + Agentic AI

A secure, full-stack School Management System built with a **Model Context Protocol (MCP)** architecture, a multi-layer **ReBAC security pipeline**, and a local **Ollama LLM** for natural language database interactions.

---

## ✨ Key Features

- 🤖 **Agentic AI Chat** — Natural language interface backed by a tool-calling LLM loop
- 🔐 **6-Layer Security Architecture** — Gateway secrets → JWT → Tool whitelists → Role guards → ReBAC pipeline → MongoDB user privileges
- 🗄️ **Database-Level Security** — Dedicated MongoDB users per role with collection-level least-privilege grants
- 🌍 **Multi-Environment** — Separate staging and production databases with environment-specific privilege policies
- 🧪 **20 Automated Security Tests** — Programmatic integration suite verifying all ReBAC boundaries

---

## 🏛️ Architecture

```
┌─────────────────────┐
│   React Frontend    │  Vite + React, glassmorphic UI
│   (port 5173)       │  Role-aware dashboards (Admin/Teacher/Student)
└────────┬────────────┘
         │ HTTP
┌────────▼────────────┐
│  Express Gateway    │  MCP Client — spawns MCP server as subprocess
│  (port 3000)        │  Manages JWT auth, agentic Ollama loop, tool whitelists
└────────┬────────────┘
         │ stdio (MCP protocol)
┌────────▼────────────┐
│  TypeScript MCP     │  MCP Server — registers tools, runs security pipeline
│  Server             │  Gateway secret check → JWT verify → requireRole() guard
└────────┬────────────┘
         │ authenticated per-role connection
┌────────▼────────────┐
│  MongoDB            │  Docker containers
│  Staging  :27117    │  app_student / app_teacher / app_admin users
│  Production :27118  │  Custom roles with collection-level privileges
└─────────────────────┘
```

---

## 🔐 Security Architecture

The system implements **6 independent enforcement layers**, each acting as a standalone barrier:

| Layer | Location | What it does |
|---|---|---|
| **1. Gateway Secret** | MCP Server startup | Ephemeral `randomUUID()` shared between gateway and subprocess — blocks any direct MCP client |
| **2. JWT Verification** | Every tool call | Role and identity extracted and verified from signed token |
| **3. Tool Whitelist** | Ollama service | LLM only receives tools valid for the user's role — cannot call what it cannot see |
| **4. `requireRole()` Guard** | Every tool handler | Server-level hard block before any DB access |
| **5. ReBAC Pipeline** | `security/pipeline.ts` | Relationship-based access: teachers only see their classes, students only see their own marks |
| **6. MongoDB User Privileges** | Database level | `app_student`, `app_teacher`, `app_admin` users with collection-level grants; **production admin cannot delete classes at DB level** |

---

## 🌍 Environment Policies

| Capability | Staging | Production |
|---|---|---|
| Delete classes | ✅ allowed | ❌ blocked at DB level |
| Destructive pipeline commands | ✅ allowed | ❌ blocked |
| JWT expiry | 24h | 2h |
| Sanitation / Firewall / ReBAC | ✅ | ✅ |

---

## 🚀 Setup & Installation

### Prerequisites
- Node.js 18+
- Docker Desktop
- An Ollama instance (local or via Google Colab + Ngrok — see below)

### Step 1: Clone & Install Dependencies
```bash
git clone <repo-url>
cd school-mcp
npm install
cd client && npm install && cd ..
```

### Step 2: Configure Environments
```bash
cp environments.example.yaml environments.yaml
```
Edit `environments.yaml` and fill in your passwords, JWT secrets, and Ollama endpoint.

### Step 3: Start Databases
```bash
docker compose up -d
```

### Step 4: Set Up Database Auth (run once)
This creates role-scoped MongoDB users before auth is enabled:
```bash
node scripts/setup-db-auth.cjs
```

### Step 5: Seed Staging Data
```bash
npm run build:server
npm run seed
```

### Step 6: Run Security Tests
```bash
npm run verify
```
All 20 assertions must pass. ✅

### Step 7: Start the Gateway
```bash
npm run start:gateway
```

### Step 8: Start the Frontend
```bash
cd client && npm run dev
```
Open `http://localhost:5173`

---

## 🧠 LLM Setup — Google Colab + Ngrok (Recommended)

Running an 8B model locally on CPU takes 30–90 seconds per response. For fast inference, offload to a free Colab GPU:

**In Google Colab (GPU runtime):**
```python
# Install and start Ollama
import os, subprocess, time
os.environ['OLLAMA_HOST'] = '0.0.0.0'
subprocess.Popen(["ollama", "serve"])
time.sleep(3)
```
```bash
!curl -fsSL https://ollama.com/install.sh | sh
!ollama pull llama3.1:8b
```
```python
# Expose via Ngrok
!pip install pyngrok
from pyngrok import ngrok
ngrok.set_auth_token("YOUR_NGROK_TOKEN")
tunnel = ngrok.connect(11434, "http")
print("Endpoint:", tunnel.public_url)
```

Then set `ollama.endpoint` in your `environments.yaml` to the Ngrok URL.

---

## 🧪 Test Credentials (Staging)

| Role | Email | Password |
|---|---|---|
| Admin | `admin@school.edu` | `admin123` |
| Teacher | `teacher.alice@school.edu` | `teacher123` |
| Student | `student.charlie@school.edu` | `student123` |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Vanilla CSS |
| Gateway | Node.js, Express, TypeScript |
| AI Orchestration | Ollama (Llama 3.1 8B / Qwen 2.5 14B) |
| Protocol | Model Context Protocol (MCP) over stdio |
| Database | MongoDB (Docker), Mongoose-free native driver |
| Auth | JWT (jsonwebtoken), bcrypt |
| Security | Custom ReBAC pipeline, MongoDB custom roles |
| Dev Tools | TypeScript, tsx, ESModules |
