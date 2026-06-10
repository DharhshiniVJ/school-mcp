# School Management System (MCP Architecture)

A portfolio-grade, secure, local-first School Management System utilizing a Model Context Protocol (MCP) Client/Server architecture, role-based access control (ReBAC), and a local Ollama LLM.

---

## 🏛️ Architecture Overview

The system is built on a 3-tier decoupled architecture and implements **both the MCP Client and MCP Server** locally:

1. **Frontend (Vite + React)**: A premium, dark slate-blue glassmorphic user interface. It manages separate dashboard views and AI chats for Admins, Teachers, and Students, automatically injecting dropdown-selected active class context into the AI session.
2. **Express API Gateway (MCP Client)**: Implements the **MCP Client** in `server/src/services/mcp.service.ts`. It spawns the MCP Server subprocess, connects via stdio, fetches tool schemas, and manages the agentic chat loop using a local Ollama model to call database tools dynamically.
3. **TypeScript MCP Server (MCP Server)**: Implements the **MCP Server** in `server/src/server.ts`. Running over stdio transport, it registers all available database/statistical tools and runs a 3-layer security pipeline (ReBAC, Query Firewall, and Production Sanitation) to validate and execute database actions on MongoDB.
4. **MongoDB Databases**: Multi-environment databases run inside Docker containers on port `27117` (Staging) and `27118` (Production).

---

## 🚀 Setup & Installation Steps

### Step 1: Spin up Databases (Docker)
Ensure Docker is running, then spin up the Staging and Production MongoDB containers from the root directory:
```powershell
docker compose up -d
```

### Step 2: Install Dependencies
Install packages for both the backend/MCP server and the client:
```powershell
# Install root/server dependencies
npm install

# Install client dependencies
cd client
npm install
cd ..
```

### Step 3: Seed the Database
Seed the staging database with initial mock users (Admin, Teachers, Students), classes, and marks:
```powershell
# Compile the typescript scripts first
npm run build:server

# Run seeder
npm run seed
```

### Step 4: Run Programmatic Security Tests
Run the integration verification suite to check that ReBAC boundaries, firewalls, and numeric mark statistics function correctly:
```powershell
npm run verify
```
*(All 20 security assertions must pass successfully!)*

### Step 5: Start the API Gateway
Launch the Gateway server on port `3000`:
```powershell
npm run start:gateway
```

### Step 6: Launch the Web UI
Open a new terminal window, navigate to the client, and start the Vite dev server:
```powershell
cd client
npm run dev
```
Open `http://localhost:5173` in your browser.

---

## 🧠 Local Model (1.5B) Challenges & Optimizations

We initially developed and tested the chat assistant using Ollama's **`qwen2.5:1.5b`** model. Because this local model is extremely lightweight (1.5B parameters), we faced major integration hurdles:

### The Issues:
* **Tool Overwhelm**: Exposing the model to all 13 database tools at once bloated the context window, causing the model to get confused, hallucinate database data, or return blank responses.
* **Conversational Preambles**: The model frequently wrote introductory remarks (e.g. *"I will now call get_class_details to find the students..."*) before outputting the actual tool call. Ollama's parser gets confused by this conversational text and returns an empty message.
* **ID Guessing**: When querying records, the model guessed parameter IDs using the user's email address or name instead of their true database ID, causing the MCP security pipeline to reject requests.
* **Parametric Hallucination**: When asked class-roster questions, the model bypassed calling the tools entirely and hallucinated fictional student lists and email addresses.

### How We Solved It in Code:
We implemented several optimizations in the API Gateway's [ollama.service.ts](server/src/services/ollama.service.ts):
1. **Role-Based Tool Filtering**: The gateway filters and exposes only the relevant subset of tools based on the user's logged-in role (3 tools for Students, 7 for Teachers, and 8 for Admins) to prevent context bloat.
2. **Few-Shot Priming**: Prepended new chat sessions with brief mock message turns demonstrating how to output tool-call JSON directly without conversational preambles.
3. **ID Injection**: Injected the user's database `userId` directly into the LLM's system prompt context.

### Recommended Upgrades:
For a truly seamless, native tool-calling experience without prompt hacks, we highly recommend upgrading:
* **Option A (Local upgrade)**: Pull a slightly larger model like **`qwen2.5:3b`** or **`llama3.1:8b`** via Ollama. They have significantly better reasoning and follow tool schemas natively.
* **Option B (Cloud upgrade)**: Switch the gateway orchestrator to use a **Gemini API Key** (e.g. Gemini 1.5 Flash). It is lightning-fast, extremely intelligent, free of cost on the developer tier, and offloads all processor load from your local machine.
